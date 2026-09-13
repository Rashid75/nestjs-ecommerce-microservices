/**
 * Configuration for sequelize-cli ONLY.
 *
 * The running application does NOT read this file — it builds its connection
 * from ConfigService (see database.module.ts). That means two separate
 * consumers point at one database, which is a real hazard: if the CLI and the
 * app ever disagree, migrations get applied to one database while the app
 * talks to another, and the symptom is "column does not exist" against a
 * schema you are certain you migrated.
 *
 * Both therefore read the SAME workspace-root `.env`, and both resolve it
 * explicitly rather than relying on the current working directory.
 *
 * This file is CommonJS on purpose: sequelize-cli `require`s it, and the root
 * package.json has no `"type": "module"`.
 */
const path = require('node:path');

// __dirname = <workspace>/apps/notification/src/database
//   ..          -> src
//   ../..       -> notification
//   ../../..    -> apps
//   ../../../.. -> workspace root, where .env lives.
//
// Using __dirname rather than a relative string means the CLI resolves the
// same .env no matter which directory the command is invoked from.
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

require('dotenv').config({ path: path.join(WORKSPACE_ROOT, '.env') });

function required(key) {
  const value = process.env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[sequelize-cli] ${key} is missing. Expected it in ${path.join(WORKSPACE_ROOT, '.env')}`,
    );
  }
  return value;
}

const connection = {
  dialect: 'postgres',
  host: required('NOTIFICATION_DB_HOST'),
  port: Number(required('NOTIFICATION_DB_PORT')),
  username: required('NOTIFICATION_DB_USERNAME'),
  password: required('NOTIFICATION_DB_PASSWORD'),
  database: required('NOTIFICATION_DB_DATABASE'),

  // Always log SQL from the CLI, regardless of NOTIFICATION_DB_LOGGING. The entire
  // point of a migration policy is to see the REAL statements that ran, not a
  // reconstruction of what you think they were.
  logging: (sql) => {
    process.stdout.write(`[sequelize-cli] ${sql}\n`);
  },

  // The ledger of applied migrations. Named explicitly so it can never
  // silently change and orphan the existing history.
  migrationStorage: 'sequelize',
  migrationStorageTableName: 'SequelizeMeta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'SequelizeData',
};

// sequelize-cli selects a block by NODE_ENV. All three point at the same
// resolved connection because the connection details come from .env, not from
// hardcoded per-environment values. Hardcoding a production database here is
// how credentials end up in git.
module.exports = {
  development: connection,
  test: connection,
  production: connection,
};
