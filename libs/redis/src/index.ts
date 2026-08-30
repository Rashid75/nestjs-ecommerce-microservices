/**
 * The public surface of `@ecommerce/redis`.
 *
 * Two consumers today: the Product Service (cache-aside over the catalogue)
 * and the API Gateway (rate limiting). That second consumer is what made
 * this a library rather than a file inside one app — the same trigger rule
 * that governs `libs/contracts`.
 */
export * from './lib/redis.constants';
export * from './lib/redis.module';
export * from './lib/cache.service';
