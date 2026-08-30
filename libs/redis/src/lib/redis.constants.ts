/**
 * Injection token for the shared ioredis client.
 *
 * In its own file to break what would otherwise be a circular import:
 * `cache.service.ts` needs the token, and `redis.module.ts` needs
 * CacheService in order to provide it. Circular ES module imports can
 * resolve to `undefined` at decorator-evaluation time, which surfaces as a
 * baffling "Nest can't resolve dependencies" error. One tiny constants file
 * removes the possibility.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
