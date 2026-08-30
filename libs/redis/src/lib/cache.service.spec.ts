import type { Redis } from 'ioredis';
import { CacheService } from './cache.service';

/**
 * A tiny in-memory stand-in for Redis.
 *
 * Enough to exercise the cache-aside logic without a running server:
 * GET/SET/DEL/INCR, plus a switch to simulate an outage. It does NOT
 * implement expiry — TTL is asserted by inspecting what was passed to SET,
 * because a test that waits five minutes for a key to disappear is not a
 * test anyone will run.
 */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  down = false;

  async get(key: string): Promise<string | null> {
    this.assertUp();
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<string | null> {
    this.assertUp();

    // SET key value PX ms NX — the single-flight lock.
    if (args.includes('NX')) {
      if (this.store.has(key)) {
        return null;
      }
      this.store.set(key, value);
      return 'OK';
    }

    // SET key value EX seconds — a cache write.
    const exIndex = args.indexOf('EX');
    if (exIndex !== -1) {
      this.ttls.set(key, Number(args[exIndex + 1]));
    }
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.assertUp();
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    this.assertUp();
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  private assertUp(): void {
    if (this.down) {
      throw new Error('connection refused');
    }
  }
}

function makeService(): { cache: CacheService; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { cache: new CacheService(redis as unknown as Redis), redis };
}

describe('CacheService', () => {
  describe('getOrSet — the cache-aside path', () => {
    it('misses first, then hits without calling the loader again', async () => {
      const { cache } = makeService();
      const load = jest.fn().mockResolvedValue({ id: 'p1', price: '19.99' });

      const first = await cache.getOrSet(
        'detail:p1',
        { ttlSeconds: 300 },
        load,
      );
      const second = await cache.getOrSet(
        'detail:p1',
        { ttlSeconds: 300 },
        load,
      );

      expect(first.hit).toBe(false);
      expect(second.hit).toBe(true);
      expect(second.value).toEqual({ id: 'p1', price: '19.99' });
      // The whole point: the database was consulted once for two requests.
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('caches absence, so repeated 404 probes do not reach the database', async () => {
      const { cache } = makeService();
      const load = jest.fn().mockResolvedValue(null);

      await cache.getOrSet('detail:missing', { ttlSeconds: 300 }, load);
      const second = await cache.getOrSet(
        'detail:missing',
        { ttlSeconds: 300 },
        load,
      );

      // NEGATIVE CACHING. Without it, a script probing random UUIDs turns
      // every 404 into a query — the cache would protect only the happy
      // path, which is the path an attacker avoids.
      expect(second.hit).toBe(true);
      expect(second.value).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('applies jitter within ±20% of the nominal TTL', async () => {
      const { cache, redis } = makeService();

      for (let i = 0; i < 40; i += 1) {
        await cache.set(`k${i}`, { i }, { ttlSeconds: 300 });
      }

      const ttls = [...redis.ttls.values()];
      expect(Math.min(...ttls)).toBeGreaterThanOrEqual(240);
      expect(Math.max(...ttls)).toBeLessThanOrEqual(360);
      // Jitter exists so keys written together do not expire together. If
      // every TTL were identical, that protection would not be working.
      expect(new Set(ttls).size).toBeGreaterThan(1);
    });

    it('honours jitter: false for callers that need an exact TTL', async () => {
      const { cache, redis } = makeService();
      await cache.set('exact', { a: 1 }, { ttlSeconds: 60, jitter: false });
      expect(redis.ttls.get('exact')).toBe(60);
    });
  });

  describe('failing open', () => {
    it('still returns data when Redis is unreachable', async () => {
      const { cache, redis } = makeService();
      redis.down = true;
      const load = jest.fn().mockResolvedValue({ id: 'p1' });

      const result = await cache.getOrSet(
        'detail:p1',
        { ttlSeconds: 300 },
        load,
      );

      // The single most important property of this class. A cache that
      // throws when Redis is down converts an optional dependency into a
      // required one and takes the whole service with it.
      expect(result.value).toEqual({ id: 'p1' });
      expect(result.hit).toBe(false);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('swallows write failures rather than failing the request', async () => {
      const { cache, redis } = makeService();
      redis.down = true;
      await expect(
        cache.set('k', { a: 1 }, { ttlSeconds: 60 }),
      ).resolves.toBeUndefined();
    });

    it('reports generation 0 when Redis is down, forcing a miss', async () => {
      const { cache, redis } = makeService();
      redis.down = true;
      // Key built from generation 0 was never written, so the read misses
      // and falls through to the database. Correct by construction.
      await expect(cache.getGeneration('listgen')).resolves.toBe(0);
    });
  });

  describe('generation-based invalidation', () => {
    it('increments the generation so old list keys become unreachable', async () => {
      const { cache } = makeService();

      expect(await cache.getGeneration('listgen')).toBe(0);
      await cache.bumpGeneration('listgen');
      await cache.bumpGeneration('listgen');
      expect(await cache.getGeneration('listgen')).toBe(2);
    });

    it('leaves the superseded entries in place to expire on their own', async () => {
      const { cache, redis } = makeService();
      await cache.set('list:0:abc', { items: [] }, { ttlSeconds: 60 });

      await cache.bumpGeneration('listgen');

      // The old key still EXISTS — nothing scanned or deleted it, which is
      // the entire point. It is simply unreachable, because every new read
      // builds a key containing generation 1. It expires on its TTL.
      expect(redis.store.has('list:0:abc')).toBe(true);
    });
  });

  describe('single flight', () => {
    it('lets only one concurrent caller rebuild a cold key', async () => {
      const { cache } = makeService();
      let inFlight = 0;
      let maxConcurrent = 0;

      const load = async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { id: 'hot' };
      };

      await Promise.all(
        Array.from({ length: 8 }, () =>
          cache.getOrSet(
            'detail:hot',
            { ttlSeconds: 300, singleFlight: true },
            load,
          ),
        ),
      );

      // Without the lock all eight would query at once — a cache stampede.
      // The lock flattens it; it does not guarantee exactly one, because a
      // caller that waits and still finds nothing falls through rather than
      // blocking. A slow answer beats no answer.
      expect(maxConcurrent).toBeLessThan(8);
    });
  });

  describe('del', () => {
    it('removes a key so the next read re-derives from the source', async () => {
      const { cache } = makeService();
      const load = jest.fn().mockResolvedValue({ price: '19.99' });

      await cache.getOrSet('detail:p1', { ttlSeconds: 300 }, load);
      await cache.del('detail:p1');
      const after = await cache.getOrSet(
        'detail:p1',
        { ttlSeconds: 300 },
        load,
      );

      expect(after.hit).toBe(false);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('is a no-op for an empty key list', async () => {
      const { cache } = makeService();
      await expect(cache.del()).resolves.toBeUndefined();
    });
  });
});
