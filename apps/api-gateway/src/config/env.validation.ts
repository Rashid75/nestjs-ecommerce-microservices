import * as Joi from 'joi';

/**
 * Startup validation schema for environment variables.
 *
 * The application must fail fast at boot if configuration is missing or
 * malformed. Discovering a bad value at 3am, on the first request that
 * happens to need it, is far more expensive than refusing to start.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PORT: Joi.number().port().default(3000),

  API_GLOBAL_PREFIX: Joi.string().default('api'),
});
