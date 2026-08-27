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
    try {
      const response = await firstValueFrom(this.http.request<T>(request));
      return response.data;
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
