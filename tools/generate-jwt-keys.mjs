#!/usr/bin/env node
/**
 * Generates the RS256 signing keypair for local development.
 *
 *   node tools/generate-jwt-keys.mjs
 *
 * WHY TWO KEYS INSTEAD OF ONE SECRET.
 *
 * HS256 is symmetric: the same string signs and verifies. That is fine while
 * ONE service does both, and it becomes a problem the moment a second service
 * wants to check a token, because handing it the key to verify hands it the
 * key to MINT. A public-facing gateway that can issue itself an ADMIN token
 * is not an edge control, it is a second front door.
 *
 * RS256 is asymmetric:
 *
 *   PRIVATE KEY  Auth Service only. Signs. Never leaves that process.
 *   PUBLIC KEY   everyone. Verifies. Useless for forging anything.
 *
 * The public key is not a secret and does not need protecting — publishing it
 * costs nothing. That asymmetry is the whole point: verification can be
 * everywhere, minting stays in one place.
 *
 * 2048 bits, not 4096: the difference in signing cost is real and the
 * difference in security is not, for a credential that lives 15 minutes.
 *
 * THESE ARE DEVELOPMENT KEYS. They are written to a git-ignored directory on
 * a developer's laptop. A deployed environment takes its private key from a
 * secret manager (or a KMS that signs without ever releasing it), and rotates
 * it — which is why the token carries a `kid`, so two keys can be valid at
 * once during a rotation.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = join(root, 'keys');
const privatePath = join(keysDir, 'jwt-private.pem');
const publicPath = join(keysDir, 'jwt-public.pem');

const force = process.argv.includes('--force');

if (existsSync(privatePath) && !force) {
  // Regenerating silently would invalidate every token in flight and every
  // session on a running system. Refusing is the friendlier failure.
  console.error(
    `Refusing to overwrite ${privatePath}.\n` +
      `Every token signed with the old key stops verifying. Pass --force if that is what you want.`,
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(keysDir, { recursive: true });

// 0600 on the private key: owner read/write, nobody else. Node applies this
// on POSIX; on Windows the flag is ignored and NTFS inheritance applies, so
// the directory being git-ignored is what is actually protecting it here.
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });

console.log(`private key  ${privatePath}  (secret — never commit, never share)`);
console.log(`public key   ${publicPath}  (not a secret — distribute freely)`);
