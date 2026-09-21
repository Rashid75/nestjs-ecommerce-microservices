import type { RmqContext } from '@nestjs/microservices';
import { ServiceQueue } from './events';

/**
 * Dead-lettering: what happens to a message a consumer cannot process.
 *
 * WHAT IT LOOKED LIKE BEFORE THIS FILE. Nest's RMQ transport defaults to
 * `noAck: true`, which means the broker considers a message delivered the
 * instant it is handed over. A handler that threw produced a log line and
 * nothing else — the message was already gone. Known gap #3 in the README
 * said exactly that: "a failed handler loses its message".
 *
 * That is fine for `product.price_changed`, where the next price change
 * fixes it. It is not fine for `order.confirmed`, where losing the message
 * means a paid order whose cart is never converted and whose customer is
 * never emailed, with no record that anything went wrong.
 *
 * THE THREE OPTIONS FOR A FAILED MESSAGE, and why the middle one is a trap:
 *
 *   DROP IT        (noAck: true — what we had). Fast, simple, silent. The
 *                  failure leaves no artefact anyone can act on.
 *
 *   REQUEUE IT     (nack with requeue=true). Looks like a retry and is
 *                  usually a POISON-MESSAGE LOOP: the message goes back to
 *                  the head of the queue, is redelivered immediately, fails
 *                  again, and the consumer spins at full speed doing nothing
 *                  else. A malformed payload can take a service down this
 *                  way — no backoff, no limit, no end.
 *
 *   PARK IT        (nack with requeue=false, plus a dead-letter exchange).
 *                  The broker moves it to a parking queue where it sits,
 *                  visible and countable, until a human looks. Nothing spins,
 *                  nothing is lost, and "how many messages are parked" is a
 *                  number you can alert on.
 *
 * We park. The message is preserved, the consumer moves on to the next one,
 * and `tools/replay-parked.mjs` puts it back when the cause is fixed.
 *
 * WHAT THIS DELIBERATELY IS NOT: a retry with backoff. A transient failure —
 * a database blip lasting two seconds — parks the message, and a human has
 * to replay it. The refinement is a retry queue with a TTL that dead-letters
 * back to the main queue, giving N delayed attempts before parking. It is
 * not here because it doubles the moving parts, and parking-plus-replay is
 * already the difference between losing an order and delaying one.
 */

/**
 * The dead-letter exchange. DIRECT, not topic.
 *
 * The main exchange is a topic because publishers do not know who is
 * listening. This one is the opposite: a parked message goes to exactly one
 * place — the parking queue of the service that failed it — so the routing
 * key is the queue name and a direct exchange is the honest shape.
 */
export const EVENTS_DEAD_LETTER_EXCHANGE = 'ecommerce.events.dlx';

/**
 * One parking queue per consuming service, not one shared.
 *
 * A shared parking queue would mix the Cart Service's failures with the
 * Notification Service's, and replaying it would mean replaying both. Worse,
 * the replay would have to work out which queue each message came from — and
 * the routing key on a dead-lettered message is the ORIGINAL routing key
 * (`order.confirmed`), which says what happened, not who failed to handle it.
 */
export const ParkingQueue = {
  Cart: `${ServiceQueue.Cart}.parked`,
  Order: `${ServiceQueue.Order}.parked`,
  Notification: `${ServiceQueue.Notification}.parked`,
} as const;

/**
 * The queue arguments that make a service queue dead-letter into its parking
 * queue.
 *
 * NOTE FOR THE DAY THIS FAILS TO START: a queue's arguments are fixed when
 * it is DECLARED. Adding these to a queue that already exists without them
 * makes the broker reject the declaration with PRECONDITION_FAILED, and the
 * service will not start. The old queues have to be deleted first — see
 * `tools/setup-broker.mjs`, which does it deliberately rather than leaving
 * you to discover it.
 */
export function deadLetterArgs(queue: string): Record<string, string> {
  return {
    'x-dead-letter-exchange': EVENTS_DEAD_LETTER_EXCHANGE,
    // The routing key is REWRITTEN to the queue name on the way out.
    // Without this the message keeps its original key (`order.confirmed`)
    // and the direct DLX has nothing bound to that name, so the message is
    // silently dropped — dead-lettering that loses messages is worse than
    // no dead-lettering, because you believe you are covered.
    'x-dead-letter-routing-key': queue,
  };
}

/** The minimum a logger must do for `ackOrPark`. Keeps this file Nest-free. */
export interface ParkingLogger {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Runs a handler and then ACKNOWLEDGES or PARKS the message.
 *
 * WHY EVERY HANDLER HAS TO DO THIS EXPLICITLY. With `noAck: false`, Nest
 * hands the message to the handler and takes no further action — it does not
 * ack on success and does not nack on failure. A handler that forgets leaves
 * the message unacknowledged forever: it is not redelivered, it is not
 * parked, and it silently consumes one slot of the consumer's prefetch
 * budget. Enough of those and the consumer stops receiving anything at all,
 * with no error anywhere. That failure is quiet, cumulative and very hard to
 * diagnose, which is exactly why acking lives in one shared function rather
 * than being written out eight times.
 *
 * ACK MEANS "I AM DONE WITH THIS", not "it succeeded". A message whose work
 * was already done — the conditional UPDATE that matched no rows because a
 * duplicate delivery beat it — is finished and must be acked. Only a handler
 * that THREW is parked.
 */
export async function ackOrPark(
  context: RmqContext,
  logger: ParkingLogger,
  what: string,
  work: () => Promise<void>,
): Promise<void> {
  const channel = context.getChannelRef() as {
    ack(message: unknown): void;
    nack(message: unknown, allUpTo: boolean, requeue: boolean): void;
  };
  const message = context.getMessage();

  try {
    await work();
    channel.ack(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // `false, false` = this message only, and DO NOT requeue. The second
    // false is the whole design: requeue=true is the poison-message loop
    // described at the top of this file.
    channel.nack(message, false, false);

    logger.error(
      `${what}: handler failed (${reason}) — message PARKED, not lost. Replay with tools/replay-parked.mjs`,
    );
  }
}
