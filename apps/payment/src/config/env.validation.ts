import * as Joi from 'joi';

/**
 * Environment contract for the Payment Service.
 *
 * Note what is NOT here and never will be: a payment provider's SECRET KEY.
 * When this stops being a mock, that key belongs in a secret manager rather
 * than in a `.env` on someone's laptop — a leaked provider key is not a
 * password reset, it is somebody charging cards with your merchant account.
 * That deferral is recorded in the plan with its trigger.
 */
export interface PaymentEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  PAYMENT_SERVICE_PORT: number;

  PAYMENT_DB_HOST: string;
  PAYMENT_DB_PORT: number;
  PAYMENT_DB_USERNAME: string;
  PAYMENT_DB_PASSWORD: string;
  PAYMENT_DB_DATABASE: string;
  PAYMENT_DB_LOGGING: boolean;
  PAYMENT_DB_SSL: boolean;

  ORDER_SERVICE_URL: string;
  HTTP_CLIENT_TIMEOUT_MS: number;
  PAYMENT_PROVIDER_TIMEOUT_MS: number;

  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
}

export const paymentEnvSchema = Joi.object({
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

  PAYMENT_SERVICE_PORT: Joi.number().port().default(3006),

  PAYMENT_DB_HOST: Joi.string().required(),
  PAYMENT_DB_PORT: Joi.number().port().required(),
  PAYMENT_DB_USERNAME: Joi.string().required(),
  PAYMENT_DB_PASSWORD: Joi.string().required(),
  PAYMENT_DB_DATABASE: Joi.string().required(),
  PAYMENT_DB_LOGGING: Joi.boolean().default(false),
  PAYMENT_DB_SSL: Joi.boolean().default(false),

  // Required: the amount to charge comes from the order, never from the
  // client, so a Payment Service that cannot reach Orders cannot work.
  ORDER_SERVICE_URL: Joi.string().uri().required(),

  HTTP_CLIENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(5_000),

  /**
   * How long to wait for the payment provider.
   *
   * SEPARATE from the general HTTP timeout, and longer, because the
   * trade-off is different. A slow catalogue read can be abandoned cheaply —
   * the customer retries and nothing was lost. Abandoning a charge does not
   * cancel it: the provider carries on, and we are left not knowing whether
   * the customer was charged. So the deadline is generous enough that a
   * merely-slow provider still gives us an answer.
   *
   * It cannot be infinite either. A request held open forever holds a
   * connection, a database row and a customer staring at a spinner.
   */
  PAYMENT_PROVIDER_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(60_000)
    .default(10_000),

  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),

  // The topic EXCHANGE. Publishers send to it; every consuming service
  // binds its own queue to it. See the long note in
  // libs/contracts/src/lib/events/events.ts for why this replaced the
  // single shared queue in Milestone 10.
  RABBITMQ_EXCHANGE: Joi.string().default('ecommerce.events'),
});
