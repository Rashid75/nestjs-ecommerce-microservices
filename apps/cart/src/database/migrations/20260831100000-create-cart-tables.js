'use strict';

/**
 * Creates `carts` and `cart_items`.
 *
 * WHY POSTGRESQL AND NOT REDIS — the decision this milestone is really about.
 *
 * "Carts are ephemeral, Redis is fast, and Redis has TTLs" is the standard
 * argument, and it is wrong often enough to be worth taking apart.
 *
 *   DURABILITY. Redis persistence is asynchronous. RDB snapshots lose
 *   everything since the last one; AOF with the default `everysec` loses up
 *   to a second. For a session token that is fine. A cart is a customer's
 *   stated purchase intent — the single most valuable pre-revenue signal a
 *   shop has — and losing one loses the sale.
 *
 *   QUERYABILITY. "Which carts contain the product we just discontinued?"
 *   "Send an email to everyone with a cart older than a day." "What is the
 *   average basket value this week?" Every one of those is a WHERE clause in
 *   PostgreSQL and a full keyspace scan in Redis. Abandoned-cart recovery is
 *   a real revenue line, and it needs the data to be queryable.
 *
 *   TRANSACTIONS. Converting a cart to an order must be atomic with marking
 *   the cart converted. Across Redis and PostgreSQL that is a distributed
 *   transaction; within one PostgreSQL database it is a BEGIN.
 *
 *   PERFORMANCE. The supposed win barely exists. A cart read is one indexed
 *   lookup plus a small join — well under a millisecond. Redis would save
 *   perhaps a few hundred microseconds on an operation that already costs
 *   less than the network hop to reach it.
 *
 * So: PostgreSQL is the source of truth. That is the whole point of "do not
 * put all cart data in Redis just because Redis is available".
 *
 * WHERE REDIS DOES BELONG. Two cases, both deferred with clear triggers:
 *
 *   GUEST CARTS — anonymous, pre-login, genuinely throwaway, with no owner
 *   to query by. A Redis hash with a TTL is a good fit, merged into the
 *   PostgreSQL cart on sign-in. Deferred because guest checkout is not in
 *   scope.
 *
 *   TOKEN INTROSPECTION — the gateway caching "is this token valid, and
 *   whose is it?" for a few seconds. That one IS implemented in this
 *   milestone, and it is the genuinely correct Redis use here.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'carts',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          user_id: {
            // The owner. No foreign key — `users` lives in
            // ecommerce_auth_db. Same reasoning as inventory → products.
            //
            // This value NEVER comes from a request body. It is taken from
            // the verified access token at the gateway and forwarded as a
            // header. A client that could name its own user id could read
            // and edit anyone's cart.
            type: Sequelize.UUID,
            allowNull: false,
          },

          status: {
            // ACTIVE    the one the customer is filling
            // CONVERTED became an order; kept for history
            // ABANDONED aged out; kept for analytics and recovery emails
            //
            // Carts are never deleted. An abandoned cart is one of the most
            // commercially useful records a shop holds.
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: 'ACTIVE',
          },

          currency: {
            // Held on the CART, not per line. A cart may not mix currencies —
            // there is no sensible subtotal for £10 plus $10 — and putting it
            // here makes that structural rather than a rule someone has to
            // remember.
            type: Sequelize.STRING(3),
            allowNull: false,
            defaultValue: 'USD',
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
        },
        { transaction },
      );

      // ONE ACTIVE CART PER USER, enforced by a PARTIAL unique index.
      //
      // This is the constraint that makes "get or create my cart" safe. Two
      // simultaneous first-requests from the same user would otherwise both
      // find nothing and both insert — the same check-then-act race as
      // everywhere else in this project. The index makes the loser fail, and
      // the repository turns that failure into "fetch the one that won".
      //
      // Partial (`WHERE status = 'ACTIVE'`) so a user may accumulate any
      // number of CONVERTED and ABANDONED carts over time while holding at
      // most one live one.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "carts_one_active_per_user"
           ON "carts" (user_id)
           WHERE status = 'ACTIVE'`,
        { transaction },
      );

      // Supports the abandonment sweep: "active carts not touched since X".
      await queryInterface.sequelize.query(
        `CREATE INDEX "carts_status_updated_idx"
           ON "carts" (status, updated_at)`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "carts"
           ADD CONSTRAINT "carts_status_check"
           CHECK (status IN ('ACTIVE', 'CONVERTED', 'ABANDONED'))`,
        { transaction },
      );

      // -----------------------------------------------------------------
      await queryInterface.createTable(
        'cart_items',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          cart_id: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'carts', key: 'id' },
            // CASCADE here, unlike everywhere else in this project.
            //
            // A cart line has no meaning without its cart — it is not an
            // independent record the way a product or an order is. Contrast
            // with products → categories, which is RESTRICT precisely
            // because a product outlives the category that classified it.
            //
            // The rule: CASCADE when the child is part of the parent;
            // RESTRICT when the child merely references it.
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },

          product_id: {
            // No foreign key — different database, same as everywhere.
            type: Sequelize.UUID,
            allowNull: false,
          },

          // ---- THE SNAPSHOT ----
          // Copied from the Product Service at add-time. See the long note
          // on CartItemDto: snapshot what the customer was shown, re-check
          // before taking money.
          sku: {
            type: Sequelize.STRING(64),
            allowNull: false,
          },
          name: {
            type: Sequelize.STRING(200),
            allowNull: false,
          },
          unit_price: {
            // DECIMAL, never float. 0.1 + 0.2 !== 0.3, and a cart subtotal
            // that disagrees with the sum of its lines by a cent is a bug
            // that reaches an accountant before an engineer.
            type: Sequelize.DECIMAL(12, 2),
            allowNull: false,
          },

          quantity: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 1,
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
        },
        { transaction },
      );

      // ONE LINE PER PRODUCT PER CART.
      //
      // This is what makes "add to cart" an UPSERT rather than an INSERT:
      // adding a product already in the cart must increase its quantity, not
      // create a second line. The index makes the alternative impossible
      // rather than merely discouraged.
      await queryInterface.addIndex('cart_items', {
        name: 'cart_items_cart_product_unique',
        fields: ['cart_id', 'product_id'],
        unique: true,
        transaction,
      });

      await queryInterface.sequelize.query(
        `ALTER TABLE "cart_items"
           ADD CONSTRAINT "cart_items_quantity_positive"
           CHECK (quantity > 0)`,
        { transaction },
      );

      // A zero-priced line is legitimate (a free gift); a negative one never
      // is, and would let a cart subtotal be driven below zero.
      await queryInterface.sequelize.query(
        `ALTER TABLE "cart_items"
           ADD CONSTRAINT "cart_items_price_non_negative"
           CHECK (unit_price >= 0)`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('cart_items', { transaction });
      await queryInterface.dropTable('carts', { transaction });
    });
  },
};
