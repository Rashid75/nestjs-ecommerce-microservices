import {
  AccessTokenClaims,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  loadPemKey,
} from '@ecommerce/contracts';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthEnv } from '../config/env.validation';
import { UserRecord, UsersRepository } from '../users/users.repository';

/**
 * Passport terminology, because the three words get used interchangeably and
 * they are not the same thing:
 *
 *   STRATEGY  how a credential is extracted from a request and turned into a
 *             user. This file. Passport has hundreds — local, jwt, oauth2,
 *             saml — and they all expose the same `validate()` shape.
 *   GUARD     a NestJS construct that decides whether a handler may run. Our
 *             JwtAuthGuard simply asks Passport to run this strategy.
 *   DECORATOR `@CurrentUser()`, which reads whatever `validate()` returned.
 *
 * The value of the split is that swapping "JWT in a header" for "session
 * cookie" means writing a new strategy and changing nothing else.
 *
 * Registered under the name 'jwt' (the default for passport-jwt), which is
 * what `AuthGuard('jwt')` refers to.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly users: UsersRepository,
    config: ConfigService<AuthEnv, true>,
  ) {
    super({
      // Where to find the token. `Authorization: Bearer <token>` is the
      // convention; passport-jwt can also read a cookie or query parameter,
      // but a token in a URL ends up in server logs and browser history, so
      // we do not allow that.
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      // MUST stay false. `true` would accept expired tokens, which quietly
      // turns a 15-minute credential into a permanent one and removes the only
      // revocation mechanism a stateless token has.
      ignoreExpiration: false,

      // The PUBLIC key, even here. This service holds the private key too,
      // but verification has no use for it — and using the signing key to
      // verify would mean every code path that reads a token had the ability
      // to mint one. Use the least-powerful key that does the job.
      secretOrKey: loadPemKey(
        config.get('JWT_PUBLIC_KEY_PATH', { infer: true }),
        'JWT public key',
      ),

      // Pin the algorithm. Without this, a token whose header says
      // `"alg": "none"` is accepted with no signature at all, and one that
      // says `"alg": "HS256"` invites the verifier to HMAC it with the
      // public key — which is public. Say what you accept.
      algorithms: [JWT_ALGORITHM],

      // WHO minted it and WHO it is for. Both are rejections, not warnings.
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  /**
   * Runs ONLY after the signature and expiry have already been verified. By
   * the time we get here the claims are known to be authentic; the question
   * left is whether the subject is still allowed in.
   *
   * The database lookup is a deliberate trade-off, and it is worth
   * understanding both sides:
   *
   *   WITHOUT the lookup — trust the claims. Zero queries, perfectly
   *   stateless, and a user you deleted or disabled keeps full access until
   *   their token expires. Their role in the token is also frozen: demote an
   *   admin and they stay an admin for another 15 minutes.
   *
   *   WITH the lookup — one indexed primary-key SELECT per authenticated
   *   request, and disabling an account takes effect on the next request.
   *
   * We take the query. A primary-key lookup is cheap, correctness about who is
   * allowed in is not negotiable, and when the cost does start to matter this
   * is precisely the kind of hot, rarely-changing read that Redis is for
   * (Milestone 4).
   *
   * Returning a value here puts it on `request.user`.
   */
  async validate(payload: AccessTokenClaims): Promise<UserRecord> {
    const user = await this.users.findById(payload.sub);

    if (user === null || !user.isActive) {
      // Same generic message either way — a valid token for a deleted account
      // should not confirm that the account once existed.
      throw new UnauthorizedException('Invalid or expired token');
    }

    return user;
  }
}
