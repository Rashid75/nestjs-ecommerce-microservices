import * as Joi from 'joi';

/**
 * Environment contract for the API Gateway.
 *
 * The gateway owns no database and no secrets — it routes. Its configuration
 * is therefore almost entirely "where do I find the services I forward to".
 *
 * The one exception is JWT_PUBLIC_KEY_PATH, added in Milestone 12. It is NOT
 * a secret: the public half of an RS256 keypair verifies tokens and mints
 * nothing. That is precisely why edge verification waited for RS256 — under
 * HS256 this variable would have held a key that could issue admin tokens
 * from the most exposed process in the system.
 */
export interface GatewayEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  OTEL_ENABLED: boolean;
  API_GATEWAY_PORT: number;
  API_GLOBAL_PREFIX: string;
  AUTH_SERVICE_URL: string;
  PRODUCT_SERVICE_URL: string;
  INVENTORY_SERVICE_URL: string;
  CART_SERVICE_URL: string;
  ORDER_SERVICE_URL: string;
  PAYMENT_SERVICE_URL: string;
  NOTIFICATION_SERVICE_URL: string;
  HTTP_CLIENT_TIMEOUT_MS: number;
  PAYMENT_GATEWAY_TIMEOUT_MS: number;
  JWT_PUBLIC_KEY_PATH: string;

  CORS_ALLOWED_ORIGINS: string;
  REDIS_URL: string;
  RATE_LIMIT_LIMIT: number;
  RATE_LIMIT_WINDOW_SECONDS: number;
  RATE_LIMIT_FAIL_OPEN: boolean;
}

export const gatewayEnvSchema = Joi.object({
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

  API_GATEWAY_PORT: Joi.number().port().default(3000),

  API_GLOBAL_PREFIX: Joi.string().default('api'),

  // `uri` rather than `string` so a missing scheme fails here rather than
  // producing a baffling axios error on the first forwarded request.
  AUTH_SERVICE_URL: Joi.string().uri().required(),

  PRODUCT_SERVICE_URL: Joi.string().uri().required(),

  INVENTORY_SERVICE_URL: Joi.string().uri().required(),

  CART_SERVICE_URL: Joi.string().uri().required(),

  ORDER_SERVICE_URL: Joi.string().uri().required(),

  PAYMENT_SERVICE_URL: Joi.string().uri().required(),

  NOTIFICATION_SERVICE_URL: Joi.string().uri().required(),

  // Every outbound call needs a deadline. Without one, a hung downstream
  // service holds a gateway request open indefinitely; enough of those and the
  // gateway exhausts its own resources and stops serving healthy routes too.
  // That is how one slow service takes down an entire system.
  HTTP_CLIENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(5_000),

  // Payments get their own, longer deadline. A charge takes seconds, and
  // abandoning one does not cancel it — it leaves a customer who may have
  // been charged and a gateway that has already answered 504. This must stay
  // LONGER than the Payment Service's own provider timeout, or the outer
  // deadline fires first and the inner one never gets to do its job.
  PAYMENT_GATEWAY_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(120_000)
    .default(20_000),

  // The PUBLIC half of the RS256 keypair. Required, not optional with a
  // fallback: a gateway that boots without a verification key is a gateway
  // that has to decide what to do with tokens it cannot check, and every
  // answer to that question is worse than refusing to start.
  JWT_PUBLIC_KEY_PATH: Joi.string().required().messages({
    'any.required':
      'JWT_PUBLIC_KEY_PATH is required — run: node tools/generate-jwt-keys.mjs',
  }),

  /**
   * Comma-separated browser origins allowed to call this API.
   *
   * EMPTY BY DEFAULT, which means no browser origin is allowed at all. That
   * is the correct default for a system with no browser client: CORS is a
   * control you open deliberately, one origin at a time, and a default of
   * "anything" is a default nobody revisits.
   */
  CORS_ALLOWED_ORIGINS: Joi.string().allow('').default(''),

  // Required, unlike the cache. Rate limiting needs ONE counter shared by
  // every gateway replica — an in-memory counter means three replicas each
  // allow the full limit, so the effective limit is three times what you
  // configured and it resets on every deploy.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // The global default: generous, because it exists to stop runaway clients
  // and scrapers, not to shape normal traffic. Endpoints that need a tighter
  // budget declare it with @RateLimit().
  RATE_LIMIT_LIMIT: Joi.number().integer().min(1).default(100),
  RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3600)
    .default(60),

  // What to do when Redis is unreachable. See the long note in
  // rate-limit.guard.ts — this is a real availability-vs-security trade-off,
  // so it is configuration rather than a hardcoded assumption.
  RATE_LIMIT_FAIL_OPEN: Joi.boolean().default(true),
});
