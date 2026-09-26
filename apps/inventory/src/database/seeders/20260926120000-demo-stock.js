'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('node:path');

const { PRODUCTS, assertSeedingIsAllowed } = require(
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'tools', 'seed-data.js'),
);

/**
 * Stock for the demo catalogue.
 *
 * THE PRODUCT IDs COME FROM THE SAME FILE the Product Service seeded from,
 * and nothing here reads the product database — it cannot, and must not. The
 * two services own different databases with different credentials, so the
 * only thing that keeps `inventory_items.product_id` pointing at a real
 * product is that both seeders were told the same ids up front.
 *
 * That is not a shortcut. It is the same arrangement the running system
 * uses: the Cart Service holds a `product_id` it got from an event, with no
 * foreign key behind it, and is responsible for coping when the product is
 * gone. A seeder that reached across to look up ids would be teaching the
 * opposite of how this system works.
 *
 * TWO ROWS PER PRODUCT, not one. Every stock change in this system is
 * recorded in the append-only `stock_movements` ledger, and seeding the
 * quantity without the movement would create exactly the thing the ledger
 * exists to make impossible: stock that is there with no record of how it
 * arrived. The demo data has to obey the rules the application obeys.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    assertSeedingIsAllowed();

    const now = new Date();

    // Deterministic ids again, derived from the product id so the inventory
    // row and its opening movement can both be recognised and both removed
    // by `down` without a lookup.
    const items = PRODUCTS.map((product) => ({
      id: product.id.replace('0b0000', '0d0000'),
      product_id: product.id,
      sku: product.sku,
      quantity_on_hand: product.stock,
      quantity_reserved: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    }));

    const movements = items
      // A product seeded with zero stock gets no RECEIVE movement, because
      // nothing was received. An empty ledger entry for a delivery that did
      // not happen would be a lie in the audit trail.
      .filter((item) => item.quantity_on_hand > 0)
      .map((item) => ({
        id: item.id.replace('0d0000', '0e0000'),
        inventory_item_id: item.id,
        type: 'RECEIVE',
        quantity: item.quantity_on_hand,
        reference: 'seed:opening-stock',
        on_hand_after: item.quantity_on_hand,
        reserved_after: 0,
        created_at: now,
      }));

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.bulkInsert('inventory_items', items, {
        transaction,
        ignoreDuplicates: true,
      });
      await queryInterface.bulkInsert('stock_movements', movements, {
        transaction,
        ignoreDuplicates: true,
      });
    });

    console.log(
      `  seeded stock for ${items.length} products (${movements.length} opening movements)`,
    );
  },

  async down(queryInterface) {
    const { Op } = queryInterface.sequelize.Sequelize;
    const itemIds = PRODUCTS.map((p) => p.id.replace('0b0000', '0d0000'));

    await queryInterface.sequelize.transaction(async (transaction) => {
      // Movements first: they reference the items.
      await queryInterface.bulkDelete(
        'stock_movements',
        { inventory_item_id: { [Op.in]: itemIds } },
        { transaction },
      );
      await queryInterface.bulkDelete(
        'inventory_items',
        { id: { [Op.in]: itemIds } },
        { transaction },
      );
    });
  },
};
