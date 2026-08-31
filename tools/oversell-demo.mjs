/**
 * Fires N simultaneous reservations at a product that has exactly one unit,
 * and reports how many succeeded.
 *
 * A correct inventory service allows EXACTLY ONE. Anything more is
 * overselling — the system promised the same physical item to several
 * customers, and someone is getting a "sorry, actually out of stock" email.
 *
 * This is the whole of Milestone 5, made observable. Unit tests cannot show
 * it: a race needs real concurrent connections to a real database, and a
 * mocked repository has no rows to contend over.
 *
 * Usage (services must be running):
 *   npm run demo:oversell
 *   npm run demo:oversell -- --concurrency 50 --stock 3
 */

const args = process.argv.slice(2);

function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const GATEWAY = arg('gateway', 'http://localhost:3000');
const PREFIX = arg('prefix', 'api');
const CONCURRENCY = Number(arg('concurrency', '20'));
const STOCK = Number(arg('stock', '1'));

const BASE = `${GATEWAY}/${PREFIX}`;

async function json(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
  };
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

console.log('─'.repeat(64));
console.log('  OVERSELLING DEMONSTRATION');
console.log(
  `  ${CONCURRENCY} simultaneous reservations against ${STOCK} unit(s)`,
);
console.log('─'.repeat(64));

// ── 1. a category to hang the product on ────────────────────────────────
const stamp = Date.now().toString().slice(-9);

const category = await json('POST', '/categories', {
  name: `Oversell demo ${stamp}`,
  slug: `oversell-demo-${stamp}`,
});
if (category.status !== 201) fail('could not create category', category.body);

// ── 2. a product ────────────────────────────────────────────────────────
const product = await json('POST', '/products', {
  name: `Last one in stock ${stamp}`,
  sku: `DEMO-${stamp}`,
  price: 9.99,
  categoryId: category.body.id,
});
if (product.status !== 201) fail('could not create product', product.body);

const productId = product.body.id;
console.log(`\nproduct  ${productId}`);
console.log(`sku      ${product.body.sku}`);

// ── 3. inventory with exactly STOCK units ───────────────────────────────
const inventory = await json('POST', '/inventory', {
  productId,
  sku: product.body.sku,
  onHand: STOCK,
});
if (inventory.status !== 201)
  fail('could not create inventory', inventory.body);
console.log(
  `stock    onHand=${inventory.body.onHand} available=${inventory.body.available}`,
);

// ── 4. THE RACE ─────────────────────────────────────────────────────────
//
// Promise.all starts every request before awaiting any of them, so all N
// are in flight against the database at once. This is the closest thing to
// "two customers pressing Buy at the same instant" that a single script can
// produce, and on a multi-core machine it genuinely does interleave.
console.log(`\nfiring ${CONCURRENCY} concurrent reservations...\n`);

const started = Date.now();
const results = await Promise.all(
  Array.from({ length: CONCURRENCY }, (_, i) =>
    json('POST', `/inventory/${productId}/reserve`, {
      quantity: 1,
      reference: `demo:customer-${i + 1}`,
    }),
  ),
);
const elapsed = Date.now() - started;

const succeeded = results.filter((r) => r.status === 200).length;
const conflicts = results.filter((r) => r.status === 409).length;
const throttled = results.filter((r) => r.status === 429).length;
const other = results.filter((r) => ![200, 409, 429].includes(r.status)).length;

console.log(`  200 OK        ${succeeded}   reservation granted`);
console.log(
  `  409 Conflict  ${conflicts}   insufficient stock — lost the race`,
);
if (throttled > 0) {
  console.log(
    `  429           ${throttled}   rate limited (30/min on reserve)`,
  );
}
if (other > 0) console.log(`  other         ${other}`);
console.log(`  elapsed       ${elapsed}ms`);

// ── 5. the verdict ──────────────────────────────────────────────────────
const final = await json('GET', `/inventory/${productId}`);
const { onHand, reserved, available } = final.body;

console.log(
  `\nfinal state   onHand=${onHand} reserved=${reserved} available=${available}`,
);

console.log('\n' + '─'.repeat(64));

// The invariant. `reserved` may never exceed `onHand` — that is the
// difference between a correct inventory system and one that sells the same
// item twice. A database CHECK constraint enforces it as a last resort, but
// a correct implementation should never come close to tripping it.
if (reserved > onHand) {
  console.log('  ✗ OVERSOLD');
  console.log(`    reserved (${reserved}) exceeds onHand (${onHand}).`);
  console.log('    The same physical item was promised more than once.');
  process.exit(1);
}

if (succeeded + throttled === 0) {
  console.log('  ? INCONCLUSIVE — every request failed. Check the services.');
  process.exit(1);
}

// With rate limiting active some requests never reach the database, so the
// exact success count is bounded by stock but not guaranteed to equal it.
if (succeeded > STOCK) {
  console.log(
    `  ✗ OVERSOLD — ${succeeded} succeeded but only ${STOCK} existed.`,
  );
  process.exit(1);
}

console.log(
  `  ✓ CORRECT — ${succeeded} of ${CONCURRENCY} succeeded, stock was ${STOCK}.`,
);
console.log('');
console.log('    The availability check and the write are ONE atomic');
console.log('    statement, so there is no window between deciding and');
console.log('    acting for another transaction to interleave with.');
console.log('');
console.log('    Read the ledger to see who won:');
console.log(`      curl -s ${BASE}/inventory/${productId}/movements`);
console.log('─'.repeat(64));
