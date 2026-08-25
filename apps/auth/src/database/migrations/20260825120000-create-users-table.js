'use strict';

/**
 * Creates the `users` table owned by the Auth Service.
 *
 * Everything runs inside ONE transaction. PostgreSQL supports transactional
 * DDL, and sequelize-cli does NOT wrap a migration in a transaction for you.
 * Without it, a failure in the third statement would leave the table created
 * but un-indexed — a half-applied migration that SequelizeMeta never records,
 * so re-running fails on "relation already exists" and you are left repairing
 * it by hand.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'users',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            // A DATABASE-side default, not Sequelize.UUIDV4. A default in the
            // database is true for every writer — the application, psql, a
            // future data-fix script — not just for this ORM.
            //
            // gen_random_uuid() is built into PostgreSQL 13+; on older
            // versions it needs the pgcrypto extension.
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          email: {
            // 320 = 64-character local part + '@' + 255-character domain, the
            // maximum a valid address can occupy.
            type: Sequelize.STRING(320),
            allowNull: false,
          },

          password_hash: {
            // 255 rather than bcrypt's exact 60, so switching to argon2 or
            // scrypt later does not require a migration on the credential
            // column.
            type: Sequelize.STRING(255),
            allowNull: false,
          },

          first_name: {
            type: Sequelize.STRING(100),
            allowNull: false,
          },

          last_name: {
            type: Sequelize.STRING(100),
            allowNull: false,
          },

          role: {
            // VARCHAR + CHECK, NOT a native PostgreSQL ENUM type, and this is
            // a deliberate trade-off.
            //
            // A native enum gives a slightly tighter type and one byte less
            // storage. The cost is evolution: adding a value means ALTER TYPE
            // ... ADD VALUE, removing or renaming one means creating a new
            // type, rewriting every dependent column and dropping the old
            // type. Sequelize's own enum migrations are notoriously awkward
            // for exactly this reason.
            //
            // A CHECK constraint is dropped and recreated in one statement.
            // For a list that will grow (SUPPORT, VENDOR, ...), that matters
            // more than one byte per row.
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: 'CUSTOMER',
          },

          is_active: {
            // Lets an account be disabled without deleting the row, so orders
            // and audit history keep their foreign keys. Deleting a user in a
            // system with financial records is almost never the right answer.
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: true,
          },

          created_at: {
            // Sequelize.DATE maps to TIMESTAMP WITH TIME ZONE on postgres.
            // Storing an offset-naive timestamp is how you get a one-hour bug
            // twice a year.
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

      // Uniqueness of the login identity, enforced by the DATABASE.
      //
      // Application-level "check then insert" cannot do this: two concurrent
      // registrations both pass the check, and both insert. Only a unique
      // index makes the second one fail. The service catches that failure and
      // turns it into a 409 — see users.repository.ts.
      //
      // A unique INDEX rather than a unique CONSTRAINT because an index can
      // later be made partial (`WHERE deleted_at IS NULL`) if soft deletes
      // arrive, without dropping and rebuilding a constraint.
      await queryInterface.addIndex('users', {
        name: 'users_email_unique',
        fields: ['email'],
        unique: true,
        transaction,
      });

      // Raw SQL on purpose. queryInterface.addConstraint({ type: 'check' })
      // expects a where-object, and expressing `lower(email)` through that
      // serialiser is fragile and obscures the result. In this project the
      // statement IS the source of truth.
      //
      // Why it exists: the unique index above is case-SENSITIVE, so without
      // this constraint 'Ada@example.com' and 'ada@example.com' would be two
      // different accounts. The DTO lowercases on the way in; this constraint
      // guarantees it for every writer, including psql.
      await queryInterface.sequelize.query(
        `ALTER TABLE "users"
           ADD CONSTRAINT "users_email_lowercase_check"
           CHECK (email = lower(email))`,
        { transaction },
      );

      // The role whitelist. Keeping it in the database means a bug in any
      // service cannot write 'SUPERADMIN' into this column.
      await queryInterface.sequelize.query(
        `ALTER TABLE "users"
           ADD CONSTRAINT "users_role_check"
           CHECK (role IN ('CUSTOMER', 'ADMIN'))`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Dropping the table also drops its indexes and constraints — they are
      // dependent objects, so enumerating them here would be redundant rather
      // than safer.
      await queryInterface.dropTable('users', { transaction });
    });
  },
};
