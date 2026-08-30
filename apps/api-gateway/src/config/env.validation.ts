import * as Joi from 'joi';

/**
 * Environment contract for the API Gateway.
 *
 * The gateway owns no database and no secrets — it routes. Its configuration
 * is therefore almost entirely "where do I find the services I forward to".
 *
 * Note there is no JWT_ACCESS_SECRET here. The gateway does not verify tokens
 * in this milestone; it passes the Authorization header through and lets the
 * Auth Service decide. Verifying at the edge is a real option (it rejects bad
 * tokens one hop earlier) but it means giving the gateway the signing key,
 * and a key that can verify an HS256 token can also mint one. The clean
 * version of edge verification needs RS256 asymmetric keys, so it waits.
 */
export interface GatewayEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  API_GATEWAY_PORT: number;
  API_GLOBAL_PREFIX: string;
  AUTH_SERVICE_URL: string;
  PRODUCT_SERVICE_URL: string;
  HTTP_CLIENT_TIMEOUT_MS: number;

  REDIS_URL: string;
  RATE_LIMIT_LIMIT: number;
  RATE_LIMIT_WINDOW_SECONDS: number;
  RATE_LIMIT_FAIL_OPEN: boolean;
}

export const gatewayEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  API_GATEWAY_PORT: Joi.number().port().default(3000),

  API_GLOBAL_PREFIX: Joi.string().default('api'),

  // `uri` rather than `string` so a missing scheme fails here rather than
  // producing a baffling axios error on the first forwarded request.
  AUTH_SERVICE_URL: Joi.string().uri().required(),

  PRODUCT_SERVICE_URL: Joi.string().uri().required(),

  // Every outbound call needs a deadline. Without one, a hung downstream
  // service holds a gateway request open indefinitely; enough of those and the
  // gateway exhausts its own resources and stops serving healthy routes too.
  // That is how one slow service takes down an entire system.
  HTTP_CLIENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .default(5_000),

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
