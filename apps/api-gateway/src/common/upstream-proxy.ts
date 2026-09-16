import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';

/**
 * Upstream response headers the gateway is willing to relay.
 *
 * `x-cache` is here so a client can see whether the Product Service served
 * a request from Redis or from PostgreSQL — the same signal a CDN gives you,
 * and the only way to verify caching from outside the system.
 *
 * `idempotent-replay` says a charge returned an EXISTING payment instead of
 * making one. A retry loop needs that answer, and dropping the header at the
 * gateway would leave every client unable to tell a replay from a fresh
 * charge — turning a safety feature into a silent one.
 */
const FORWARDED_RESPONSE_HEADERS = ['x-cache', 'idempotent-replay'] as const;

/**
 * Shared forwarding and failure translation for every downstream service.
 *
 * This was inlined in AuthProxyService through Milestone 2. The Product
 * Service is the second consumer, which is the trigger for extracting it —
 * the same rule that governs `libs/contracts`. Two copies of error-mapping
 * logic drift, and the drift shows up as one service returning 503 where
 * another returns 500 for the identical failure.
 *
 * It lives in the gateway rather than in a shared library because nothing
 * outside the gateway forwards HTTP. Promoting it to `libs/` would be an
 * abstraction with one consumer.
 */
export abstract class UpstreamProxy {
  private readonly upstreamLogger: Logger;

  protected constructor(
    protected readonly http: HttpService,
    private readonly upstreamName: string,
  ) {
    this.upstreamLogger = new Logger(`${upstreamName}Proxy`);
  }

  /**
   * The distinction that matters: "the service answered, and the answer was
   * an error" versus "the service did not answer at all".
   *
   *   ANSWERED (4xx/5xx)  pass status and body through unchanged. A 409 from
   *                       a service must reach the client as a 409 —
   *                       collapsing everything to 500 leaves clients unable
   *                       to react to anything.
   *
   *   NO ANSWER           the GATEWAY describes it:
   *                         connection refused -> 503 Service Unavailable
   *                         timed out          -> 504 Gateway Timeout
   *                         anything else      -> 502 Bad Gateway
   *
   * The raw axios error names our internal host and port, so it goes to the
   * log and never to the client.
   */
  protected async forward<T>(request: AxiosRequestConfig): Promise<T> {
    return (await this.forwardWithHeaders<T>(request)).data;
  }

  /**
   * Same call, but keeps a small allow-list of the upstream's response
   * headers so the gateway can pass them on.
   *
   * An ALLOW-LIST, not a blanket copy. Forwarding every header would leak
   * the internal service's `Server`, its cookies and any bespoke debugging
   * header straight to the public — precisely the internal detail the
   * gateway exists to hide.
   */
  protected async forwardWithHeaders<T>(
    request: AxiosRequestConfig,
  ): Promise<{ data: T; headers: Record<string, string>; status: number }> {
    return this.attempt<T>(request, 0);
  }

  /**
   * One attempt, with a retry for the narrow case where a retry is safe.
   *
   * DO NOT BLINDLY RETRY. Two questions decide it, and both have to be yes:
   *
   *   IS IT SAFE TO REPEAT?  Only for methods that are IDEMPOTENT by
   *                          definition — GET and HEAD. Retrying a POST can
   *                          place a second order or take a second payment,
   *                          and the gateway has no way to know whether the
   *                          first one landed. The Payment Service solves
   *                          that for itself with an idempotency key,
   *                          because it is the only component that can.
   *
   *   COULD IT WORK NEXT TIME?  Only when there was NO RESPONSE — a refused
   *                          connection, a reset socket, a DNS blip. A
   *                          service that answered 404 will answer 404
   *                          again, and a service that answered 500 has
   *                          already done whatever it did.
   *
   * A timeout is deliberately NOT retried. It is the case where we do not
   * know whether the work happened, and repeating unknown work is how a
   * retry policy turns one slow request into three slow requests and a
   * duplicate.
   */
  private async attempt<T>(
    request: AxiosRequestConfig,
    retriesUsed: number,
  ): Promise<{ data: T; headers: Record<string, string>; status: number }> {
    try {
      const response = await firstValueFrom(this.http.request<T>(request));

      const forwarded: Record<string, string> = {};
      for (const header of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers[header];
        if (typeof value === 'string') {
          forwarded[header] = value;
        }
      }

      // The upstream's SUCCESS status, relayed as well as its body. Nest
      // answers 201 for every POST otherwise, and `POST /payments`
      // deliberately returns 200 when it replayed an existing payment.
      return {
        data: response.data,
        headers: forwarded,
        status: response.status,
      };
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response !== undefined) {
        throw new HttpException(
          axiosError.response.data as string | Record<string, unknown>,
          axiosError.response.status,
        );
      }

      if (this.shouldRetry(request, axiosError, retriesUsed)) {
        // Exponential, so a struggling service is not hammered by every
        // gateway replica in lockstep. At one retry the jitter matters less
        // than it will at five, and it is here because adding it later means
        // remembering to.
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** retriesUsed;
        const jitterMs = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);

        this.upstreamLogger.warn(
          `${this.upstreamName} ${axiosError.code ?? 'unreachable'} on ${request.method} ${request.url} — retrying in ${delayMs + jitterMs}ms`,
        );

        await sleep(delayMs + jitterMs);
        return this.attempt<T>(request, retriesUsed + 1);
      }

      this.upstreamLogger.error(
        `${this.upstreamName} unreachable: ${axiosError.code ?? 'unknown'} on ${request.method} ${request.url}`,
      );

      if (
        axiosError.code === 'ECONNABORTED' ||
        axiosError.code === 'ETIMEDOUT'
      ) {
        throw new GatewayTimeoutException(
          `${this.upstreamName} did not respond in time`,
        );
      }
      if (axiosError.code === 'ECONNREFUSED') {
        throw new ServiceUnavailableException(
          `${this.upstreamName} is unavailable`,
        );
      }
      throw new BadGatewayException(
        `${this.upstreamName} returned an invalid response`,
      );
    }
  }

  private shouldRetry(
    request: AxiosRequestConfig,
    error: AxiosError,
    retriesUsed: number,
  ): boolean {
    if (retriesUsed >= MAX_RETRIES) {
      return false;
    }

    // Idempotent methods only. `method` is optional in axios's type and
    // defaults to GET, which is exactly the case we want to allow — but
    // treating "absent" as safe by accident is not the same as deciding it.
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    // A timeout means the request may have been PROCESSED. Everything else
    // here means it demonstrably was not.
    return (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'EAI_AGAIN' ||
      error.code === 'ENOTFOUND'
    );
  }
}

/**
 * ONE retry, not five.
 *
 * Every retry is load added to a system that is already failing, multiplied
 * by every replica doing the same thing. One is enough to ride out a
 * restarting container; more is a way of turning a small outage into a
 * stampede that prevents recovery.
 */
const MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending retry must never delay a graceful shutdown.
    timer.unref?.();
  });
}
