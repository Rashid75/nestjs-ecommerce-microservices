import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentCorrelationId } from './correlation';
import { PinoLoggerService } from './pino-logger.service';

/**
 * The standard error envelope, and the last line of defence against leaking.
 *
 * TWO JOBS, and the second is the one that matters:
 *
 *   1. Every error answers the same SHAPE, so a client can parse one thing.
 *   2. An error nobody anticipated becomes a 500 with NOTHING in it but a
 *      correlation id — while the real cause, stack and all, goes to the
 *      log.
 *
 * That second job is why this exists. Without a catch-all filter, an
 * unexpected throw reaches Nest's default handler, and anything that is not
 * an HttpException produces a 500 whose body is generic — fine — but the
 * stack lands in stdout with no correlation id attached to it, and a
 * `QueryFailedError` from Sequelize will happily print the failing SQL,
 * table names and all, to a customer if anyone ever "improves" the handler
 * to include `error.message`.
 *
 * So: known errors keep their status and their carefully-written body;
 * unknown errors are flattened to a 500 saying nothing, and the customer is
 * handed the ONE thing that makes it investigable — the correlation id they
 * can quote.
 */
interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string | string[];
  /** What the customer quotes; what you grep. */
  correlationId?: string;
  path: string;
  timestamp: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // ONLY HTTP. A filter registered globally also sees RPC exceptions from
    // the RabbitMQ handlers, and calling `switchToHttp()` on one of those
    // gives an undefined response object — a crash inside the error handler,
    // which is the worst place to have one. A message that fails should be
    // nacked by Nest's RMQ machinery, not turned into an HTTP response.
    if (host.getType() !== 'http') {
      throw exception;
    }

    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const { status, body } = describe(exception);

    const envelope: ErrorEnvelope = {
      statusCode: status,
      error: body.error,
      message: body.message,
      ...(currentCorrelationId() === undefined
        ? {}
        : { correlationId: currentCorrelationId() }),
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    // A 500 is ours and is logged with the whole error; a 4xx is the
    // caller's and is not logged here at all — the request-completion line
    // in the middleware already records it at `warn`, and logging every
    // validation failure twice is how a log becomes unreadable.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `unhandled ${status} on ${request.method} ${request.originalUrl}`,
        exception instanceof Error ? exception : new Error(String(exception)),
        'ExceptionFilter',
      );
    }

    response.status(status).json({
      ...envelope,
      // The extra fields a deliberate error carried — `retryable`,
      // `failureCode`, `available`. They were written to be useful to a
      // client, and flattening them away would undo that work.
      ...body.extra,
    });
  }
}

interface Described {
  status: number;
  body: {
    error: string;
    message: string | string[];
    extra: Record<string, unknown>;
  };
}

function describe(exception: unknown): Described {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return {
        status,
        body: { error: nameFor(status), message: payload, extra: {} },
      };
    }

    const {
      statusCode: _statusCode,
      error,
      message,
      ...extra
    } = payload as Record<string, unknown>;

    return {
      status,
      body: {
        error: typeof error === 'string' ? error : nameFor(status),
        message:
          typeof message === 'string' || Array.isArray(message)
            ? (message as string | string[])
            : nameFor(status),
        extra,
      },
    };
  }

  /**
   * ANYTHING ELSE. A Sequelize error, a TypeError, a rejected promise from a
   * library. The customer is told nothing about it, deliberately: the
   * message could name a column, a constraint, a file path or an internal
   * host, and none of that is theirs.
   */
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: {
      error: 'Internal Server Error',
      message:
        'Something went wrong. Quote the correlation id if you contact us.',
      extra: {},
    },
  };
}

function nameFor(status: number): string {
  const names: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return names[status] ?? 'Error';
}
