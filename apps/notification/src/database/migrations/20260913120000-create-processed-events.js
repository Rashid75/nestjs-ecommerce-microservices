'use strict';

/**
 * Creates `processed_events`.
 *
 * ONE TABLE, ONE COLUMN THAT MATTERS, and it took ten milestones to need it.
 *
 * RabbitMQ delivers AT LEAST ONCE. Every consumer in this system has always
 * had to survive being handed the same message twice, and until now each of
 * them did it the cheap way — by being naturally repeatable:
 *
 *   UPDATE carts  SET status = 'CONVERTED' WHERE status = 'ACTIVE'
 *   UPDATE orders SET status = 'PAID'      WHERE status = 'CONFIRMED'
 *
 * Run either of those a second time and it updates nothing. Neither consumer
 * has to know it has seen the message before, so neither needs a ledger.
 * That is always the first thing to reach for, and it is free.
 *
 * SENDING AN EMAIL CANNOT BE MADE REPEATABLE. There is no WHERE clause that
 * un-sends one. The customer receives two receipts, and no amount of clever
 * SQL prevents it — the side effect is outside the database entirely.
 *
 * So this consumer has to RECOGNISE the repeat instead, which means
 * remembering what it has already handled. That is all this table is: a set
 * of event ids, with the id as the primary key so that recognising a repeat
 * is an INSERT that fails rather than a SELECT that might race.
 *
 * WHY NOT PUT THIS IN EVERY SERVICE. Because a ledger is not free. It is a
 * row per event forever, a write on the hot path of every message, and a
 * cleanup job nobody remembers to write. Adding it where a conditional
 * UPDATE already does the job would be paying for a guarantee you already
 * have.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('processed_events', {
      event_id: {
        // THE PRIMARY KEY IS THE POINT.
        //
        // Deduplicating with `SELECT ... IF NOT FOUND THEN INSERT` is the
        // same check-then-act race as every other one in this project: two
        // deliveries handled concurrently by two replicas would both find
        // nothing and both send. A primary key makes the second INSERT fail,
        // and the database is the only thing here that is actually atomic.
        type: Sequelize.UUID,
        allowNull: false,
        primaryKey: true,
      },

      pattern: {
        // Which event it was — `order.confirmed` and so on. Not needed to
        // deduplicate; kept because a bare list of UUIDs is unreadable when
        // you are trying to work out what a consumer has been doing.
        type: Sequelize.STRING(100),
        allowNull: false,
      },

      handled_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('now()'),
      },
    });

    // Supports the cleanup that does not exist yet: "delete everything older
    // than the broker could possibly still be holding". Without a retention
    // sweep this table grows forever — one row per event, permanently — and
    // that is recorded as deferred with disk pressure as its trigger.
    await queryInterface.sequelize.query(
      `CREATE INDEX "processed_events_handled_at_idx"
         ON "processed_events" (handled_at)`,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('processed_events');
  },
};
