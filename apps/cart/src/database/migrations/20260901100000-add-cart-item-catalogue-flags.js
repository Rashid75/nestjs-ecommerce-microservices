'use strict';

/**
 * Adds catalogue-change flags to cart lines.
 *
 * These do NOT change the snapshot. A price change must not silently reprice
 * a basket the customer is looking at — it marks the line so the UI can say
 * "the price of this item has changed" and so checkout can re-confirm.
 *
 * Snapshot what the customer was shown; flag what moved; re-check before
 * taking money.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'cart_items',
        'catalogue_price',
        {
          // What the catalogue says NOW, captured when the event arrived.
          // Stored ALONGSIDE `unit_price` rather than overwriting it, so the
          // UI can show both — "was 19.99, now 24.99" — which is the only
          // honest way to present a price change.
          type: Sequelize.DECIMAL(12, 2),
          allowNull: true,
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'cart_items',
        'unavailable_at',
        {
          // Set when the product is archived. The line STAYS in the cart:
          // silently removing an item is more alarming to a customer than
          // showing it greyed out with an explanation.
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('cart_items', 'unavailable_at', {
        transaction,
      });
      await queryInterface.removeColumn('cart_items', 'catalogue_price', {
        transaction,
      });
    });
  },
};
