import { REDIS_CLIENT } from '@ecommerce/redis';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { Sequelize } from 'sequelize-typescript';

/**
 * The dependency checks behind `/health/ready`.
 *
 * WHAT A HEALTH CHECK IS FOR, because it is easy to write one that is worse
 * than none. An orchestrator asks two different questions and reacts to them
 * very differently:
 *
 *   LIVENESS   "is this process wedged?" A failure here gets the container
 *              KILLED and restarted. It must therefore check almost nothing
 *              — a liveness probe that fails when the database blips
 *              restarts every replica during a database blip, which turns a
 *              brief outage into a total one.
 *
 *   READINESS  "should this instance receive traffic?" A failure here takes
 *              it out of the load balancer and leaves it running. That is
 *              where dependencies belong: a service that cannot reach its
 *              database should stop being sent requests, not be shot.
 *
 * Each check below is also given a TIMEOUT, because a health endpoint that
 * hangs is indistinguishable from one that is down — and it is usually worse,
 * since the probe itself then times out and takes longer to notice.
 */

/** Nothing takes longer than this to answer, or it counts as unhealthy. */
const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @Optional() private readonly sequelize?: Sequelize,
  ) {}

  /**
   * `SELECT 1`, with a deadline.
   *
   * Not `sequelize.authenticate()` alone: that can be satisfied by a
   * connection the pool already holds. A trivial query actually goes to the
   * server and back, which is the thing being asked about.
   */
  async check(key = 'database') {
    const indicator = this.health.check(key);

    if (this.sequelize === undefined) {
      // This service has no database. Reporting "up" for something that does
      // not exist would be a lie, so the check is simply not registered —
      // see `health.controller.ts`, which only asks for what applies.
      return indicator.up({ detail: 'not configured' });
    }

    try {
      await withTimeout(this.sequelize.query('SELECT 1'), 'database');
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: messageOf(error) });
    }
  }
}

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    // The TOKEN, not the class: `RedisModule` provides the client under a
    // Symbol, and injecting the ioredis class by type would find nothing.
    // `@Optional` because six of the eight services have no Redis at all.
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async check(key = 'redis') {
    const indicator = this.health.check(key);

    if (this.redis === undefined) {
      return indicator.up({ detail: 'not configured' });
    }

    try {
      const reply = await withTimeout(this.redis.ping(), 'redis');
      return reply === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `unexpected reply: ${String(reply)}` });
    } catch (error) {
      return indicator.down({ message: messageOf(error) });
    }
  }
}

/**
 * Whether the RabbitMQ connection is up.
 *
 * DELIBERATELY NOT A CONNECTION ATTEMPT. Opening a new AMQP connection on
 * every probe would, at one probe per few seconds across eight services,
 * produce more connection churn than the application does work. What this
 * reports is the state of the connection the service already holds.
 *
 * It is also reported as a WARNING rather than a failure in most services,
 * and that is the interesting decision — see the controller.
 */
@Injectable()
export class BrokerHealthIndicator {
  constructor(private readonly health: HealthIndicatorService) {}

  check(key: string, connected: boolean, required: boolean) {
    const indicator = this.health.check(key);

    if (connected) {
      return indicator.up();
    }

    return required
      ? indicator.down({ message: 'not connected' })
      : // Degraded, not broken. The Cart Service still serves carts with the
        // broker down; only its catalogue flags go stale. Taking it out of
        // the load balancer for that would turn a partial degradation into a
        // full outage.
        indicator.up({ detail: 'degraded: not connected' });
  }
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`${what} did not answer in ${CHECK_TIMEOUT_MS}ms`)),
        CHECK_TIMEOUT_MS,
      );
      // Never holds the process open — a pending probe timer must not delay
      // a graceful shutdown.
      timer.unref?.();
    }),
  ]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
