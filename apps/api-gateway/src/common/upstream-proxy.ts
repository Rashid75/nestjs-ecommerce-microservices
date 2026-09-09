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
}
