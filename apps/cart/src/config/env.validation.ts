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
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  BIND_HOST: string;
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
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const cartEnvSchema = Joi.object({
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
