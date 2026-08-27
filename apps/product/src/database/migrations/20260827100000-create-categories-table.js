'use strict';

/**
 * Creates the `categories` table.
 *
 * One transaction, for the same reason as every migration in this project:
 * PostgreSQL supports transactional DDL and sequelize-cli does not add one
 * for you, so without it a failure partway through leaves a schema that
 * `SequelizeMeta` has no record of.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'categories',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },
          name: {
            type: Sequelize.STRING(120),
            allowNull: false,
          },
          slug: {
            // Appears in public URLs, so it gets the narrowest alphabet we
            // can enforce and its own uniqueness guarantee.
            type: Sequelize.STRING(140),
            allowNull: false,
          },
          description: {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          is_active: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: true,
          },
          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('now()'),
          },
          updated_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('now()'),
          },
          deleted_at: {
            // NULL means live. Soft delete, because products reference
            // categories and — once orders exist — so will order history.
            // Hard-deleting a row that other records point at is how you get
            // an order whose product belongs to a category that no longer
            // exists.
            type: Sequelize.DATE,
            allowNull: true,
          },
        },
        { transaction },
      );

      // PARTIAL unique index: uniqueness applies to LIVE categories only, so
      // a soft-deleted 'laptops' does not reserve that slug forever.
      //
      // The consequence to remember: any lookup by slug must also filter
      // `deleted_at IS NULL`, because several soft-deleted rows may share a
      // slug. Sequelize's `paranoid: true` adds that filter automatically —
      // but raw SQL will not.
      await queryInterface.addIndex('categories', {
        name: 'categories_slug_live_unique',
        fields: ['slug'],
        unique: true,
        where: { deleted_at: null },
        transaction,
      });

      await queryInterface.addIndex('categories', {
        name: 'categories_name_live_unique',
        fields: ['name'],
        unique: true,
        where: { deleted_at: null },
        transaction,
      });

      // Raw SQL because expressing `lower(slug)` through the queryInterface
      // constraint serialiser is fragile and obscures what actually runs.
      // The unique index above is case-SENSITIVE, so without this constraint
      // 'Laptops' and 'laptops' would be two distinct slugs pointing at what
      // a shopper reads as the same URL.
      await queryInterface.sequelize.query(
        `ALTER TABLE "categories"
           ADD CONSTRAINT "categories_slug_lowercase_check"
           CHECK (slug = lower(slug))`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Dropping the table drops its indexes and constraints with it — they
      // are dependent objects. This will FAIL while `products` still has a
      // foreign key to it, which is correct: migrations must be reversed in
      // the opposite order to how they were applied.
      await queryInterface.dropTable('categories', { transaction });
    });
  },
};
