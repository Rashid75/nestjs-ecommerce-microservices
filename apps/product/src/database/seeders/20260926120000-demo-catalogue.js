'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('node:path');

// apps/product/src/database/seeders -> the workspace root
const {
  CATEGORIES,
  PRODUCTS,
  assertSeedingIsAllowed,
} = require(
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'tools', 'seed-data.js'),
);

/**
 * The demo catalogue: three categories and eight products.
 *
 * ACTIVE, not DRAFT. A product is created DRAFT by the API because a
 * half-written product should not appear in a shop — but a seeder whose
 * output cannot be added to a cart is a seeder you then have to fix by hand,
 * which defeats the point of it existing.
 *
 * `ignoreDuplicates` makes this IDEMPOTENT: run it twice and the second run
 * inserts nothing, because the ids are fixed (see tools/seed-data.js). It
 * translates to `ON CONFLICT DO NOTHING`, so it does not UPDATE either — if
 * you change a price in the seed file, undo and re-run rather than expecting
 * this to notice.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    assertSeedingIsAllowed();

    const now = new Date();

    // One transaction for both tables: products reference categories, so a
    // failure partway through would otherwise leave categories behind with
    // no products and a seeder that cannot be re-run cleanly.
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.bulkInsert(
        'categories',
        CATEGORIES.map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          is_active: true,
          created_at: now,
          updated_at: now,
        })),
        { transaction, ignoreDuplicates: true },
      );

      await queryInterface.bulkInsert(
        'products',
        PRODUCTS.map((product) => ({
          id: product.id,
          category_id: product.categoryId,
          name: product.name,
          sku: product.sku,
          description: product.description,
          // A STRING, straight into DECIMAL(12,2). Never a JavaScript number:
          // this is the one column in the system that has carefully avoided
          // floating point, and a seeder is a silly place to reintroduce it.
          price: product.price,
          currency: 'USD',
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        })),
        { transaction, ignoreDuplicates: true },
      );
    });

    console.log(
      `  seeded ${CATEGORIES.length} categories and ${PRODUCTS.length} products`,
    );
  },

  async down(queryInterface) {
    const { Op } = queryInterface.sequelize.Sequelize;

    // Deletes ONLY the seeded ids, never the whole table. Someone will
    // eventually run `db:seed:undo` on a database that also holds real work,
    // and a seeder that truncates is a seeder that eats it.
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.bulkDelete(
        'products',
        { id: { [Op.in]: PRODUCTS.map((p) => p.id) } },
        { transaction },
      );
      await queryInterface.bulkDelete(
        'categories',
        { id: { [Op.in]: CATEGORIES.map((c) => c.id) } },
        { transaction },
      );
    });
  },
};
