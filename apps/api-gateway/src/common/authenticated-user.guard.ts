import { UserProfileDto } from '@ecommerce/contracts';
import { CacheService } from '@ecommerce/redis';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AxiosError, AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { AUTH_HTTP_CLIENT } from './authentication.tokens';

/** Where the resolved user is stashed for `@AuthenticatedUser()` to read. */
export const AUTHENTICATED_USER = Symbol('AUTHENTICATED_USER');

/**
 * How long a successful introspection is cached.
 *
 * Short on purpose. This is the window in which a disabled account still
 * gets through — the same trade-off the Auth Service makes by re-reading the
 * user on every request, moved one hop out and given a bound.
 *
 * 30s against a 900s token lifetime means the cache removes ~97% of the
 * introspection calls while shrinking the revocation window from 15 minutes
 * to half a minute. Both numbers move together: lengthen this and you are
 * trading revocation latency for load.
 */
const INTROSPECTION_TTL_SECONDS = 30;

/**
 * Verifies the caller's access token by asking the Auth Service.
 *
 * WHY INTROSPECTION AND NOT LOCAL VERIFICATION.
 *
 * The obvious approach is for the gateway to verify the JWT signature
 * itself. That requires the signing key — and with HS256 a key that can
 * VERIFY can also MINT. Giving the gateway (a public-facing process) the
 * ability to issue admin tokens, purely so it can read a `sub` claim, is a
 * bad trade.
 *
 * The clean fix is RS256: the Auth Service keeps the private key, everyone
 * else verifies with the public one and can mint nothing. That migration is
 * still pending. Until then, introspection gives the gateway an identity
 * with NO key sharing at all: it forwards the token to `/auth/me` and
 * believes the answer.
 *
 * The cost is a round trip per authenticated request. Redis absorbs
 * almost all of it — this is a genuinely good use of the cache, unlike the
 * cart itself.
 *
 * A comparison worth holding on to:
 *
 *   LOCAL VERIFY   fastest, no hop, cannot revoke early, needs key
 *                  distribution and rotation
 *   INTROSPECT     a hop (cached), revocation in ~TTL, no key sharing,
 *                  Auth becomes a hard dependency of every guarded route
 *
 * The last clause is the real cost: Auth being down now breaks the cart, not
 * just login. That is stated rather than hidden, and it is why cart READS
 * would ideally degrade rather than fail — noted as deferred.
 */
@Injectable()
export class AuthenticatedUserGuard implements CanActivate {
  private readonly logger = new Logger(AuthenticatedUserGuard.name);

  constructor(
    // An EXPLICIT token, not a bare HttpService.
    //
    // The first version injected `HttpService` and relied on Nest resolving
    // it inside AuthenticationModule, which provides an Auth-configured one.
    // It does not: `@UseGuards(SomeGuard)` instantiates the guard in the
    // context of the module that declares the CONTROLLER, so it picked up
    // CartModule's client and every introspection went to the Cart Service
    // instead — surfacing as ECONNREFUSED and a 503 for every valid token.
    //
    // A named token cannot be resolved to the wrong thing. When a dependency
    // has to be a SPECIFIC configured instance rather than "whatever is in
    // scope", say so.
    @Inject(AUTH_HTTP_CLIENT) private readonly http: AxiosInstance,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;

    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    ) {
      throw new UnauthorizedException('Authentication required');
    }

    const user = await this.introspect(authorization);

    // Stash on the request for @AuthenticatedUser() to read, and for the
    // proxy to turn into the X-User-Id header.
    (request as unknown as Record<symbol, unknown>)[AUTHENTICATED_USER] = user;
    return true;
  }

  private async introspect(authorization: string): Promise<UserProfileDto> {
    // The cache key is a HASH of the token, never the token itself.
    //
    // Redis keys turn up in SCAN output, in slow logs, in monitoring
    // dashboards and in support screenshots. A raw bearer token in any of
    // those is a credential leak, and it would be a credential that still
    // works. SHA-256 of the token is a stable identifier that is useless to
    // anyone who reads it.
    const key = `auth:${createHash('sha256').update(authorization).digest('hex')}`;

    const cached = await this.cache.get<UserProfileDto>(key);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await this.http.get<UserProfileDto>('/auth/me', {
        headers: { authorization },
      });

      // Only SUCCESSFUL introspections are cached. Caching a rejection would
      // mean a user who logs in again is refused for up to the TTL, and it
      // would let an attacker cheaply fill the keyspace with junk tokens.
      await this.cache.set(key, response.data, {
        ttlSeconds: INTROSPECTION_TTL_SECONDS,
        // No jitter: the point of this TTL is a predictable revocation bound,
        // and these keys are naturally spread across sessions anyway.
        jitter: false,
      });

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response?.status === 401) {
        throw new UnauthorizedException('Invalid or expired token');
      }

      // Auth unreachable. FAIL CLOSED — unlike the rate limiter, which fails
      // open by default.
      //
      // The asymmetry is deliberate. Failing open on rate limiting means
      // "everyone gets through unthrottled", which is a degradation. Failing
      // open on AUTHENTICATION would mean "everyone gets through
      // unauthenticated", which is a complete bypass of the control. There
      // is no configuration flag for this one, because there is no defensible
      // reason to want the other behaviour.
      this.logger.error(
        `token introspection failed: ${axiosError.code ?? axiosError.message}`,
      );
      throw new ServiceUnavailableException(
        'Authentication is temporarily unavailable',
      );
    }
  }
}
