import * as Joi from 'joi';

/**
 * Environment contract for the Auth Service.
 *
 * Two rules govern this file.
 *
 * 1. FAIL FAST. If a variable is missing or malformed the process must refuse
 *    to boot. The alternative — starting up and failing on the first login —
 *    turns a config typo into a 3am production incident.
 *
 * 2. NEVER ECHO SECRETS. Validation errors name the KEY that is wrong, never
 *    the VALUE. `AUTH_DB_PASSWORD` and the key PATHS live in this set,
 *    and a startup error is exactly the sort of thing that gets pasted into a
 *    chat window or shipped to a log aggregator.
 *
 * Note the `AUTH_` prefix on the database variables. All nine services will
 * eventually share one `.env` in local development, and every one of them
 * owns its own database. Unprefixed `DB_HOST` would collide the moment the
 * Product Service appears.
 */

/**
 * The keys are FILES, not values.
 *
 * A PEM is multi-line, and a multi-line value in a `.env` file is a quoting
 * problem that everyone gets wrong once. A path also keeps the key material
 * out of the process environment, which matters more than it sounds: `env`
 * is readable by anything running as the same user, it is captured by most
 * crash reporters, and it is printed by half the container tooling in
 * existence.
 *
 * A deployed environment mounts the private key as a file from a secret
 * manager and points this at it — the same shape, with a different source.
 */

export interface AuthEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  AUTH_SERVICE_PORT: number;

  AUTH_DB_HOST: string;
  AUTH_DB_PORT: number;
  AUTH_DB_USERNAME: string;
  AUTH_DB_PASSWORD: string;
  AUTH_DB_DATABASE: string;
  AUTH_DB_LOGGING: boolean;
  AUTH_DB_SSL: boolean;

  JWT_PRIVATE_KEY_PATH: string;
  JWT_PUBLIC_KEY_PATH: string;
  JWT_ACCESS_TTL_SECONDS: number;
  BCRYPT_COST: number;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const authEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  // How much to say. `debug` in development; `info` in production, where a
  // debug line per request costs real money in log storage and buries the
  // lines that matter. Configuration rather than a constant, so turning it
  // up during an incident is an environment change, not a deploy.
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal')
    .default('info'),

  // Colourised, human-readable output instead of JSON. ON locally because
  // reading JSON by eye is miserable; OFF everywhere else, because a log
  // shipper needs the JSON and pino-pretty costs a whole extra process to
  // produce something no machine can parse.
  LOG_PRETTY: Joi.boolean().default(false),

  // Tracing is OFF by default. It is read by the tracing bootstrap from
  // process.env before Nest exists — this entry is here so the variable is
  // DOCUMENTED and validated like every other, and so a typo is a boot
  // failure rather than silently no traces.
  OTEL_ENABLED: Joi.boolean().default(false),

  AUTH_SERVICE_PORT: Joi.number().port().default(3001),

  AUTH_DB_HOST: Joi.string().required(),
  AUTH_DB_PORT: Joi.number().port().required(),
  AUTH_DB_USERNAME: Joi.string().required(),
  AUTH_DB_PASSWORD: Joi.string().required(),
  AUTH_DB_DATABASE: Joi.string().required(),
  // Query logging is ON in development because seeing the SQL Sequelize really
  // emits is half the point of this project. It must be OFF in production.
  AUTH_DB_LOGGING: Joi.boolean().default(false),
  AUTH_DB_SSL: Joi.boolean().default(false),

  // The PRIVATE key. This process is the only one in the system that has it,
  // and it is the only one that can mint a token.
  JWT_PRIVATE_KEY_PATH: Joi.string().required().messages({
    'any.required':
      'JWT_PRIVATE_KEY_PATH is required — run: node tools/generate-jwt-keys.mjs',
  }),

  // The PUBLIC key, which this service also needs: `/auth/me` verifies the
  // token it was handed. Not a secret.
  JWT_PUBLIC_KEY_PATH: Joi.string().required().messages({
    'any.required':
      'JWT_PUBLIC_KEY_PATH is required — run: node tools/generate-jwt-keys.mjs',
  }),

  // 15 minutes. Short, because an access token CANNOT be revoked before it
  // expires — there is no server-side session to delete. The lifetime is the
  // blast radius of a stolen token.
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),

  // Lower bound 10: below that bcrypt is fast enough to be a poor deterrent.
  // Upper bound 15: bcrypt cost is exponential, and a slow enough hash turns
  // your own login endpoint into a denial-of-service vector against yourself.
  BCRYPT_COST: Joi.number().integer().min(10).max(15).default(12),
  // NestJS's RMQ transport manages the connection, reconnects and channels.
  // A broker that is down does not stop a service booting; publishes fail
  // and are logged.
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),

  // The topic EXCHANGE. Publishers send to it; every consuming service
  // binds its own queue to it. See the long note in
  // libs/contracts/src/lib/events/events.ts for why this replaced the
  // single shared queue in Milestone 10.
  RABBITMQ_EXCHANGE: Joi.string().default('ecommerce.events'),
});
