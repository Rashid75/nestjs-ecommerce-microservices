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
 *    the VALUE. `AUTH_DB_PASSWORD` and `JWT_ACCESS_SECRET` live in this set,
 *    and a startup error is exactly the sort of thing that gets pasted into a
 *    chat window or shipped to a log aggregator.
 *
 * Note the `AUTH_` prefix on the database variables. All nine services will
 * eventually share one `.env` in local development, and every one of them
 * owns its own database. Unprefixed `DB_HOST` would collide the moment the
 * Product Service appears.
 */

/** Minimum length of the HS256 signing key, in characters. */
const MIN_JWT_SECRET_LENGTH = 32;

export interface AuthEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  AUTH_SERVICE_PORT: number;

  AUTH_DB_HOST: string;
  AUTH_DB_PORT: number;
  AUTH_DB_USERNAME: string;
  AUTH_DB_PASSWORD: string;
  AUTH_DB_DATABASE: string;
  AUTH_DB_LOGGING: boolean;
  AUTH_DB_SSL: boolean;

  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  BCRYPT_COST: number;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const authEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

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

  // HS256 keys shorter than the 32-byte hash output weaken the signature, and
  // a short secret can be brute-forced offline by anyone holding one token.
  // The message below states the requirement without repeating the value.
  JWT_ACCESS_SECRET: Joi.string()
    .min(MIN_JWT_SECRET_LENGTH)
    .required()
    .messages({
      'string.min': `JWT_ACCESS_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`,
      'any.required': 'JWT_ACCESS_SECRET is required',
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
