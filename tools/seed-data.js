/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The canonical demo catalogue, in ONE file.
 *
 * WHY THE UUIDs ARE HARD-CODED, which looks wrong until you need it.
 *
 * Database-per-service means this data lands in three different databases
 * that cannot see each other:
 *
 *   ecommerce_product_db      categories, products
 *   ecommerce_inventory_db    inventory_items (keyed by product_id)
 *   ecommerce_auth_db         an admin to log in as
 *
 * The inventory row for the ThinkPad has to carry the SAME product_id the
 * Product Service gave it — and there is no foreign key to enforce that,
 * because the tables are in different databases. Generating ids at seed time
 * would mean the inventory seeder had to read the product database, which is
 * exactly the cross-database dependency the architecture forbids.
 *
 * Fixed ids remove the question. Every service seeds independently, in any
 * order, and they agree because they were told the same answer up front.
 *
 * The side effect is worth more than the tidiness: seeding is IDEMPOTENT.
 * Running it twice inserts nothing the second time (the unique index on the
 * id refuses), so `db:seed` is safe to run on a database that already has
 * the demo data — which is the difference between a command you use and one
 * you are afraid of.
 *
 * The ids are readable on purpose (`...a11` is a category, `...b21` a
 * product), so a row in a log or a Postman response can be recognised at a
 * glance as seed data rather than something a test created.
 */

const CATEGORIES = [
  {
    id: '0a000000-0000-4000-8000-000000000a11',
    name: 'Laptops',
    slug: 'laptops',
    description: 'Portable computers for work and play.',
  },
  {
    id: '0a000000-0000-4000-8000-000000000a12',
    name: 'Monitors',
    slug: 'monitors',
    description: 'External displays.',
  },
  {
    id: '0a000000-0000-4000-8000-000000000a13',
    name: 'Accessories',
    slug: 'accessories',
    description: 'Keyboards, mice, cables and docks.',
  },
];

/**
 * Prices are STRINGS, in major units, exactly as the DECIMAL(12,2) column
 * stores them. Writing 1299.99 as a JavaScript number here would introduce a
 * float at the only point in the system that has carefully avoided one.
 */
const PRODUCTS = [
  {
    id: '0b000000-0000-4000-8000-000000000b21',
    categoryId: CATEGORIES[0].id,
    name: 'ThinkPad X1 Carbon',
    sku: 'SEED-LAP-001',
    description: '14-inch business laptop, 32GB RAM, 1TB SSD.',
    price: '1899.00',
    stock: 12,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b22',
    categoryId: CATEGORIES[0].id,
    name: 'MacBook Air 15"',
    sku: 'SEED-LAP-002',
    description: 'M3, 16GB unified memory, 512GB SSD.',
    price: '1499.00',
    stock: 8,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b23',
    categoryId: CATEGORIES[0].id,
    name: 'Framework Laptop 13',
    sku: 'SEED-LAP-003',
    description: 'Repairable, upgradeable, 32GB RAM.',
    price: '1299.00',
    // DELIBERATELY LOW. Two of these is the whole stock, which makes the
    // oversell and insufficient-stock paths reachable without editing
    // anything first.
    stock: 2,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b24',
    categoryId: CATEGORIES[1].id,
    name: 'Dell UltraSharp 27" 4K',
    sku: 'SEED-MON-001',
    description: 'IPS Black, USB-C 90W.',
    price: '649.50',
    stock: 20,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b25',
    categoryId: CATEGORIES[1].id,
    name: 'LG 34" UltraWide',
    sku: 'SEED-MON-002',
    description: '3440x1440, 144Hz.',
    price: '799.00',
    stock: 15,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b26',
    categoryId: CATEGORIES[2].id,
    name: 'Keychron K3 Pro',
    sku: 'SEED-ACC-001',
    description: 'Low-profile mechanical keyboard, hot-swappable.',
    price: '94.99',
    stock: 40,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b27',
    categoryId: CATEGORIES[2].id,
    name: 'Logitech MX Master 3S',
    sku: 'SEED-ACC-002',
    description: '8K DPI, quiet clicks.',
    price: '109.00',
    stock: 35,
  },
  {
    id: '0b000000-0000-4000-8000-000000000b28',
    categoryId: CATEGORIES[2].id,
    name: 'CalDigit TS4 Dock',
    sku: 'SEED-ACC-003',
    description: '18 ports, 98W charging.',
    price: '399.00',
    // ZERO ON PURPOSE. The "out of stock" path needs a product that is out
    // of stock, and creating one by hand every time is the sort of friction
    // that stops people testing it.
    stock: 0,
  },
];

const ADMIN = {
  id: '0c000000-0000-4000-8000-000000000c31',
  email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

/**
 * A guard, not a formality.
 *
 * This seeder creates an ADMIN ACCOUNT with a known password. That is
 * exactly right on a laptop and a privilege-escalation hole anywhere else,
 * so the default is refusal and the override has to be typed deliberately.
 */
function assertSeedingIsAllowed() {
  const environment = process.env.NODE_ENV ?? 'development';

  if (environment === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error(
      'refusing to seed with NODE_ENV=production. ' +
        'This creates an admin account with a known password. ' +
        'Set SEED_ALLOW_PRODUCTION=true only if you are certain.',
    );
  }
}

/** The admin password. Weak by default, and loud about it. */
function adminPassword() {
  const supplied = process.env.SEED_ADMIN_PASSWORD;

  if (supplied !== undefined && supplied !== '') {
    return supplied;
  }

  console.warn(
    '  ⚠ seeding the admin with the DEFAULT password. Set SEED_ADMIN_PASSWORD to change it.',
  );
  return 'correct-horse-Battery9';
}

module.exports = {
  CATEGORIES,
  PRODUCTS,
  ADMIN,
  assertSeedingIsAllowed,
  adminPassword,
};
