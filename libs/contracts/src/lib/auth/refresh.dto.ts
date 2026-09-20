import { IsString, Length } from 'class-validator';

/**
 * The body of `POST /auth/refresh` and `POST /auth/logout`.
 *
 * WHY A BODY AND NOT AN `Authorization` HEADER. The refresh token is not a
 * credential for *this* request in the way a bearer token is — it is the
 * subject of the request. Sending it as a bearer token invites every piece of
 * middleware that touches `Authorization` to treat it as an access token, and
 * the two have very different lifetimes and blast radii. Keeping them in
 * different places keeps them from being confused.
 *
 * It is also why it is not a query parameter: a URL ends up in access logs,
 * browser history and `Referer` headers, and a 30-day credential must not.
 *
 * `@Length` bounds it before anything hashes it — an unbounded string is an
 * invitation to send a megabyte and make the server do the work.
 */
export class RefreshTokenDto {
  @IsString()
  @Length(32, 512)
  refreshToken!: string;
}
