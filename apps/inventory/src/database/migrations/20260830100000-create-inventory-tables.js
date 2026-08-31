'use strict';

/**
 * Creates `inventory_items` and `stock_movements`.
 *
 * Both in ONE transaction and one migration, because they are one design: a
 * balance and the ledger that explains it. Applying the balance without the
 * ledger would leave a window in which stock could change with no audit
 * trail, and there is no useful state where only one of them exists.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // -----------------------------------------------------------------
      // inventory_items — the CURRENT position, one row per product.
      // -----------------------------------------------------------------
      await queryInterface.createTable(
        'inventory_items',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          product_id: {
            // NO FOREIGN KEY, and this is the most important line in the file.
            //
            // `products` lives in ecommerce_product_db. This table lives in
            // ecommerce_inventory_db. PostgreSQL cannot enforce referential
            // integrity across databases, and that is not a limitation we are
            // working around — it is the POINT of database-per-service.
            //
            // What we give up: the database can no longer guarantee this id
            // refers to a real product. An inventory row can outlive its
            // product.
            //
            // What we get: the Product Service can change its schema, split
            // in two, or be rewritten, without a lock in its database ever
            // blocking a write in ours. The two services fail independently.
            //
            // Consistency becomes EVENTUAL and the application's job:
            // validate on write where it is cheap, reconcile periodically,
            // and react to ProductDeleted events once RabbitMQ exists.
            type: Sequelize.UUID,
            allowNull: false,
          },

          sku: {
            // DENORMALISED from the Product Service, deliberately.
            //
            // Duplicated data is normally a smell. Here it buys operational
            // independence: a warehouse operator reading this table, or an
            // engineer debugging at 3am, should not need a second service to
            // be reachable in order to know what a row refers to.
            //
            // The cost is that a SKU renamed in the catalogue is stale here
            // until an event updates it. That is acceptable because nothing
            // reads this column to make a decision — it is a label, not a key.
            type: Sequelize.STRING(64),
            allowNull: false,
          },

          quantity_on_hand: {
            // Physically in the warehouse.
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },

          quantity_reserved: {
            // Promised to pending orders. Physically still present, but not
            // available to anyone else.
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },

          version: {
            // OPTIMISTIC LOCKING counter, incremented on every write.
            //
            // Not used by the reserve path — that uses a single atomic
            // conditional UPDATE, which needs no version. It exists for
            // read-modify-write flows where a human holds a form open for
            // thirty seconds: you cannot hold a row lock that long, so
            // instead you re-check `WHERE version = :seen` and reject the
            // write if someone else got there first.
            //
            // Pessimistic locking blocks writers. Optimistic locking lets
            // them race and makes the loser retry. Which is right depends
            // entirely on how likely a collision is.
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
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

      // One inventory row per product. This uniqueness is also what makes an
      // upsert (`ON CONFLICT (product_id)`) possible.
      await queryInterface.addIndex('inventory_items', {
        name: 'inventory_items_product_id_unique',
        fields: ['product_id'],
        unique: true,
        transaction,
      });

      await queryInterface.addIndex('inventory_items', {
        name: 'inventory_items_sku_idx',
        fields: ['sku'],
        transaction,
      });

      // -----------------------------------------------------------------
      // THE INVARIANTS.
      //
      // These three CHECK constraints are the real safety net, and they are
      // worth more than any amount of application logic — because they hold
      // for EVERY writer. A bug in this service, a well-meaning psql UPDATE,
      // a data-fix script written under time pressure at 2am: all of them
      // are stopped by the database.
      //
      // Application validation only protects callers that go through the
      // application. That is a strictly smaller set than "everyone".
      // -----------------------------------------------------------------

      // You cannot have less than nothing in a warehouse.
      await queryInterface.sequelize.query(
        `ALTER TABLE "inventory_items"
           ADD CONSTRAINT "inventory_on_hand_non_negative"
           CHECK (quantity_on_hand >= 0)`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "inventory_items"
           ADD CONSTRAINT "inventory_reserved_non_negative"
           CHECK (quantity_reserved >= 0)`,
        { transaction },
      );

      // THE ANTI-OVERSELLING INVARIANT.
      //
      // You cannot promise more than you physically hold. If every other
      // control in this codebase fails — the availability check, the atomic
      // UPDATE, the transaction — this constraint still makes the database
      // refuse the write, and the request fails loudly instead of quietly
      // selling stock that does not exist.
      //
      // Defence in depth: the last line, and the only one that cannot be
      // bypassed.
      await queryInterface.sequelize.query(
        `ALTER TABLE "inventory_items"
           ADD CONSTRAINT "inventory_reserved_not_over_on_hand"
           CHECK (quantity_reserved <= quantity_on_hand)`,
        { transaction },
      );

      // -----------------------------------------------------------------
      // stock_movements — the APPEND-ONLY ledger.
      //
      // Why keep one at all, when inventory_items already holds the answer?
      //
      // Because "we have 3 units" is not an answer to "why do we have 3?".
      // A balance with no history cannot be audited, cannot be reconciled
      // against a physical count, and cannot tell you whether a discrepancy
      // came from a bug, a mis-scan or theft. Every real inventory,
      // accounting and banking system is a ledger with a cached balance —
      // never a balance alone.
      //
      // It is also where idempotency will live in Milestone 8: "have I
      // already reserved stock for order X?" is a question only the ledger
      // can answer.
      // -----------------------------------------------------------------
      await queryInterface.createTable(
        'stock_movements',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          inventory_item_id: {
            type: Sequelize.UUID,
            allowNull: false,
            // A foreign key IS used here, because both tables live in this
            // database. RESTRICT: an inventory row with history must not
            // simply vanish.
            references: { model: 'inventory_items', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },

          type: {
            type: Sequelize.STRING(20),
            allowNull: false,
          },

          quantity: {
            // SIGNED. A RELEASE stores −3, a RECEIVE stores +10. Summing the
            // column then reconstructs the balance, which is what makes
            // reconciliation possible: SUM(quantity) over the right movement
            // types must equal the stored figure. If they disagree, the
            // ledger is right and the balance is the bug.
            type: Sequelize.INTEGER,
            allowNull: false,
          },

          reference: {
            // What caused it — an order id, a purchase order, a ticket.
            type: Sequelize.STRING(200),
            allowNull: true,
          },

          on_hand_after: {
            // The resulting balances, captured at write time.
            //
            // Redundant in the sense that they could be recomputed by
            // replaying the ledger. Stored anyway because reading "what did
            // this row look like immediately after that movement?" during an
            // incident should be a SELECT, not a fold over history.
            type: Sequelize.INTEGER,
            allowNull: false,
          },
          reserved_after: {
            type: Sequelize.INTEGER,
            allowNull: false,
          },

          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('now()'),
          },
        },
        { transaction },
      );

      // The ledger is read as "the history of this item, newest first".
      await queryInterface.sequelize.query(
        `CREATE INDEX "stock_movements_item_created_idx"
           ON "stock_movements" (inventory_item_id, created_at DESC)`,
        { transaction },
      );

      // Answers "what happened to order X?" across all items.
      await queryInterface.sequelize.query(
        `CREATE INDEX "stock_movements_reference_idx"
           ON "stock_movements" (reference)
           WHERE reference IS NOT NULL`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "stock_movements"
           ADD CONSTRAINT "stock_movements_type_check"
           CHECK (type IN ('RECEIVE', 'RESERVE', 'RELEASE', 'FULFIL', 'ADJUST'))`,
        { transaction },
      );

      // A movement of zero units is not a movement. Refusing it keeps the
      // ledger free of rows that record nothing.
      await queryInterface.sequelize.query(
        `ALTER TABLE "stock_movements"
           ADD CONSTRAINT "stock_movements_quantity_non_zero"
           CHECK (quantity <> 0)`,
        { transaction },
      );

      // NOTE: nothing here prevents an UPDATE or DELETE on this table. A
      // truly append-only ledger needs a database ROLE without those
      // privileges, or a trigger that raises on them. That is a deployment
      // concern rather than a schema one, and it belongs with the wider
      // least-privilege work — but "append-only by convention" is worth
      // naming as weaker than "append-only by permission".
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Child first: stock_movements holds the foreign key, so dropping
      // inventory_items ahead of it would fail on the dependency.
      await queryInterface.dropTable('stock_movements', { transaction });
      await queryInterface.dropTable('inventory_items', { transaction });
    });
  },
};
