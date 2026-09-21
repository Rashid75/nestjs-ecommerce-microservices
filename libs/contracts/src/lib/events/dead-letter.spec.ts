import type { RmqContext } from '@nestjs/microservices';
import { ackOrPark, deadLetterArgs, ParkingQueue } from './dead-letter';

/**
 * The three outcomes a message can have, and the one that used to be missing.
 *
 * Before pass 4 a thrown handler meant the message was already gone — Nest's
 * default `noAck: true` acknowledges on delivery. The test that matters here
 * is the second: a failure must produce `nack(msg, false, false)`, because
 * the last `false` is what sends it to the dead-letter exchange instead of
 * back to the head of the queue.
 */
function makeContext(): {
  context: RmqContext;
  ack: jest.Mock;
  nack: jest.Mock;
} {
  const ack = jest.fn();
  const nack = jest.fn();
  const message = { content: Buffer.from('{}') };

  const context = {
    getChannelRef: () => ({ ack, nack }),
    getMessage: () => message,
  } as unknown as RmqContext;

  return { context, ack, nack };
}

const silentLogger = { log: jest.fn(), error: jest.fn() };

describe('ackOrPark', () => {
  beforeEach(() => {
    silentLogger.error.mockClear();
  });

  it('acknowledges a handler that completed', async () => {
    const { context, ack, nack } = makeContext();

    await ackOrPark(context, silentLogger, 'order.confirmed', async () => {
      // worked
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('parks a handler that threw — nack WITHOUT requeue', async () => {
    const { context, ack, nack } = makeContext();

    await ackOrPark(context, silentLogger, 'order.confirmed', async () => {
      throw new Error('database unreachable');
    });

    expect(ack).not.toHaveBeenCalled();
    // The final `false` is the whole design. `true` would put the message
    // back at the head of the queue to fail again immediately — a poison
    // message loop that can spin a consumer at full speed forever.
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('does not swallow the reason — it goes to the log', async () => {
    const { context } = makeContext();

    await ackOrPark(context, silentLogger, 'payment.succeeded', async () => {
      throw new Error('constraint violation');
    });

    const [line] = silentLogger.error.mock.calls[0];
    expect(line).toContain('payment.succeeded');
    expect(line).toContain('constraint violation');
    // The operator has to know what to do next, from the line itself.
    expect(line).toContain('PARKED');
  });

  it('acknowledges work that was already done, rather than parking it', async () => {
    const { context, ack, nack } = makeContext();

    // The shape of a duplicate delivery: the conditional UPDATE matched no
    // rows because the first delivery already converted the cart. Nothing
    // threw, so nothing is wrong — ack means "I am done with this", not "it
    // changed something".
    await ackOrPark(context, silentLogger, 'order.confirmed', async () => {
      const affected = 0;
      if (affected === 0) {
        return;
      }
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('rewrites the routing key so the direct DLX can route it', () => {
    const args = deadLetterArgs('cart_service');

    expect(args['x-dead-letter-exchange']).toBe('ecommerce.events.dlx');
    // Without the rewrite the message keeps `order.confirmed`, which nothing
    // is bound to on a direct exchange — and it is dropped silently.
    expect(args['x-dead-letter-routing-key']).toBe('cart_service');
    expect(ParkingQueue.Cart).toBe('cart_service.parked');
  });
});
