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
 * There is no refresh token yet. Milestone 2 issues short-lived ACCESS tokens
 * only; refresh tokens bring rotation, reuse detection and a revocation store,
 * which is a whole subject of its own.
 */
export class AuthTokensDto {
  accessToken!: string;

  tokenType!: string;

  expiresIn!: number;
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
