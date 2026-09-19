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
import { AccessTokenVerifier } from './access-token.verifier';
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
 * VERIFY, THEN ASK — two steps that answer two different questions.
 *
 *   1. VERIFY the signature locally with the PUBLIC key (Milestone 12).
 *      Answers "was this minted by our Auth Service, unaltered, and is it
 *      still inside its lifetime". Costs microseconds and no network. A
 *      forged or expired token dies here, so a credential-stuffing run puts
 *      no load on the Auth Service at all.
 *
 *      This was impossible before RS256: under HS256 the verifying key is
 *      the signing key, and a public-facing gateway able to MINT admin
 *      tokens is a worse problem than the one it solves.
 *
 *   2. INTROSPECT, cached 30 seconds. Answers "is this account still active,
 *      and what is its role RIGHT NOW". A signature cannot answer that — the
 *      claims are a 15-minute-old photograph of a database row.
 *
 * Doing only step 1 would be faster and would widen the revocation window
 * from 30 seconds to the full token lifetime. That trade is not made here;
 * see `access-token.verifier.ts`.
 *
 * Doing only step 2 is what this file did until Milestone 12, and its cost
 * is that Auth being down breaks the cart, not just login. Step 1 does not
 * remove that dependency — it only stops junk from reaching it.
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
    private readonly verifier: AccessTokenVerifier,
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

    // STEP 1. Local, keyless-to-forge, and free. Throws 401 on anything
    // that is not a genuine, unexpired, correctly-addressed token.
    const claims = this.verifier.verify(authorization.slice('Bearer '.length));

    // STEP 2. Now that it is known to be authentic, find out whether it is
    // still TRUE.
    const user = await this.introspect(authorization);

    // The two must agree. They cannot disagree in normal operation, and if
    // they ever do — a token whose subject is not the account Auth returned
    // — something is badly wrong and the request must not proceed.
    if (user.id !== claims.sub) {
      this.logger.error(
        `token subject ${claims.sub} does not match introspected user ${user.id}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }

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
