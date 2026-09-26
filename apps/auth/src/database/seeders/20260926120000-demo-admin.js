'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('node:path');
const bcrypt = require('bcrypt');

const { ADMIN, assertSeedingIsAllowed, adminPassword } = require(
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'tools', 'seed-data.js'),
);

/**
 * An administrator to log in as.
 *
 * WHY THIS HAS TO BE A SEEDER AND NOT AN ENDPOINT. There is deliberately no
 * API that creates an admin — an endpoint that mints its own administrators
 * is a privilege-escalation hole waiting to be found. So the first admin has
 * to arrive out of band, and "out of band" has meant a hand-typed SQL UPDATE
 * since Milestone 12. This is that statement, written down once.
 *
 * THE PASSWORD IS HASHED HERE, with the same bcrypt the application uses, at
 * the same cost. A seeder that inserted a plaintext password — or a hash
 * produced by a different algorithm — would create an account that cannot
 * log in, and the failure would look like a bug in the login path.
 *
 * `BCRYPT_COST` is read from the environment so the seeded hash matches
 * whatever the service is configured for; the fallback is the application's
 * own default.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    assertSeedingIsAllowed();

    const cost = Number(process.env.BCRYPT_COST ?? 12);
    const passwordHash = await bcrypt.hash(adminPassword(), cost);
    const now = new Date();

    await queryInterface.bulkInsert(
      'users',
      [
        {
          id: ADMIN.id,
          email: ADMIN.email,
          password_hash: passwordHash,
          first_name: ADMIN.firstName,
          last_name: ADMIN.lastName,
          role: 'ADMIN',
          is_active: true,
          created_at: now,
          updated_at: now,
        },
      ],
      // Idempotent, and quietly so: a second run changes nothing, including
      // the password. To rotate it, undo and re-run.
      { ignoreDuplicates: true },
    );

    console.log(`  seeded admin ${ADMIN.email}`);
  },

  async down(queryInterface) {
    // By id, not by email — deleting "whoever currently holds this address"
    // would remove a real account that happened to reuse it.
    await queryInterface.bulkDelete('users', { id: ADMIN.id });
  },
};
