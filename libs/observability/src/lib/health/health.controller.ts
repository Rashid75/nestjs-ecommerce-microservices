import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import {
  DatabaseHealthIndicator,
  RedisHealthIndicator,
} from './health.indicators';

/**
 * The two probes, and they are not the same question.
 *
 *   GET /health/live   is this process wedged? Checks NOTHING but itself.
 *   GET /health/ready  should this instance be sent traffic? Checks its
 *                      dependencies.
 *
 * WHY LIVENESS CHECKS NOTHING. A failed liveness probe gets the container
 * killed. If it checked the database, then a thirty-second database blip
 * would restart every replica — simultaneously, and repeatedly, because the
 * new ones fail the same check. A brief outage becomes a crash loop, and the
 * restarts are what keeps it going.
 *
 * So liveness answers "is the event loop still turning?" and nothing more.
 * The honest version of that is a route that returns 200: if the process
 * were wedged, it could not.
 *
 * READINESS is where dependencies belong. A service that cannot reach its
 * database should stop receiving requests and stay alive, so it can rejoin
 * when the database comes back.
 *
 * NEITHER IS AUTHENTICATED, and neither says anything a stranger could use:
 * `{"database":{"status":"up"}}` is not a secret. What they must never do is
 * leak a connection string or a stack trace, which is why the indicators
 * report a short message rather than the raw error.
 *
 * Both are excluded from tracing (see `tracing.ts`) — at one probe every few
 * seconds per replica they would otherwise be most of the trace volume and
 * none of the interest.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Liveness. Returns 200 if the process can answer at all.
   *
   * No `@HealthCheck()`, no indicators, no I/O — deliberately. Everything
   * this route could check is a reason to kill a container that is working.
   */
  @Get('live')
  live(): { status: string; uptime: number } {
    return {
      status: 'ok',
      // Useful in one specific moment: a restart loop shows up as an uptime
      // that is always a few seconds.
      uptime: Math.round(process.uptime()),
    };
  }

  /**
   * Readiness. 200 when this instance can do its job, 503 when it cannot.
   *
   * `@HealthCheck()` is what makes Terminus answer 503 rather than throwing
   * a 500 — the distinction matters to an orchestrator, which treats a 500
   * as "broken" and a 503 as "not ready yet".
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.database.check(),
      () => this.redis.check(),
    ]);
  }
}
