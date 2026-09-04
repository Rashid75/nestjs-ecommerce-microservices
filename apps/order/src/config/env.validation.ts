import * as Joi from 'joi';

/**
 * Environment contract for the Order Service.
 *
 * TWO dependencies: the Cart Service, because an order is built from a cart and
 * the customer must not be able to name their own lines or prices, and
 * RabbitMQ, because the rest of the system has to hear that an order
 * happened.
 *
 * Note what is NOT here, and why:
 *
 *   PRODUCT_SERVICE_URL    the prices come from the cart's snapshot, which
 *                          came from the catalogue when the item was added.
 *                          Re-pricing at checkout is exactly the surprise
 *                          snapshotting exists to prevent.
 *
 *   INVENTORY_SERVICE_URL  nothing reserves stock. Reserving is a write into
 *                          another service's database, so it needs an undo
 *                          when a later step fails — and that is a workflow
 *                          this milestone deliberately does not build.
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

  RABBITMQ_URL: string;
  RABBITMQ_QUEUE: string;
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

  // Required at boot, but a broker that is DOWN does not stop this service
  // starting or placing orders — NestJS's RMQ transport reconnects on its
  // own, and a failed publish is logged. Checkout stays available; only the
  // announcement is delayed.
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),

  // The queue every service publishes to and the Cart Service consumes from.
  RABBITMQ_QUEUE: Joi.string().default('ecommerce_events'),
});
