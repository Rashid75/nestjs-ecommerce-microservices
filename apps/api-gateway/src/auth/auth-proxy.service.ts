import { correlationHeaders } from '@ecommerce/observability';
import {
  AuthResponseDto,
  AuthTokensDto,
  UserProfileDto,
} from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

/**
 * Forwards authentication calls to the Auth Service.
 *
 * WHY AN API GATEWAY AT ALL?
 *
 * Without one, a browser would need the address of every service, CORS rules
 * for each, and its own logic for which one owns which route. Every service
 * would reimplement rate limiting, request logging and correlation IDs, and
 * moving an endpoint between services would become a client release.
 *
 * The gateway is one public address that hides the internal topology.
 *
 * GATEWAY vs REVERSE PROXY vs NGINX. A reverse proxy forwards bytes very
 * fast and knows nothing about your domain. An API gateway understands the
 * API: it validates bodies, aggregates services into one response, and
 * translates protocols (REST in, RabbitMQ out — Milestone 7). In production
 * the two stack, with nginx or a load balancer terminating TLS in front.
 *
 * The failure-mapping logic now lives in UpstreamProxy, shared with the
 * catalog proxy.
 */
@Injectable()
export class AuthProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Auth service');
  }

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

  refresh(body: unknown): Promise<AuthTokensDto> {
    return this.forward<AuthTokensDto>({
      method: 'POST',
      url: '/auth/refresh',
      data: body,
      headers: correlationHeaders(),
    });
  }

  logout(body: unknown): Promise<void> {
    return this.forward<void>({
      method: 'POST',
      url: '/auth/logout',
      data: body,
      headers: correlationHeaders(),
    });
  }

  /**
   * The Authorization header is passed through untouched. The gateway does
   * not open the token — the Auth Service holds the signing key, so it is
   * the only component whose verdict on a token means anything.
   */
  me(authorization: string | undefined): Promise<UserProfileDto> {
    return this.forward<UserProfileDto>({
      method: 'GET',
      url: '/auth/me',
      headers: {
        ...correlationHeaders(),
        ...(authorization === undefined ? {} : { authorization }),
      },
    });
  }
}
