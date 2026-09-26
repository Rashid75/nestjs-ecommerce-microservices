import * as Joi from 'joi';

/**
 * Environment contract for the Notification Service.
 *
 * NO service URLs at all — the first service in this system with none. It
 * calls nothing: everything it needs arrives in an event, and the one piece
 * it needs that events do not carry (an email address) it keeps a local copy
 * of. That is what makes it genuinely decoupled rather than merely
 * asynchronous.
 */
export interface NotificationEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  BIND_HOST: string;
  NOTIFICATION_SERVICE_PORT: number;

  NOTIFICATION_DB_HOST: string;
  NOTIFICATION_DB_PORT: number;
  NOTIFICATION_DB_USERNAME: string;
  NOTIFICATION_DB_PASSWORD: string;
  NOTIFICATION_DB_DATABASE: string;
  NOTIFICATION_DB_LOGGING: boolean;
  NOTIFICATION_DB_SSL: boolean;

  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;

  MAIL_TRANSPORT: 'log' | 'smtp';
  MAIL_HOST: string;
  MAIL_PORT: number;
  MAIL_FROM: string;
}

export const notificationEnvSchema = Joi.object({
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

  NOTIFICATION_SERVICE_PORT: Joi.number().port().default(3007),

  NOTIFICATION_DB_HOST: Joi.string().required(),
  NOTIFICATION_DB_PORT: Joi.number().port().required(),
  NOTIFICATION_DB_USERNAME: Joi.string().required(),
  NOTIFICATION_DB_PASSWORD: Joi.string().required(),
  NOTIFICATION_DB_DATABASE: Joi.string().required(),
  NOTIFICATION_DB_LOGGING: Joi.boolean().default(false),
  NOTIFICATION_DB_SSL: Joi.boolean().default(false),

  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),

  // The topic exchange this service binds its own queue to.
  RABBITMQ_EXCHANGE: Joi.string().default('ecommerce.events'),

  /**
   * How to send mail.
   *
   *   log   print the subject and recipient, claim success. THE DEFAULT, so
   *         the whole system runs with nothing extra installed.
   *   smtp  Nodemailer to MAIL_HOST — MailHog locally.
   *
   * Defaulting to `log` is a deliberate choice about what a missing
   * dependency should do. The alternative — default to SMTP — means every
   * receipt fails until someone starts a mail server, and the failure looks
   * like a bug in this service rather than a missing container.
   */
  MAIL_TRANSPORT: Joi.string().valid('log', 'smtp').default('log'),

  // MailHog: SMTP on 1025, web UI on 8025. It accepts every message and
  // delivers none, which is exactly what a development mail server should
  // do — the alternative is emailing a real person from a test fixture.
  MAIL_HOST: Joi.string().default('localhost'),
  MAIL_PORT: Joi.number().port().default(1025),

  // The From address. Not validated as an email so that display forms like
  // `Shop <shop@example.test>` are allowed, which is what a real one looks
  // like.
  MAIL_FROM: Joi.string().default('Shop <shop@example.test>'),
});
