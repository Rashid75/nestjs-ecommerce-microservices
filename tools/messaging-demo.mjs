/**
 * Shows an event travelling from the Product Service to the Cart Service.
 *
 * Entirely over the HTTP API — no AMQP code here at all. Publishing and
 * consuming are NestJS's job now; this just proves the effect.
 *
 * Requires the stack running and RabbitMQ up:
 *   docker run -d --name ecommerce-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
 *
 * Usage:
 *   npm run demo:messaging
 */
const GATEWAY = 'http://localhost:3000/api';
const line = (n = 62) => '─'.repeat(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function bail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

console.log(line());
console.log('  EVENT DEMONSTRATION  —  Product ──► RabbitMQ ──► Cart');
console.log(line());

const stamp = Date.now().toString().slice(-9);

const auth = await api('POST', '/auth/register', {
  email: `msg+${stamp}@example.com`,
  password: 'correct-horse-Battery9',
  firstName: 'Msg',
  lastName: 'Demo',
});
if (auth.status !== 201) bail('could not register', auth.body);
const token = auth.body.tokens.accessToken;

const category = await api('POST', '/categories', {
  name: `Event demo ${stamp}`,
  slug: `event-demo-${stamp}`,
});
if (category.status !== 201) bail('could not create category', category.body);

const product = await api('POST', '/products', {
  name: `Event demo ${stamp}`,
  sku: `MSG-${stamp}`,
  price: 19.99,
  status: 'ACTIVE',
  categoryId: category.body.id,
});
if (product.status !== 201) bail('could not create product', product.body);
const productId = product.body.id;

const added = await api(
  'POST',
  '/cart/items',
  { productId, quantity: 1 },
  token,
);
if (added.status !== 201) bail('could not add to cart', added.body);

console.log(`\n1. product ${product.body.sku} created at 19.99`);
console.log(
  `2. added to the cart — snapshot unitPrice = ${added.body.items[0].unitPrice}`,
);

console.log('\n3. changing the catalogue price to 24.99...');
console.log('   → Product Service emits "product.price_changed"');
console.log('   → RabbitMQ delivers it to the cart queue');
console.log('   → Cart Service @EventPattern handler flags the line');

const patched = await api('PATCH', `/products/${productId}`, { price: 24.99 });
if (patched.status !== 200) bail('could not change the price', patched.body);

await sleep(1500);

const after = await api('GET', '/cart', null, token);
const flagged = after.body.items.find((i) => i.productId === productId);

console.log(`\n${line()}`);
console.log(`  unitPrice      ${flagged.unitPrice}   ← snapshot, UNCHANGED`);
console.log(
  `  cataloguePrice ${flagged.cataloguePrice ?? '(not flagged yet)'}   ← what the catalogue says now`,
);
console.log(line());

if (flagged.cataloguePrice === '24.99' && flagged.unitPrice === '19.99') {
  console.log('\n  ✓ The consumer flagged the line WITHOUT repricing it.');
  console.log('');
  console.log('    Snapshot what the customer was shown;');
  console.log('    flag what moved;');
  console.log('    re-check before taking money.');
  console.log('');
  console.log('    Note the ~1s lag. That is eventual consistency, and it is');
  console.log(
    '    the price of the decoupling: the Cart Service learned about',
  );
  console.log(
    '    a catalogue change without ever calling the Product Service.',
  );
} else {
  console.log('\n  ? No flag yet. Check that RabbitMQ is running and that the');
  console.log('    Cart Service logged "consuming RabbitMQ queue".');
  process.exit(1);
}

console.log(`\n${line()}`);
console.log('  Now open the management UI: http://localhost:15672');
console.log('  (guest / guest)');
console.log('');
console.log('    Queues → ecommerce_events   the queue Nest created');
console.log('    Connections                 one per running service');
console.log(line());
