'use strict';

/**
 * Creates `contacts` and `notifications`.
 *
 * WHY THIS SERVICE HAS A `contacts` TABLE AT ALL — the interesting design
 * decision in this milestone.
 *
 * To send an order confirmation you need an email address. `order.confirmed`
 * carries a `userId` and no address, because the Order Service does not have
 * one either — it only ever sees a user id. So there are three ways to get
 * from a user id to an address:
 *
 *   CALL THE AUTH SERVICE  a synchronous hop on every email. It puts Auth on
 *                          the critical path of sending a receipt, and it
 *                          means no emails at all while Auth is restarting.
 *
 *   PUT THE ADDRESS IN     every publisher would need it, so the Order and
 *   EVERY EVENT            Payment services would have to call Auth to
 *                          enrich their own events. The hop moves; it does
 *                          not go away.
 *
 *   KEEP A LOCAL COPY      this service listens to `user.registered` and
 *   (this)                 remembers the address. Sending an email needs
 *                          nothing but its own database.
 *
 * The third is a PROJECTION: a small, private read model built from events.
 * It is the standard answer to "a consumer needs data it does not own", and
 * its costs are real and worth stating. The copy can be stale — a customer
 * who changes their address gets the old one until a `user.updated` event
 * exists. And a customer who registered BEFORE this service did has no
 * contact row at all, so the notification is recorded as FAILED with a
 * reason rather than silently skipped.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'contacts',
        {
          // The user id IS the primary key. There is exactly one contact per
          // user, and a surrogate id would add a column that nothing ever
          // reads — the projection's key is the key of the thing it projects.
          user_id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
          },

          email: {
            type: Sequelize.STRING(320),
            allowNull: false,
          },

          first_name: {
            // For "Hello Ada". Not required to send anything, so the
            // template falls back to something neutral when it is missing.
            type: Sequelize.STRING(100),
            allowNull: true,
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

      // ─────────────────────────────────────────────────────────────────
      await queryInterface.createTable(
        'notifications',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          user_id: {
            // No foreign key to `contacts`, even though both live in this
            // database. A notification must survive a contact being removed
            // — "we emailed this person" is a fact about the past, and a
            // CASCADE would delete the evidence.
            type: Sequelize.UUID,
            allowNull: false,
          },

          type: {
            type: Sequelize.STRING(30),
            allowNull: false,
          },

          status: {
            type: Sequelize.STRING(20),
            allowNull: false,
          },

          recipient: {
            // Recorded per notification rather than joined from `contacts`,
            // because the address the email WENT TO is a fact and the
            // contact's current address is not. Same snapshot reasoning as a
            // cart line's price.
            type: Sequelize.STRING(320),
            allowNull: false,
          },

          subject: {
            type: Sequelize.STRING(200),
            allowNull: false,
          },

          body: {
            // Kept, so "what did we actually send them?" is answerable. It
            // is the same argument as the stock ledger: without the content,
            // a record that an email was sent tells you very little.
            type: Sequelize.TEXT,
            allowNull: false,
          },

          failure_reason: {
            type: Sequelize.TEXT,
            allowNull: true,
          },

          sent_at: {
            type: Sequelize.DATE,
            allowNull: true,
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

      // "What have we sent this customer?" — the support query.
      await queryInterface.sequelize.query(
        `CREATE INDEX "notifications_user_created_idx"
           ON "notifications" (user_id, created_at DESC)`,
        { transaction },
      );

      // "What failed?" — the operational one. Partial, because the failures
      // are the small minority and they are all anyone ever looks for.
      await queryInterface.sequelize.query(
        `CREATE INDEX "notifications_failed_idx"
           ON "notifications" (created_at DESC)
           WHERE status = 'FAILED'`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "notifications"
           ADD CONSTRAINT "notifications_status_check"
           CHECK (status IN ('SENT', 'FAILED'))`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "notifications"
           ADD CONSTRAINT "notifications_type_check"
           CHECK (type IN ('WELCOME', 'ORDER_CONFIRMED', 'PAYMENT_RECEIPT'))`,
        { transaction },
      );

      // ─────────────────────────────────────────────────────────────────
      // WHAT IS DELIBERATELY MISSING, and this one is the point of the
      // milestone:
      //
      //   CREATE TABLE processed_events (event_id uuid PRIMARY KEY, ...)
      //
      // RabbitMQ delivers at-least-once, so every handler here WILL
      // eventually run twice for the same message. Everywhere else in this
      // system that was survivable by making the operation naturally
      // repeatable — `UPDATE carts SET status='CONVERTED' WHERE status='ACTIVE'`
      // does nothing the second time.
      //
      // SENDING AN EMAIL CANNOT BE MADE REPEATABLE. There is no WHERE clause
      // that un-sends one. The customer simply receives two receipts.
      //
      // That is why a ledger of processed event ids finally earns its place
      // here rather than three milestones ago — and it needs the events to
      // carry an id, which they do not yet. Both arrive in pass 2, after the
      // duplicate has been seen.
      // ─────────────────────────────────────────────────────────────────
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('notifications', { transaction });
      await queryInterface.dropTable('contacts', { transaction });
    });
  },
};
