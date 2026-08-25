import { AuthResponseDto, UserProfileDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';

/**
 * Forwards authentication calls to the Auth Service over HTTP.
 *
 * WHY AN API GATEWAY AT ALL?
 *
 * Without one, a browser would need the address of all nine services, CORS
 * rules for each, and its own logic for which one owns which route. Every
 * service would then have to implement rate limiting, request logging and
 * correlation IDs for itself, and moving an endpoint between services would
 * become a client release.
 *
 * The gateway is one public address that hides the internal topology.
 *
 * GATEWAY vs REVERSE PROXY vs NGINX. A reverse proxy (nginx) forwards bytes
 * extremely fast and knows nothing about your domain. An API gateway
 * understands the API: it can validate a body, aggregate two services into one
 * response, translate protocols (REST in, RabbitMQ out — Milestone 7) and
 * apply per-route policy. We need those, so the gateway is a NestJS app. In
 * production the two usually stack: nginx or a cloud load balancer terminates
 * TLS in front of this.
 *
 * WHY NOT MICROSERVICE TRANSPORT? NestJS could talk to Auth over TCP or
 * RabbitMQ instead of HTTP. HTTP is the right first choice: it is debuggable
 * with curl, it produces a real status code, and it is synchronous — which
 * "log me in" genuinely is. Asynchronous messaging arrives when there is work
 * that genuinely does not need an answer right now.
 */
@Injectable()
export class AuthProxyService {
  private readonly logger = new Logger(AuthProxyService.name);

  constructor(private readonly http: HttpService) {}

  register(body: unknown): Promise<AuthResponseDto> {
    return this.forward<AuthResponseDto>({
      method: 'POST',
      url: '/auth/register',
      data: body,
    });
  }

  login(body: unknown): Promise<AuthResponseDto> {
    return this.forward<AuthResponseDto>({
      method: 'POST',
      url: '/auth/login',
      data: body,
    });
  }

  /**
   * The Authorization header is passed through untouched. The gateway does not
   * open the token — the Auth Service is the only component that holds the
   * signing key, so it is the only component whose verdict on a token means
   * anything.
   */
  me(authorization: string | undefined): Promise<UserProfileDto> {
    return this.forward<UserProfileDto>({
      method: 'GET',
      url: '/auth/me',
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  /**
   * One place where every downstream failure is translated.
   *
   * The distinction that matters is between "the service answered, and the
   * answer was an error" and "the service did not answer at all".
   *
   *   ANSWERED (4xx/5xx)   pass the status and body straight through. A 409
   *                        from Auth must reach the client as a 409, not as a
   *                        500 — otherwise every downstream error looks like a
   *                        gateway bug and clients cannot handle anything.
   *
   *   NO ANSWER            this is the GATEWAY's problem to describe:
   *                        connection refused -> 503 Service Unavailable
   *                        timed out          -> 504 Gateway Timeout
   *                        anything else      -> 502 Bad Gateway
   *
   * Getting this wrong in either direction is a common and expensive mistake:
   * collapse everything to 500 and clients lose all ability to react; leak the
   * raw axios error and you publish your internal hostnames and ports.
   */
  private async forward<T>(request: AxiosRequestConfig): Promise<T> {
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

      // Log the internal detail; return something that says nothing about our
      // topology.
      this.logger.error(
        `auth service unreachable: ${axiosError.code ?? 'unknown'} on ${request.method} ${request.url}`,
      );

      if (
        axiosError.code === 'ECONNABORTED' ||
        axiosError.code === 'ETIMEDOUT'
      ) {
        throw new GatewayTimeoutException(
          'Auth service did not respond in time',
        );
      }
      if (axiosError.code === 'ECONNREFUSED') {
        throw new ServiceUnavailableException('Auth service is unavailable');
      }
      throw new BadGatewayException(
        'Auth service returned an invalid response',
      );
    }
  }
}
