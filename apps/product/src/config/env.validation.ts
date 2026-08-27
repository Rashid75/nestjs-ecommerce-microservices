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
});
