import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { runWithCorrelationId } from './correlation';
import { AllExceptionsFilter } from './http-exception.filter';
import type { PinoLoggerService } from './pino-logger.service';

/**
 * Tests for the catch-all filter.
 *
 * The one that matters is the LAST: an error nobody anticipated must reach
 * the customer carrying nothing. It is easy to write a filter that helpfully
 * includes `error.message`, and a Sequelize error's message names the table,
 * the column and the failing constraint.
 */
function makeHost(): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', originalUrl: '/api/orders' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

function makeLogger(): PinoLoggerService {
  return { error: jest.fn() } as unknown as PinoLoggerService;
}

describe('AllExceptionsFilter', () => {
  it('keeps a deliberate error’s status, message and extra fields', () => {
    const { host, status, json } = makeHost();

    new AllExceptionsFilter(makeLogger()).catch(
      new HttpException(
        {
          statusCode: 402,
          error: 'Payment Required',
          message: 'The card has insufficient funds',
          failureCode: 'INSUFFICIENT_FUNDS',
          retryable: false,
        },
        HttpStatus.PAYMENT_REQUIRED,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(402);
    const [body] = json.mock.calls[0];
    // The extra fields were written to be useful to a client. Flattening
    // them into a generic envelope would undo that work.
    expect(body).toMatchObject({
      statusCode: 402,
      error: 'Payment Required',
      message: 'The card has insufficient funds',
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
      path: '/api/orders',
    });
  });

  it('keeps class-validator’s array of messages', () => {
    const { host, json } = makeHost();

    new AllExceptionsFilter(makeLogger()).catch(
      new BadRequestException([
        'orderId must be a UUID',
        'quantity must be 1+',
      ]),
      host,
    );

    const [body] = json.mock.calls[0];
    expect(body.message).toEqual([
      'orderId must be a UUID',
      'quantity must be 1+',
    ]);
  });

  it('stamps the correlation id, so the customer can quote it', () => {
    const { host, json } = makeHost();

    runWithCorrelationId('cid-999', () => {
      new AllExceptionsFilter(makeLogger()).catch(
        new NotFoundException('Order not found'),
        host,
      );
    });

    expect(json.mock.calls[0][0].correlationId).toBe('cid-999');
  });

  it('does not log a 4xx — the request line already did', () => {
    const { host } = makeHost();
    const logger = makeLogger();

    new AllExceptionsFilter(logger).catch(new NotFoundException(), host);

    // Logging every validation failure twice is how a log becomes
    // unreadable, and how an error-rate alert learns to cry wolf.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('tells the customer NOTHING about an unexpected error', () => {
    const { host, status, json } = makeHost();
    const logger = makeLogger();

    // The shape of a real one: a driver error whose message names the table
    // and the constraint.
    const leaky = new Error(
      'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
    );

    new AllExceptionsFilter(logger).catch(leaky, host);

    expect(status).toHaveBeenCalledWith(500);
    const [body] = json.mock.calls[0];
    expect(JSON.stringify(body)).not.toContain('orders_user_id_fkey');
    expect(JSON.stringify(body)).not.toContain('table');
    expect(body.message).toContain('Quote the correlation id');

    // The real cause is not lost — it goes where only we can read it.
    expect(logger.error).toHaveBeenCalled();
  });

  it('rethrows a non-HTTP exception rather than crashing inside itself', () => {
    const host = {
      getType: () => 'rpc',
    } as unknown as ArgumentsHost;

    // A message handler's failure must be nacked by Nest's RMQ machinery,
    // not turned into an HTTP response against an undefined response object.
    expect(() =>
      new AllExceptionsFilter(makeLogger()).catch(new Error('boom'), host),
    ).toThrow('boom');
  });
});
