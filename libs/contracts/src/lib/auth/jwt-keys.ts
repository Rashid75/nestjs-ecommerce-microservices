import { readFileSync } from 'node:fs';

/**
 * The terms every process that touches a token must agree on.
 *
 * These live in `contracts` for the same reason the routing keys and the DTOs
 * do: a disagreement here is not a bug that shows up as a wrong answer, it is
 * a bug that shows up as "every request is 401" — or, much worse, as a token
 * one service rejects and another accepts.
 *
 * THREE CHECKS, AND ALL THREE MATTER:
 *
 *   ALGORITHM  pinned to RS256. A verifier that accepts "whatever the token's
 *              header says" is the classic JWT vulnerability: a forged token
 *              with `"alg": "none"` needs no signature at all, and one with
 *              `"alg": "HS256"` invites the verifier to use the PUBLIC key as
 *              an HMAC secret — and the public key is public. Naming the
 *              algorithm you accept turns both attacks into a rejection.
 *
 *   ISSUER     who minted it. Without this, a token from any other system
 *              that happens to use the same key material is accepted.
 *
 *   AUDIENCE   who it is FOR. This is the check that stops a token minted for
 *              one purpose being replayed at another. Today there is one
 *              audience; it is here now because adding it later means finding
 *              every verifier.
 */
export const JWT_ALGORITHM = 'RS256' as const;
export const JWT_ISSUER = 'ecommerce-auth';
export const JWT_AUDIENCE = 'ecommerce-api';

/**
 * Reads a PEM key from disk, once, at startup.
 *
 * DELIBERATELY SYNCHRONOUS AND DELIBERATELY AT BOOT. A key read per request
 * would be a filesystem call on the hot path; a key read lazily would turn a
 * missing file into a 500 on the first login rather than a process that
 * refuses to start. Fail fast, and fail before any traffic arrives.
 *
 * The error names the PATH and never the contents — a startup error is
 * exactly the kind of thing that gets pasted into a chat window.
 */
export function loadPemKey(path: string, what: string): string {
  let pem: string;

  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `${what} could not be read from ${path}. ` +
        `Run: node tools/generate-jwt-keys.mjs`,
    );
  }

  // A truncated or wrong-format file produces a jsonwebtoken error deep
  // inside a signing call, which reads like a library bug. Check the shape
  // here, where the message can say what is actually wrong.
  if (!pem.includes('-----BEGIN')) {
    throw new Error(`${what} at ${path} is not a PEM file`);
  }

  return pem;
}
