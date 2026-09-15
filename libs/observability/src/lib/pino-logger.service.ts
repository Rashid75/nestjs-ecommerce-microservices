import { Injectable, LoggerService, LogLevel } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';
import { currentCorrelationId } from './correlation';

export interface LoggerOptions {
  /** Which service is speaking. Appears on every line. */
  service: string;
  /** `debug` | `info` | `warn` | `error`. */
  level: string;
  /**
   * Human-readable, colourised output instead of JSON.
   *
   * On in development because reading JSON by eye is miserable; OFF
   * everywhere else, because a log shipper needs the JSON and `pino-pretty`
   * costs a whole extra process to produce something no machine can parse.
   */
  pretty: boolean;
}

/**
 * The application logger: Pino behind Nest's `LoggerService`.
 *
 * WHY STRUCTURED LOGS AT ALL. `console.log(\`user \${id} placed order \${n}\`)`
 * is readable and useless the moment there is more than one service. You
 * cannot filter it, you cannot count it, and you certainly cannot ask "show
 * me everything that happened for this customer" across eight processes.
 * A structured line is an OBJECT — `{"level":"info","service":"order",
 * "correlationId":"…","msg":"order ORD-00000042 confirmed"}` — and every
 * field is something you can search on.
 *
 * WHY PINO. It writes JSON directly to the stream with no intermediate
 * object formatting, which makes it roughly an order of magnitude cheaper
 * than the alternatives — and logging happens on every request, so its cost
 * is paid on the hot path.
 *
 * WHY IT IMPLEMENTS NEST'S INTERFACE. Passing this to `app.useLogger()`
 * means Nest's OWN logs — route mapping, shutdown, unhandled exceptions —
 * come out in the same format as the application's. A system where half the
 * lines are JSON and half are not cannot be shipped anywhere useful.
 *
 * EVERY LINE CARRIES THE CORRELATION ID, without a single call site passing
 * it, because the `mixin` below reads it from the async context. That is the
 * whole payoff: `grep <id>` across eight services returns one customer's
 * journey in order.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: PinoLogger;

  constructor(options: LoggerOptions) {
    this.logger = pino({
      level: options.level,
      base: {
        // On every line, so a shipper can split by service without parsing
        // the message. `pid` and `hostname` are Pino's defaults and are
        // dropped: in a container both are noise, and the orchestrator adds
        // better labels.
        service: options.service,
      },

      /**
       * Called for every log line. Whatever it returns is merged in.
       *
       * This is the mechanism that makes correlation ids free. No service,
       * repository or controller ever passes one — the id is in the async
       * context, and every line picks it up on the way out.
       */
      mixin() {
        const correlationId = currentCorrelationId();
        return correlationId === undefined ? {} : { correlationId };
      },

      /**
       * NEVER LOG THESE.
       *
       * A log file is read by more people, and kept far longer, than anyone
       * intends when they add a line to it. Redaction is a blunt instrument
       * and it is the right one: it applies to every line, including the
       * ones a future colleague adds without thinking.
       *
       * The paths cover the shapes these values actually arrive in — a
       * request object, an error's config, a plain payload.
       */
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          '*.password',
          '*.passwordHash',
          '*.accessToken',
          '*.paymentMethodToken',
          '*.cardNumber',
          '*.cvv',
        ],
        censor: '[redacted]',
      },

      timestamp: pino.stdTimeFunctions.isoTime,

      formatters: {
        // `"level":"info"` rather than `"level":30`. Costs a lookup per line
        // and saves every human who ever reads it.
        level: (label) => ({ level: label }),
      },

      ...(options.pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                // The correlation id is the point, so it goes on the line
                // rather than in the object dump underneath.
                messageFormat: '[{service}] {msg}',
                ignore: 'pid,hostname,service',
              },
            },
          }
        : {}),
    });
  }

  /**
   * Nest calls these with `(message, ...optionalParams)`, where the LAST
   * param is conventionally the context (`'OrdersService'`) and anything
   * before it is extra detail. Unpicking that here is what keeps
   * `this.logger.log('x', SomeService.name)` working unchanged across the
   * whole codebase — nothing had to be rewritten to adopt structured logs.
   */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  setLogLevels(_levels: LogLevel[]): void {
    // Nest's per-level toggles are not used: the level is configuration, set
    // once from LOG_LEVEL, so that turning on debug in production is an
    // environment change rather than a deploy.
  }

  /** The underlying logger, for anything that wants to add fields. */
  get pino(): PinoLogger {
    return this.logger;
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const context =
      optionalParams.length > 0 &&
      typeof optionalParams[optionalParams.length - 1] === 'string'
        ? (optionalParams[optionalParams.length - 1] as string)
        : undefined;

    // An Error goes in as an object, so Pino serialises the stack properly
    // instead of printing "[object Object]" — the single most common way a
    // structured logger is made useless.
    const error = optionalParams.find(
      (param, index) =>
        param instanceof Error &&
        // The last param is the context when it is a string, so it is never
        // the error — and an Error in that slot is a caller passing one
        // instead of a context, which is still worth serialising.
        (index !== optionalParams.length - 1 || context === undefined),
    );

    this.logger[level](
      {
        ...(context === undefined ? {} : { context }),
        ...(error === undefined ? {} : { err: error }),
      },
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }
}
