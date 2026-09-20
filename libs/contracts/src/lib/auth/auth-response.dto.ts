import { UserRole } from './user-role.enum';

/**
 * The safe, public projection of a user.
 *
 * There is no `passwordHash` field and there never will be. This class is the
 * outermost of three independent layers that keep the hash off the wire:
 *
 *   1. the model's `defaultScope` does not even SELECT the column;
 *   2. the repository returns a plain object, not a model instance;
 *   3. this DTO enumerates exactly what a client may see.
 *
 * Any one of those could be defeated by a careless change. All three failing
 * at once is unlikely, which is the whole idea behind defence in depth.
 */
export class UserProfileDto {
  id!: string;

  email!: string;

  firstName!: string;

  lastName!: string;

  role!: UserRole;

  createdAt!: Date;
}

/**
 * The credential half of an authentication response.
 *
 * `expiresIn` is included so a client never has to decode the JWT to find out
 * when it dies. Clients that parse tokens to make decisions end up depending
 * on the token's internal format, which is supposed to be our business.
 *
 * TWO TOKENS SINCE MILESTONE 12, with deliberately different properties:
 *
 *   accessToken   ~15 minutes. STATELESS — checked by signature alone, sent
 *                 on every request, and UNREVOCABLE. It is short precisely
 *                 because nothing can stop it early.
 *   refreshToken  ~30 days. STATEFUL — checked against a database row, used
 *                 a few times a day, and revocable by writing that row. It
 *                 is opaque: a random string with no claims inside it,
 *                 because everything about it is looked up anyway.
 *
 * The pairing is the point. Long sessions without long-lived unrevocable
 * credentials, and the expensive check happens a few times a day rather than
 * on every request.
 *
 * STORE THE REFRESH TOKEN LIKE A PASSWORD. It is one: anything holding it can
 * mint access tokens for thirty days. In a browser that means an httpOnly,
 * Secure, SameSite cookie rather than `localStorage`, which any injected
 * script can read.
 */
export class AuthTokensDto {
  accessToken!: string;

  tokenType!: string;

  expiresIn!: number;

  refreshToken!: string;

  /** Seconds until the refresh token expires, so a client need not guess. */
  refreshExpiresIn!: number;
}

/** What both `POST /auth/register` and `POST /auth/login` return. */
export class AuthResponseDto {
  user!: UserProfileDto;

  tokens!: AuthTokensDto;
}

/**
 * The claims we put inside the access token.
 *
 * Kept minimal on purpose. A JWT is signed, not encrypted — anyone holding it
 * can read every claim with a base64 decoder. It also cannot be revoked before
 * it expires, so every claim in here is a fact we are willing to be wrong
 * about for up to `expiresIn` seconds.
 *
 *   sub   subject, the user id (RFC 7519 registered claim)
 *   email convenience for logs and the gateway
 *   role  coarse authorisation; re-checked against the database for anything
 *         that actually matters
 */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
}
