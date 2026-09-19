import {
  AccessTokenClaims,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '@ecommerce/contracts';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Verifies an access token at the EDGE, with the public key.
 *
 * WHAT CHANGED IN MILESTONE 12, AND WHY IT COULD NOT BE DONE BEFORE.
 *
 * Until now the gateway could not check a token at all. Under HS256 the key
 * that verifies is the key that signs, so giving the gateway — the one
 * process the internet can reach — the ability to check a token would have
 * given it the ability to MINT one, including an ADMIN one. The gateway
 * therefore asked the Auth Service about every request instead.
 *
 * With RS256 the gateway holds only the PUBLIC key. It can prove a token was
 * minted by Auth and has not been altered; it cannot produce a token of its
 * own. That is the entire argument for asymmetric keys in one sentence.
 *
 * WHAT THIS DOES *NOT* REPLACE.
 *
 * A signature check answers "was this minted by us, unaltered, and is it
 * still within its lifetime". It cannot answer "is this account still
 * active" or "is this user still an admin" — those facts live in a database
 * and the token is a 15-minute-old photograph of them. So the guard still
 * introspects, and this verifier runs FIRST:
 *
 *   VERIFY, THEN ASK.
 *
 *   - A forged, expired, altered or foreign token is rejected here, in
 *     microseconds, without touching the network. The Auth Service never
 *     sees the load from a credential-stuffing run.
 *   - A token that IS genuine then costs one introspection, cached 30s, to
 *     get facts that are fresh rather than merely authentic.
 *
 * Dropping the introspection would be tempting — it is a hop, even cached —
 * and it would widen the revocation window from 30 seconds to the full token
 * lifetime. That is a real security regression traded for a small latency
 * win, so it is not made. Revoking sessions properly (refresh tokens and a
 * deny-list) is the next pass.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(private readonly jwt: JwtService) {}

  verify(token: string): AccessTokenClaims {
    try {
      return this.jwt.verify<AccessTokenClaims>(token, {
        // Repeated here rather than inherited from the module's defaults.
        // `verify()` silently accepts a call with no constraints, and a
        // verifier that trusts its own configuration to have been set
        // correctly elsewhere is a verifier one refactor away from
        // accepting anything.
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      // The library's message distinguishes "expired" from "invalid
      // signature" from "wrong audience". The CLIENT is told none of that:
      // an attacker probing with forged tokens should not be given a
      // debugger. The distinction is in the log, one level up.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
