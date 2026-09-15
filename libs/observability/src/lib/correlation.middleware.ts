import type { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from './correlation';
import type { PinoLoggerService } from './pino-logger.service';

/**
 * Puts every HTTP request into a correlation scope, and logs how it went.
 *
 * WHERE THE ID COMES FROM, and the rule is one line long: **take the one you
 * were given, or mint one.**
 *
 *   At the GATEWAY  no inbound header, so it mints. That is the birth of the
 *                   id, once per customer action.
 *   Everywhere else the gateway sent one, so it is adopted. Minting here
 *                   instead would break the chain — every service would
 *                   invent its own id and nothing would join up, which is
 *                   the commonest way this goes wrong.
 *
 * A CLIENT MAY SUPPLY ONE, and that is on purpose: a front end that
 * generates an id per user action can quote it in a bug report, and the
 * whole server-side trail is one grep away. The risk is minimal — it is an
 * opaque label with no authority, and it is never used to look anything up.
 *
 * The id also goes back on the RESPONSE, so whoever is holding the failed
 * request has the thing you need to investigate it.
 *
 * Express middleware rather than a Nest interceptor, deliberately.
 * `AsyncLocalStorage.run()` has to WRAP the rest of the work, and a
 * middleware calling `next()` inside it does exactly that. An interceptor
 * returns an Observable that Nest subscribes to afterwards, outside the
 * scope — which mostly appears to work and loses the context in ways that
 * are very hard to reproduce.
 */
export function correlationMiddleware(logger: PinoLoggerService) {
  return function correlate(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    const inbound = request.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof inbound === 'string' && inbound.trim() !== ''
        ? inbound.trim().slice(0, 100)
        : newCorrelationId();

    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithCorrelationId(correlationId, () => {
      const startedAt = process.hrtime.bigint();

      // On 'finish', not before: the status code and the duration are only
      // known once the response has actually been written. One line per
      // request, after the fact, is the shape that lets you count and filter
      // — two lines (start and end) doubles the volume and tells you nothing
      // extra unless you are hunting requests that never finish.
      response.on('finish', () => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        const line = {
          context: 'HTTP',
          method: request.method,
          // `originalUrl`, because a router may have rewritten `url` by now.
          url: request.originalUrl,
          status: response.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
        };

        const message = `${request.method} ${request.originalUrl} ${response.statusCode} ${line.durationMs}ms`;

        // A 500 is ours and a 400 is theirs. Logging both at `error` means
        // an alert on error-rate fires every time somebody mistypes an
        // email, and alerts that cry wolf get muted.
        if (response.statusCode >= 500) {
          logger.pino.error(line, message);
        } else if (response.statusCode >= 400) {
          logger.pino.warn(line, message);
        } else {
          logger.pino.info(line, message);
        }
      });

      next();
    });
  };
}
