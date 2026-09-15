import * as Joi from 'joi';

/**
 * Environment contract for the Inventory Service.
 *
 * NOTE WHAT IS ABSENT: there is no `REDIS_URL` and no cache configuration.
 *
 * That is deliberate, and it is the sharpest example in this project of
 * "do not cache everything". Stock is the most write-heavy and most
 * correctness-critical data in the system. Caching an availability figure
 * would mean serving a number that was true a moment ago — and the entire
 * point of this service is that "a moment ago" is exactly the window in
 * which the last unit gets sold twice.
 *
 * A cached `available: 1` is not a slightly stale product name. It is a
 * promise to a customer that the warehouse cannot keep.
 *
 * If read load on this service ever becomes a genuine problem, the answer is
 * a read replica or a coarse "in stock / out of stock" flag with a very
 * short TTL — never the exact number.
 */
export interface InventoryEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  INVENTORY_SERVICE_PORT: number;

  INVENTORY_DB_HOST: string;
  INVENTORY_DB_PORT: number;
  INVENTORY_DB_USERNAME: string;
  INVENTORY_DB_PASSWORD: string;
  INVENTORY_DB_DATABASE: string;
  INVENTORY_DB_LOGGING: boolean;
  INVENTORY_DB_SSL: boolean;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const inventoryEnvSchema = Joi.object({
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

  INVENTORY_SERVICE_PORT: Joi.number().port().default(3003),

  INVENTORY_DB_HOST: Joi.string().required(),
  INVENTORY_DB_PORT: Joi.number().port().required(),
  INVENTORY_DB_USERNAME: Joi.string().required(),
  INVENTORY_DB_PASSWORD: Joi.string().required(),
  INVENTORY_DB_DATABASE: Joi.string().required(),
  INVENTORY_DB_LOGGING: Joi.boolean().default(false),
  INVENTORY_DB_SSL: Joi.boolean().default(false),
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
