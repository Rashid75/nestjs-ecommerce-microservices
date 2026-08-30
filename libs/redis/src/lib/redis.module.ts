import {
  DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { CacheService } from './cache.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT };

export interface RedisModuleOptions {
  /** e.g. redis://localhost:6379 */
  url: string;
  /**
   * Prefixed to every key this connection touches.
   *
   * All services share one Redis instance in local development, exactly as
   * they share one PostgreSQL server. Postgres gives each service its own
   * database; Redis has no such isolation — it has 16 numbered databases and
   * discourages using them. A key prefix (`product:`, `gateway:`) is the
   * convention that keeps one service from reading or evicting another's
   * keys, and makes `SCAN` output legible.
   */
  keyPrefix: string;
}

export interface RedisModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Provider[] | unknown[];
  useFactory: (
    ...args: never[]
  ) => RedisModuleOptions | Promise<RedisModuleOptions>;
}

/**
 * Provides one shared ioredis client.
 *
 * WHY REDIS AT ALL?
 *
 * Two jobs in this milestone, and they are different in kind:
 *
 *   CACHE          PostgreSQL can serve a product read in ~1ms, so caching is
 *                  not about beating the database on a single query. It is
 *                  about not making the query a hundred thousand times for
 *                  the same unchanged row — protecting the database's finite
 *                  connection pool and CPU during a traffic spike.
 *
 *   SHARED STATE   A rate limiter needs one counter across every instance of
 *                  the gateway. An in-memory counter means three replicas
 *                  each allow the configured limit, so the real limit is 3x
 *                  what you configured — and it resets on every deploy.
 *                  That is not a limit; it is a suggestion.
 *
 * WHAT WOULD HAPPEN WITHOUT IT? The catalogue would work. It would simply do
 * far more database work than it needs to, and rate limiting would be
 * unenforceable the moment there is more than one process.
 *
 * ALTERNATIVES. Memcached is simpler and does caching only — no sorted sets,
 * no scripting, no persistence, so no rate limiting and no queues. An
 * in-process LRU (`lru-cache`) is faster still and needs no network hop, but
 * each instance holds its own copy: invalidation cannot be coordinated, so a
 * price change would be visible on one replica and stale on another.
 */
@Global()
@Module({})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  // A module class may inject the providers it declares. That is what makes
  // the shutdown hook below possible without reaching for ModuleRef.
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    const clientProvider: Provider = {
      provide: REDIS_CLIENT,
      inject: options.inject as never[],
      useFactory: async (...args: never[]) => {
        const config = await options.useFactory(...args);
        const logger = new Logger('Redis');

        const client = new Redis(config.url, {
          keyPrefix: config.keyPrefix,

          // Do NOT connect during construction.
          //
          // With lazyConnect the process starts even when Redis is down, and
          // the application degrades to "no cache" rather than refusing to
          // boot. That is the right failure mode for a CACHE: it is an
          // optimisation, and an optimisation must never be a hard
          // dependency. Contrast with PostgreSQL, where DatabaseModule
          // deliberately proves the connection at boot — a service with no
          // database cannot do its job at all.
          lazyConnect: true,

          // Give up on a command after 2s rather than letting a slow Redis
          // become slower than the database call it was meant to avoid.
          commandTimeout: 2_000,
          connectTimeout: 5_000,

          // Bounded backoff. Without a cap, ioredis retries forever with an
          // ever-growing delay and the log fills with noise.
          retryStrategy: (times) => Math.min(times * 200, 5_000),

          // Commands issued while disconnected fail immediately instead of
          // queueing. A queue that drains after a five-minute outage would
          // replay stale writes and hold request handlers open in the
          // meantime.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });

        client.on('error', (error: Error) => {
          // WARN, not ERROR. Redis being unavailable is survivable by design
          // — every caller falls back to PostgreSQL. Logging it as an error
          // trains people to ignore errors.
          logger.warn(`redis connection issue: ${error.message}`);
        });
        client.on('connect', () => logger.log(`connected to ${config.url}`));

        // Fire and forget. If it fails the client keeps retrying in the
        // background and every cache call fails open in the meantime.
        client.connect().catch((error: Error) => {
          logger.warn(
            `redis unavailable at startup (${error.message}) — running without cache`,
          );
        });

        return client;
      },
    };

    return {
      module: RedisModule,
      imports: options.imports ?? [],
      // CacheService rides along with the client so that importing
      // RedisModule once gives a service everything it needs.
      providers: [clientProvider, CacheService],
      exports: [clientProvider, CacheService],
    };
  }

  /**
   * Closes the connection on SIGTERM so Redis does not keep a dead client's
   * socket around. Graceful shutdown gets fuller treatment in Milestone 12;
   * this is the piece that belongs with the connection that owns it.
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.log('connection closed');
    } catch {
      // Already closed, or never opened. Nothing useful to do.
    }
  }
}
