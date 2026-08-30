import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit';
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Distinguishes counters when several routes share a limiter.
   * Defaults to the route path.
   */
  name?: string;
}

/**
 * Overrides the global rate limit for one route.
 *
 * The point of per-route limits: a global "100 requests a minute" is either
 * far too loose for a login endpoint or far too tight for browsing a
 * catalogue. Different endpoints have different costs and different abuse
 * profiles, so they get different budgets.
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Exempts a route entirely.
 *
 * Reserved for health checks and documentation — endpoints a monitoring
 * system hits constantly and that cost nothing to serve.
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
