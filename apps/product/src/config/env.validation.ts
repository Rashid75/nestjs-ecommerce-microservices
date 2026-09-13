import * as Joi from 'joi';

/**
 * Environment contract for the Product Service.
 *
 * Same two rules as every other service: fail fast on bad configuration, and
 * name the KEY in an error, never the VALUE — `PRODUCT_DB_PASSWORD` is in
 * this set.
 *
 * The `PRODUCT_DB_` prefix is what database-per-service looks like in a
 * shared local `.env`. This service knows nothing about `AUTH_DB_*` and could
 * not connect to the auth database even if a bug tried to: it holds no
 * credentials for it.
 */
export interface ProductEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PRODUCT_SERVICE_PORT: number;

  PRODUCT_DB_HOST: string;
  PRODUCT_DB_PORT: number;
  PRODUCT_DB_USERNAME: string;
  PRODUCT_DB_PASSWORD: string;
  PRODUCT_DB_DATABASE: string;
  PRODUCT_DB_LOGGING: boolean;
  PRODUCT_DB_SSL: boolean;

  REDIS_URL: string;
  CACHE_ENABLED: boolean;
  CACHE_PRODUCT_TTL_SECONDS: number;
  CACHE_LIST_TTL_SECONDS: number;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const productEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PRODUCT_SERVICE_PORT: Joi.number().port().default(3002),

  PRODUCT_DB_HOST: Joi.string().required(),
  PRODUCT_DB_PORT: Joi.number().port().required(),
  PRODUCT_DB_USERNAME: Joi.string().required(),
  PRODUCT_DB_PASSWORD: Joi.string().required(),
  PRODUCT_DB_DATABASE: Joi.string().required(),
  PRODUCT_DB_LOGGING: Joi.boolean().default(false),
  PRODUCT_DB_SSL: Joi.boolean().default(false),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // A kill switch. When a cache starts serving something wrong, the first
  // thing you want at 3am is to turn it off without a code change and
  // confirm the database path is still correct. A cache you cannot disable
  // is a cache you cannot debug.
  CACHE_ENABLED: Joi.boolean().default(true),

  // 5 minutes. Product detail changes rarely, and every write invalidates
  // explicitly — so the TTL is a backstop against missed invalidations, not
  // the primary freshness mechanism.
  CACHE_PRODUCT_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(86400)
    .default(300),

  // 60 seconds. Much shorter, because a list reflects many rows and any one
  // of them changing makes it stale. Generation-based invalidation handles
  // the common case; this bounds the damage from anything it misses.
  CACHE_LIST_TTL_SECONDS: Joi.number().integer().min(1).max(3600).default(60),
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
