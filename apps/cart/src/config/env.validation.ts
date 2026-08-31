import * as Joi from 'joi';

/**
 * Environment contract for the Cart Service.
 *
 * Note it carries a PRODUCT_SERVICE_URL. This is the first service in the
 * project that talks to another service directly rather than only being
 * called by the gateway — the price snapshot has to come from somewhere, and
 * it must not come from the client.
 *
 * No REDIS_URL. The cart lives in PostgreSQL: it must survive a restart, it
 * must be queryable for abandonment analytics, and it must be transactional
 * with order creation later. See the long note in the migration for the full
 * argument.
 */
export interface CartEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  CART_SERVICE_PORT: number;

  CART_DB_HOST: string;
  CART_DB_PORT: number;
  CART_DB_USERNAME: string;
  CART_DB_PASSWORD: string;
  CART_DB_DATABASE: string;
  CART_DB_LOGGING: boolean;
  CART_DB_SSL: boolean;

  PRODUCT_SERVICE_URL: string;
  HTTP_CLIENT_TIMEOUT_MS: number;
}

export const cartEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  CART_SERVICE_PORT: Joi.number().port().default(3004),

  CART_DB_HOST: Joi.string().required(),
  CART_DB_PORT: Joi.number().port().required(),
  CART_DB_USERNAME: Joi.string().required(),
  CART_DB_PASSWORD: Joi.string().required(),
  CART_DB_DATABASE: Joi.string().required(),
  CART_DB_LOGGING: Joi.boolean().default(false),
  CART_DB_SSL: Joi.boolean().default(false),

  PRODUCT_SERVICE_URL: Joi.string().uri().required(),
  HTTP_CLIENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(5_000),
});
