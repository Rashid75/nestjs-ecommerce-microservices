'use strict';

/**
 * Creates the `products` table, its foreign key to `categories`, and the four
 * indexes that make the listing endpoint's queries cheap.
 *
 * Everything in one transaction. A products table without its unique SKU
 * index is not a partially-useful schema — it is a schema that lets duplicate
 * SKUs in, which is a data-integrity problem you then have to clean up by
 * hand.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'products',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },
          name: {
            type: Sequelize.STRING(200),
            allowNull: false,
          },
          description: {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          sku: {
            // Stock Keeping Unit — the warehouse's identifier for this item.
            // Uppercase-normalised and unique among live products.
            type: Sequelize.STRING(64),
            allowNull: false,
          },
          price: {
            // DECIMAL(12,2), NOT double precision, NOT float, NOT real.
            //
            // Floating point cannot represent 19.99 exactly. Sum a thousand
            // such prices and the total drifts; multiply by a quantity and
            // round, and a cart total disagrees with the sum of its lines by
            // a cent. That bug reaches an accountant before it reaches an
            // engineer, and it is unfixable without a data migration.
            //
            // NUMERIC in PostgreSQL is arbitrary-precision base-10 arithmetic
            // — slower than a double and completely exact, which is the
            // correct trade for money.
            //
            // 12,2 allows up to 9,999,999,999.99.
            type: Sequelize.DECIMAL(12, 2),
            allowNull: false,
          },
          currency: {
            // ISO 4217. Fixed-length CHAR would pad; VARCHAR(3) plus a CHECK
            // says exactly what we mean.
            type: Sequelize.STRING(3),
            allowNull: false,
            defaultValue: 'USD',
          },
          status: {
            // VARCHAR + CHECK rather than a native ENUM, for the same reason
            // as users.role: this list will grow, and a CHECK constraint is
            // dropped and recreated in one statement.
            type: Sequelize.STRING(20),
            allowNull: false,
            // DRAFT, so nothing goes on sale by accident. A default of
            // ACTIVE means a half-finished import is immediately purchasable.
            defaultValue: 'DRAFT',
          },
          category_id: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'categories', key: 'id' },
            // RESTRICT, not CASCADE.
            //
            // CASCADE would mean deleting a category silently deletes every
            // product in it — and, once orders exist, orphans their line
            // items. RESTRICT makes the database refuse, forcing whoever
            // wants the category gone to decide what happens to its products
            // first. Referential integrity should be loud.
            onDelete: 'RESTRICT',
            // A UUID primary key never changes, so this is belt and braces.
            onUpdate: 'CASCADE',
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
            // Soft delete. DELETE /products/:id sets this rather than
            // removing the row, because order history, invoices and analytics
            // will keep referencing the product long after it stops being
            // sold. See also ProductStatus.ARCHIVED, which is what you
            // usually want instead of deleting at all.
            type: Sequelize.DATE,
            allowNull: true,
          },
        },
        { transaction },
      );

      // ---------------------------------------------------------------
      // Indexes. Each one exists for a specific query, and each one costs
      // write throughput and disk — an index is maintained on every INSERT,
      // UPDATE and DELETE. "Index every column" is as wrong as "index
      // nothing".
      // ---------------------------------------------------------------

      // 1. SKU uniqueness among live products. Partial, so a soft-deleted
      //    product does not reserve its SKU forever.
      await queryInterface.addIndex('products', {
        name: 'products_sku_live_unique',
        fields: ['sku'],
        unique: true,
        where: { deleted_at: null },
        transaction,
      });

      // 2. The foreign key column.
      //
      //    PostgreSQL creates an index for a PRIMARY KEY and for a UNIQUE
      //    constraint, but NOT for a FOREIGN KEY. This surprises almost
      //    everyone. Without it, `WHERE category_id = ?` is a sequential
      //    scan, and — less obviously — every DELETE on `categories` must
      //    scan all of `products` to enforce RESTRICT.
      await queryInterface.addIndex('products', {
        name: 'products_category_id_idx',
        fields: ['category_id'],
        transaction,
      });

      // 3. The default listing query: filter by status, newest first.
      //
      //    A COMPOSITE index, and column order matters. (status, created_at)
      //    can serve "status = ACTIVE ORDER BY created_at DESC" and also
      //    "status = ACTIVE" alone, because a b-tree can use any leading
      //    prefix of its columns. The reverse order, (created_at, status),
      //    could not serve a status filter at all.
      //
      //    DESC is written explicitly so the index order matches the query's
      //    ORDER BY and PostgreSQL can walk it without a sort step.
      await queryInterface.sequelize.query(
        `CREATE INDEX "products_status_created_at_idx"
           ON "products" (status, created_at DESC)
           WHERE deleted_at IS NULL`,
        { transaction },
      );

      // 4. Price range filters and price sorting.
      await queryInterface.sequelize.query(
        `CREATE INDEX "products_price_idx"
           ON "products" (price)
           WHERE deleted_at IS NULL`,
        { transaction },
      );

      // NOT created: an index for the `search` parameter.
      //
      // Search uses ILIKE '%term%'. A leading wildcard means a b-tree index
      // cannot be used — b-trees are ordered by prefix, and there is no
      // prefix to seek to. So `search` is a sequential scan today, which is
      // fine for a catalogue of thousands and not fine for millions.
      //
      // The fix, when it is needed, is a GIN index with the pg_trgm
      // extension (good to ~millions of rows), and beyond that Elasticsearch.
      // The trigger is measurable latency on this endpoint, not a hunch.

      // ---------------------------------------------------------------
      // CHECK constraints. These hold for EVERY writer — this service, psql,
      // a future data-fix script — which application validation cannot.
      // ---------------------------------------------------------------

      await queryInterface.sequelize.query(
        `ALTER TABLE "products"
           ADD CONSTRAINT "products_status_check"
           CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'))`,
        { transaction },
      );

      // A negative price is never a valid state. Note it permits 0, which is
      // a legitimate price for a free item.
      await queryInterface.sequelize.query(
        `ALTER TABLE "products"
           ADD CONSTRAINT "products_price_non_negative_check"
           CHECK (price >= 0)`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "products"
           ADD CONSTRAINT "products_sku_uppercase_check"
           CHECK (sku = upper(sku))`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "products"
           ADD CONSTRAINT "products_currency_format_check"
           CHECK (currency ~ '^[A-Z]{3}$')`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('products', { transaction });
    });
  },
};
