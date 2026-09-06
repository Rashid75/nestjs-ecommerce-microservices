import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/** The header the API Gateway sets after verifying the access token. */
export const USER_ID_HEADER = 'x-user-id';

/**
 * The authenticated user's id, as told to us by the gateway.
 *
 * THE TRUST BOUNDARY, stated plainly.
 *
 * This service does NOT verify the access token. It trusts a header. That is
 * only safe because of where it listens: 127.0.0.1, reachable from the
 * gateway and from nothing else. Bind this service to 0.0.0.0 and anyone on
 * the network can set `X-User-Id` to any value and read any payment.
 *
 * Why do it this way at all? The alternative is for every service to verify
 * JWTs itself, which means every service needs the signing key — and an
 * HS256 key that can verify can also MINT. Handing the Payment Service the
 * ability to issue admin tokens, just so it can learn a user id, is a much
 * worse trade.
 *
 * How production closes the gap properly, in increasing order of rigour:
 *
 *   1. A shared secret header between gateway and services, so a request
 *      that skipped the gateway is detectable.
 *   2. mTLS — the service only accepts connections presenting the gateway's
 *      client certificate.
 *   3. A service mesh (Istio, Linkerd) doing 2 transparently.
 *   4. RS256: the gateway mints a short-lived internal token the service
 *      verifies with a PUBLIC key, so no service can mint.
 *
 * (4) is where this project is heading, and it is the same decision the
 * catalogue's authorisation gap is waiting on. Until then, the loopback
 * binding IS the control, and it is worth being honest that it is a weak one.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.headers[USER_ID_HEADER];

    if (typeof userId !== 'string' || userId === '') {
      // Fail closed, and here that matters more than anywhere else in the
      // system: a placeholder user id would mean anonymous requests charging
      // one person's card and reading everyone's payment history.
      throw new UnauthorizedException('Authentication required');
    }

    return userId;
  },
);
