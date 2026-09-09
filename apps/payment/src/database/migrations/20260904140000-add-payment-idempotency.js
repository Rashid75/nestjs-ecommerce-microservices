'use strict';

/**
 * Adds `idempotency_key`, and the two indexes that stop a customer being
 * charged twice.
 *
 * TWO INDEXES, BECAUSE THERE ARE TWO DIFFERENT PROBLEMS. This is the whole
 * lesson of the milestone, and the reason it was worth reproducing the
 * double charge first.
 *
 *   payments_one_active_per_order
 *     "this order already has a payment in flight, or a successful one."
 *     It REFUSES the second attempt — and it refuses it at INSERT time,
 *     before the provider is called, so nothing is charged.
 *
 *   payments_user_idempotency_key
 *     "you have sent me this exact request before."
 *     It does not refuse anything. It lets the service find the FIRST
 *     attempt and return its answer, which is what a client that never
 *     found out what happened actually needs.
 *
 * A client whose request timed out does not want a 409. It wants to know
 * whether it was charged. Only the key can answer that.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'payments',
        'idempotency_key',
        {
          // Chosen by the client, so its length is bounded here and its
          // shape is validated at the edge. NULL is allowed: a client that
          // sends no key is not refused, only less protected.
          type: Sequelize.STRING(100),
          allowNull: true,
        },
        { transaction },
      );

      // THE REPLAY INDEX.
      //
      // Partial, so the many payments made without a key do not all collide
      // on NULL — and PostgreSQL would in fact allow that, since NULLs are
      // distinct in a unique index, but a partial index also keeps the
      // index small and says the intent out loud.
      //
      // Scoped to the USER as well as the key. Keys are chosen by clients
      // and two clients will eventually choose the same string; without the
      // user in the index, one customer's retry could return another
      // customer's payment.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "payments_user_idempotency_key"
           ON "payments" (user_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL`,
        { transaction },
      );

      // THE DOUBLE-CHARGE INDEX.
      //
      // At most one payment per order that is either IN FLIGHT or SUCCEEDED.
      //
      // Why PENDING is in the list, and it is the more interesting half: a
      // payment whose outcome is unknown must block another attempt. The
      // provider may still be settling it. Charging again "because the first
      // one seems stuck" is precisely how a customer ends up paying twice,
      // and it is a very tempting thing to do.
      //
      // DECLINED and FAILED are NOT in the list, deliberately: after a
      // refusal or a definite error the customer must be able to try again,
      // with another card or after the provider recovers. That is the
      // commonest thing that happens after a decline.
      //
      // The cost, stated plainly: a payment stuck in PENDING blocks its
      // order forever, because nothing reconciles them yet. That is the
      // right failure — it is safer to need a human than to charge twice —
      // and the reconciliation job is recorded as deferred with this as its
      // trigger.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "payments_one_active_per_order"
           ON "payments" (order_id)
           WHERE status IN ('PENDING', 'SUCCEEDED')`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS "payments_one_active_per_order"`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS "payments_user_idempotency_key"`,
        { transaction },
      );
      await queryInterface.removeColumn('payments', 'idempotency_key', {
        transaction,
      });
    });
  },
};
