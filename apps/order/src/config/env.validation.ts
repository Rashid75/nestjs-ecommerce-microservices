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
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  BIND_HOST: string;
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
  RABBITMQ_EXCHANGE: string;
}

export const orderEnvSchema = Joi.object({
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

  // Which interface to listen on. Read from process.env in main.ts, and
  // declared here for the same reason OTEL_ENABLED is: so it is DOCUMENTED
  // and a typo is a boot failure rather than a silent default.
  //
  // 127.0.0.1 everywhere except in a container, where loopback is the
  // container's own and nothing outside it — including the gateway — can
  // connect. docker-compose.yml sets 0.0.0.0 and publishes no port for this
  // service, so the network namespace becomes the boundary instead.
  BIND_HOST: Joi.string().default('127.0.0.1'),

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

  // The topic EXCHANGE. Publishers send to it; every consuming service
  // binds its own queue to it. See the long note in
  // libs/contracts/src/lib/events/events.ts for why this replaced the
  // single shared queue in Milestone 10.
  RABBITMQ_EXCHANGE: Joi.string().default('ecommerce.events'),
});
