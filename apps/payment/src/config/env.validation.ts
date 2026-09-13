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
