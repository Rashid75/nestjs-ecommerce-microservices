import * as Joi from 'joi';

/**
 * Environment contract for the Order Service.
 *
 * ONE downstream dependency in step 1: the Cart Service, because an order is
 * built from a cart and the customer must not be able to name their own
 * lines or prices.
 *
 * Note what is NOT here, and why:
 *
 *   PRODUCT_SERVICE_URL    the prices come from the cart's snapshot, which
 *                          came from the catalogue when the item was added.
 *                          Re-pricing at checkout is exactly the surprise
 *                          snapshotting exists to prevent.
 *
 *   INVENTORY_SERVICE_URL  nothing reserves stock yet. This arrives in step
 *                          2 of this milestone, and it is the variable that
 *                          turns this service into a workflow coordinator.
 *
 *   RABBITMQ_URL           this service publishes nothing yet. Also step 2.
 */
export interface OrderEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  ORDER_SERVICE_PORT: number;

  ORDER_DB_HOST: string;
  ORDER_DB_PORT: number;
  ORDER_DB_USERNAME: string;
  ORDER_DB_PASSWORD: string;
  ORDER_DB_DATABASE: string;
  ORDER_DB_LOGGING: boolean;
  ORDER_DB_SSL: boolean;

  CART_SERVICE_URL: string;
  HTTP_CLIENT_TIMEOUT_MS: number;
}

export const orderEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  ORDER_SERVICE_PORT: Joi.number().port().default(3005),

  ORDER_DB_HOST: Joi.string().required(),
  ORDER_DB_PORT: Joi.number().port().required(),
  ORDER_DB_USERNAME: Joi.string().required(),
  ORDER_DB_PASSWORD: Joi.string().required(),
  ORDER_DB_DATABASE: Joi.string().required(),
  ORDER_DB_LOGGING: Joi.boolean().default(false),
  ORDER_DB_SSL: Joi.boolean().default(false),

  // REQUIRED. A service that cannot read a cart cannot place an order, and
  // discovering that on the first checkout rather than at boot is strictly
  // worse.
  CART_SERVICE_URL: Joi.string().uri().required(),

  HTTP_CLIENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(5_000),
});
