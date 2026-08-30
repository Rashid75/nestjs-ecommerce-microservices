import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export interface CacheOptions {
  /** Time to live, in seconds, before jitter. */
  ttlSeconds: number;

  /**
   * Serialise a fraction of the TTL away so keys written together do not
   * expire together. See JITTER_RATIO below.
   */
  jitter?: boolean;

  /**
   * Let only ONE caller rebuild a missing key; the rest wait briefly and
   * re-read. Use for hot single keys. See the stampede note on getOrSet().
   */
  singleFlight?: boolean;
}

/**
 * Fraction of the TTL used as random jitter.
 *
 * THE PROBLEM: a deployment warms the cache, or a popular category page
 * writes 500 product keys within one second, all with TTL 300. Five minutes
 * later all 500 expire in the same second and every subsequent request goes
 * to PostgreSQL at once. The cache did not fail — it synchronised.
 *
 * With 20% jitter those keys expire spread over a 60-second window instead,
 * and the database sees a slope rather than a cliff.
 */
const JITTER_RATIO = 0.2;

/** How long a single-flight rebuild lock is held before it self-expires. */
const LOCK_TTL_MS = 5_000;

/** How long a losing caller waits before re-reading the cache. */
const LOCK_WAIT_MS = 60;

/**
 * Cache-aside (also called lazy loading) over Redis.
 *
 *   Request
 *      ↓
 *    Redis ──HIT──→ Response
 *      │
 *     MISS
 *      ↓
 *  PostgreSQL
 *      ↓
 *    Redis (write with TTL)
 *      ↓
 *   Response
 *
 * The application owns the cache. It reads it, and on a miss it loads from
 * the database and populates it. Compare with:
 *
 *   WRITE-THROUGH   every write goes to cache AND database synchronously.
 *                   The cache is never stale, but every write pays two
 *                   latencies, and you cache data nobody ever reads.
 *
 *   WRITE-BEHIND    write to cache, flush to the database asynchronously.
 *                   Fastest writes, and you can lose acknowledged writes if
 *                   the cache dies before the flush. Acceptable for view
 *                   counters, never for prices or orders.
 *
 * Cache-aside is the right default because it only caches what is actually
 * read, and because a cache failure degrades to "slower" rather than "wrong"
 * or "lost". Its weakness is a window of staleness between a write and its
 * invalidation, which is why every mutation in ProductsService invalidates
 * explicitly rather than waiting for the TTL.
 *
 * EVERY METHOD FAILS OPEN. If Redis is unreachable, cache reads return
 * undefined and cache writes are dropped, so the caller silently falls back
 * to PostgreSQL. A cache that can take the service down with it is worse than
 * no cache at all.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * The cache-aside read path.
   *
   * CACHE STAMPEDE (also: dog-piling, thundering herd). A single very
   * popular key expires. In the milliseconds before anyone can repopulate
   * it, every concurrent request misses and every one of them queries
   * PostgreSQL for the same row. A key served 5,000 times a second becomes
   * 5,000 simultaneous identical queries — and the database, not the cache,
   * is what falls over.
   *
   * `singleFlight: true` gives one caller a short Redis lock to rebuild
   * while the others wait ~60ms and re-read. Two things to understand about
   * it:
   *
   *   - It is best-effort, not a distributed mutex. A caller that loses the
   *     lock and still finds nothing after waiting falls through to the
   *     database rather than blocking, because a slow answer beats no
   *     answer. That means the stampede is flattened, not eliminated.
   *   - A real distributed lock (Redlock) needs fencing tokens and quorum
   *     across independent Redis nodes. That machinery is justified when a
   *     lock protects CORRECTNESS — reserving stock, say, which is
   *     Milestone 5. Here it only protects the database from redundant work,
   *     and an occasional duplicate query is harmless.
   *
   * The other two standard answers, for comparison: STALE-WHILE-REVALIDATE
   * serves the expired value and refreshes in the background (best latency,
   * needs a second TTL); PROBABILISTIC EARLY EXPIRATION has each reader roll
   * dice to refresh slightly early, spreading rebuilds with no lock at all.
   */
  async getOrSet<T>(
    key: string,
    options: CacheOptions,
    load: () => Promise<T | null>,
  ): Promise<{ value: T | null; hit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return { value: cached, hit: true };
    }

    if (options.singleFlight === true) {
      const acquired = await this.acquireLock(key);
      if (!acquired) {
        await sleep(LOCK_WAIT_MS);
        const afterWait = await this.get<T>(key);
        if (afterWait !== undefined) {
          return { value: afterWait, hit: true };
        }
        // Whoever held the lock is slow or died. Fall through and query the
        // database ourselves — a duplicate query is cheaper than a hung
        // request.
      }
    }

    const value = await load();
    await this.set(key, value, options);
    if (options.singleFlight === true) {
      await this.releaseLock(key);
    }
    return { value, hit: false };
  }

  /**
   * Returns `undefined` for "not cached" and `null` for "cached as absent".
   *
   * The distinction matters. NEGATIVE CACHING — storing the fact that a row
   * does not exist — is what stops a scripted probe for random UUIDs from
   * turning every 404 into a database query. Without it, the cache protects
   * only the happy path, which is exactly the path an attacker will avoid.
   *
   * Negative entries get the same TTL here. In a system where rows are
   * created frequently you would give them a much shorter one, so a
   * newly-created resource is not reported missing for five minutes.
   */
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        return undefined;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(`cache read failed for ${key}: ${asMessage(error)}`);
      return undefined;
    }
  }

  async set<T>(
    key: string,
    value: T | null,
    options: CacheOptions,
  ): Promise<void> {
    try {
      const ttl =
        options.jitter === false
          ? options.ttlSeconds
          : withJitter(options.ttlSeconds);
      // SET key value EX ttl — one round trip, and the TTL is applied
      // atomically with the write. Doing SET then EXPIRE as two commands
      // leaves a window where a crash between them creates a key that never
      // expires.
      await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.logger.warn(`cache write failed for ${key}: ${asMessage(error)}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.redis.del(...keys);
    } catch (error) {
      this.logger.warn(
        `cache delete failed for ${keys.join(', ')}: ${asMessage(error)}`,
      );
    }
  }

  /**
   * GENERATION-BASED INVALIDATION.
   *
   * The problem it solves: a single product changes, and every cached LIST
   * that might contain it is now stale. There is no way to know which lists
   * those are — the query space is unbounded (`?search=pad&minPrice=50&
   * sortBy=price&page=7`).
   *
   * The obvious fix is to find and delete them: `KEYS products:list:*`.
   * NEVER DO THIS IN PRODUCTION. Redis is single-threaded, and KEYS walks
   * the entire keyspace while blocking every other client. On a few million
   * keys that is a multi-second, total stall. `SCAN` is the non-blocking
   * cursor version and is correct for maintenance work, but it is still O(N)
   * and racy against concurrent writes.
   *
   * Instead: include a generation number in the key.
   *
   *   products:list:{gen}:{queryHash}
   *
   * A write does `INCR products:gen`. Every subsequent read computes a key
   * containing the new generation, so it misses — instantly, atomically, and
   * in O(1) regardless of how many list keys exist. The old keys are never
   * deleted; they simply become unreachable and expire on their own TTL.
   *
   * The cost is memory: orphaned keys linger until their TTL. With a 60s
   * list TTL that is negligible, and Redis's `maxmemory-policy allkeys-lru`
   * would evict them under pressure anyway.
   */
  async bumpGeneration(key: string): Promise<void> {
    try {
      await this.redis.incr(key);
    } catch (error) {
      this.logger.warn(
        `generation bump failed for ${key}: ${asMessage(error)}`,
      );
    }
  }

  /**
   * Reads the current generation, treating an unreachable Redis as
   * generation 0.
   *
   * Note the failure behaviour: if Redis is down this returns 0, the caller
   * builds a key nobody has written, gets a miss, and queries the database.
   * Correct by construction.
   */
  async getGeneration(key: string): Promise<number> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? 0 : Number(raw);
    } catch {
      return 0;
    }
  }

  /** True if this caller won the right to rebuild the key. */
  private async acquireLock(key: string): Promise<boolean> {
    try {
      // SET NX PX — set only if absent, with an expiry, in one atomic
      // command. The expiry is what stops a crashed holder from locking the
      // key forever.
      const result = await this.redis.set(
        `lock:${key}`,
        '1',
        'PX',
        LOCK_TTL_MS,
        'NX',
      );
      return result === 'OK';
    } catch {
      // Redis unreachable: everybody rebuilds. Degraded, not broken.
      return true;
    }
  }

  private async releaseLock(key: string): Promise<void> {
    await this.del(`lock:${key}`);
  }
}

/** ±JITTER_RATIO around the nominal TTL, never below 1 second. */
function withJitter(ttlSeconds: number): number {
  const spread = ttlSeconds * JITTER_RATIO;
  const offset = Math.random() * spread * 2 - spread;
  return Math.max(1, Math.round(ttlSeconds + offset));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
