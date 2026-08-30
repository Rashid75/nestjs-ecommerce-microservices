import { REDIS_CLIENT } from '@ecommerce/redis';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import type { GatewayEnv } from '../config/env.validation';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
  SKIP_RATE_LIMIT_KEY,
} from './rate-limit.decorator';

/**
 * Atomic increment-and-expire, as a Lua script.
 *
 * WHY A SCRIPT AND NOT TWO COMMANDS. The obvious implementation is:
 *
 *     INCR key
 *     if result == 1 then EXPIRE key window end
 *
 * Those are two round trips, and the gap between them is a real bug. If the
 * process dies — or is simply descheduled long enough — after the INCR and
 * before the EXPIRE, the key has no TTL and never expires. The counter for
 * that client is then permanently at its limit and they are locked out
 * forever, with nothing in the logs to explain it.
 *
 * Redis executes a script atomically: nothing else runs between these lines.
 * One round trip, no window.
 *
 * Returns { current count, seconds until reset }.
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly defaults: RateLimitOptions;
  private readonly failOpen: boolean;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly reflector: Reflector,
    config: ConfigService<GatewayEnv, true>,
  ) {
    this.defaults = {
      limit: config.get('RATE_LIMIT_LIMIT', { infer: true }),
      windowSeconds: config.get('RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    };
    this.failOpen = config.get('RATE_LIMIT_FAIL_OPEN', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // getAllAndOverride checks the handler first, then the controller, so a
    // method-level @RateLimit beats a class-level one.
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip === true) {
      return true;
    }

    const options =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? this.defaults;

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const bucket =
      options.name ??
      `${request.method}:${request.route?.path ?? request.path}`;
    const key = `rl:${bucket}:${clientIdentifier(request)}`;

    let current: number;
    let ttl: number;

    try {
      const result = (await this.redis.eval(
        INCREMENT_SCRIPT,
        1,
        key,
        String(options.windowSeconds),
      )) as [number, number];
      [current, ttl] = result;
    } catch (error) {
      // FAIL OPEN or FAIL CLOSED — a genuine judgement call, so it is
      // configurable rather than assumed.
      //
      //   FAIL OPEN (default)  Redis down means no limiting. The API keeps
      //                        serving. But an attacker who can knock Redis
      //                        over has also disabled your rate limiting,
      //                        which is a rather convenient two-for-one.
      //
      //   FAIL CLOSED          Redis down means 503 for everyone. Safe
      //                        against that attack, and it converts a cache
      //                        outage into a total outage — turning an
      //                        optional dependency into a required one.
      //
      // Default open, because at this stage an availability incident is the
      // likelier and costlier failure. For a payment or credential endpoint
      // in production, closed is the defensible answer. Set
      // RATE_LIMIT_FAIL_OPEN=false to switch.
      this.logger.warn(
        `rate limiter unavailable (${error instanceof Error ? error.message : String(error)}) — failing ${this.failOpen ? 'OPEN' : 'CLOSED'}`,
      );
      if (this.failOpen) {
        return true;
      }
      throw new HttpException(
        'Service temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const remaining = Math.max(0, options.limit - current);
    response.setHeader('X-RateLimit-Limit', options.limit);
    response.setHeader('X-RateLimit-Remaining', remaining);
    response.setHeader('X-RateLimit-Reset', ttl);

    if (current > options.limit) {
      // Retry-After is not decoration. Without it a client retries
      // immediately, gets another 429, and the retry storm makes the
      // overload it was throttled for worse.
      response.setHeader('Retry-After', ttl);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${ttl} second(s).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

/**
 * Who is being limited.
 *
 * IP address, and ONLY the socket address — `X-Forwarded-For` is deliberately
 * ignored.
 *
 * That header is client-supplied. Trusting it without a trusted proxy in
 * front means an attacker sends a different `X-Forwarded-For` on every
 * request and the limiter counts each one separately — a rate limiter that
 * is trivially bypassed is worse than none, because it is believed.
 *
 * Behind a load balancer this must change: `app.set('trust proxy', 1)` in
 * main.ts makes Express take the LAST hop's XFF entry, which the balancer
 * controls and the client cannot forge. Enabling that is a DEPLOYMENT
 * decision — it is only safe once there really is a proxy — so it is not on
 * by default. Turning it on with no proxy present lets any client claim any
 * IP.
 *
 * Note the limitation this leaves: everyone behind one corporate NAT shares a
 * counter. Production systems usually key authenticated traffic by user id
 * and reserve IP keying for anonymous endpoints — which is where this goes
 * once the gateway can verify tokens.
 */
function clientIdentifier(request: Request): string {
  return request.socket.remoteAddress ?? 'unknown';
}
