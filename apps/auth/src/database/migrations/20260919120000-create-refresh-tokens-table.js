'use strict';

/**
 * Creates `refresh_tokens`, owned by the Auth Service.
 *
 * WHY A TABLE AT ALL, when the access token is stateless by design.
 *
 * That is exactly the point. A stateless token cannot be revoked — it is
 * valid until it expires, and deleting the user does not stop it. The system
 * has lived with that by keeping access tokens to 15 minutes, which makes
 * every session expire four times an hour.
 *
 * A refresh token buys back long sessions WITHOUT buying back long-lived
 * unrevocable credentials:
 *
 *   ACCESS TOKEN   15 minutes, stateless, checked by signature. Fast, used on
 *                  every request, and unrevocable — so it is short.
 *   REFRESH TOKEN  30 days, STATEFUL, checked against this table. Used a few
 *                  times a day, and revocable by writing one row.
 *
 * The stateful half is what makes "log out everywhere" and "we think this
 * account is compromised" into operations that actually do something.
 *
 * Everything runs inside ONE transaction — PostgreSQL has transactional DDL
 * and sequelize-cli does not wrap migrations for you.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'refresh_tokens',
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },

          user_id: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            // A deleted user's sessions go with them. This is one of the few
            // places CASCADE is clearly right: a refresh token for an account
            // that no longer exists has no meaning, and leaving orphans would
            // mean the cleanup job has to know about user deletion.
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },

          /**
           * SHA-256 of the token, hex. THE TOKEN ITSELF IS NEVER STORED.
           *
           * This table is a list of live credentials. Anyone who reads it —
           * a leaked backup, a support query, a compromised read replica —
           * would otherwise be able to impersonate every user with an active
           * session, for thirty days, without touching a password.
           *
           * SHA-256 rather than bcrypt, and that is deliberate rather than
           * lazy. A password is low-entropy and human-chosen, so it needs a
           * slow hash to make guessing expensive. This token is 256 bits from
           * a CSPRNG: there is no dictionary to try and no amount of slowness
           * that matters. A fast hash is also what makes it LOOKABLE-UP —
           * bcrypt salts every row, so finding a match would mean scanning
           * the table.
           */
          token_hash: {
            type: Sequelize.CHAR(64),
            allowNull: false,
          },

          /**
           * The SESSION this token belongs to.
           *
           * Rotation issues a new token and retires the old one; both carry
           * the same family_id. That is what makes REUSE DETECTION possible:
           * if an already-rotated token is presented, someone has a copy, and
           * the whole family is revoked rather than just that row.
           *
           * Without a family, the thief's new token and the victim's new
           * token are unrelated rows and neither one tells you anything.
           */
          family_id: {
            type: Sequelize.UUID,
            allowNull: false,
          },

          expires_at: {
            type: Sequelize.DATE,
            allowNull: false,
          },

          /**
           * NULL means live. Set when the token is rotated, when the user
           * logs out, or when reuse is detected somewhere in its family.
           *
           * A nullable timestamp rather than a boolean: "when" answers every
           * question "whether" answers, and an incident is a question about
           * when.
           */
          revoked_at: {
            type: Sequelize.DATE,
            allowNull: true,
          },

          /** The token that superseded this one. Makes the chain auditable. */
          replaced_by: {
            type: Sequelize.UUID,
            allowNull: true,
          },

          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },

          updated_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction },
      );

      // UNIQUE, so a hash collision or a repeated insert is a database error
      // rather than two rows that both look valid. It is also the lookup
      // index — every refresh does exactly one indexed read.
      await queryInterface.addIndex('refresh_tokens', ['token_hash'], {
        name: 'refresh_tokens_token_hash_key',
        unique: true,
        transaction,
      });

      // "Revoke this family" and "revoke everything for this user" are the
      // two write paths that matter during an incident. Both get an index,
      // because an incident is the worst time to discover a sequential scan.
      await queryInterface.addIndex('refresh_tokens', ['family_id'], {
        name: 'refresh_tokens_family_id_idx',
        transaction,
      });

      await queryInterface.addIndex('refresh_tokens', ['user_id'], {
        name: 'refresh_tokens_user_id_idx',
        transaction,
      });

      // The cleanup index: expired rows are deleted by a job that does not
      // exist yet, and this is what will make it cheap when it does.
      await queryInterface.addIndex('refresh_tokens', ['expires_at'], {
        name: 'refresh_tokens_expires_at_idx',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    // Dropping the table drops its indexes with it.
    await queryInterface.dropTable('refresh_tokens');
  },
};
