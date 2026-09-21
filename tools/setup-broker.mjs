#!/usr/bin/env node
/**
 * Declares the exchanges, queues and bindings this system needs.
 *
 *   node tools/setup-broker.mjs              # declare what is missing
 *   node tools/setup-broker.mjs --recreate   # DELETE the service queues first
 *
 * WHY THIS SCRIPT EXISTS AT ALL, when Nest declares its own queue on connect.
 *
 * Nest declares the queue it CONSUMES. Nothing in the application declares
 * the dead-letter exchange or the parking queues, because nothing consumes
 * them — and RabbitMQ will happily accept a queue that dead-letters to an
 * exchange with no bindings, then silently drop every message sent there.
 * Dead-lettering that loses messages is worse than none, because you believe
 * you are covered.
 *
 * So the topology is declared HERE, deliberately, in one readable file.
 *
 * WHY --recreate EXISTS, and when you will need it. A queue's arguments are
 * fixed at declaration time. `cart_service` already exists WITHOUT
 * `x-dead-letter-exchange`, so the first service to start after this change
 * asks for a queue that differs from the one already there, and the broker
 * answers PRECONDITION_FAILED — the service refuses to start, with a message
 * that does not obviously mean "delete your queue".
 *
 * --recreate deletes the three service queues so they can be declared with
 * the new arguments. IT DISCARDS ANY MESSAGES STILL IN THEM. On a laptop
 * that is nothing; in production the same change is a migration you plan
 * (drain the queue, or declare a v2 queue and move the bindings).
 */
import amqplib from 'amqplib';

const URL = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'ecommerce.events';
const DLX = 'ecommerce.events.dlx';

const SERVICES = ['cart_service', 'order_service', 'notification_service'];

const recreate = process.argv.includes('--recreate');

const connection = await amqplib.connect(URL);
const channel = await connection.createChannel();

// The main exchange: TOPIC, because publishers do not know who is listening.
await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
console.log(`exchange   ${EXCHANGE} (topic, durable)`);

// The dead-letter exchange: DIRECT, because a parked message goes to exactly
// one place — the parking queue of the service that failed it.
await channel.assertExchange(DLX, 'direct', { durable: true });
console.log(`exchange   ${DLX} (direct, durable)`);

for (const service of SERVICES) {
  const parked = `${service}.parked`;

  if (recreate) {
    try {
      // `deleteQueue` on a queue that does not exist is fine; on one that
      // does, this is the destructive step.
      const { messageCount } = await channel.deleteQueue(service);
      console.log(
        `DELETED    ${service} (${messageCount} message(s) discarded)`,
      );
    } catch (error) {
      console.log(`           ${service} not deleted: ${error.message}`);
    }
  }

  await channel.assertQueue(service, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX,
      // Rewritten on the way out, so the direct DLX can route it. Without
      // this the message keeps its original key (`order.confirmed`), which
      // nothing is bound to on the DLX, and it is dropped.
      'x-dead-letter-routing-key': service,
    },
  });
  console.log(`queue      ${service} (durable, dead-letters to ${parked})`);

  // The parking queue itself has NO dead-letter exchange. A message that
  // fails in parking has nowhere further to go, and a parking queue that
  // dead-letters to itself is an infinite loop with extra steps.
  await channel.assertQueue(parked, { durable: true });
  await channel.bindQueue(parked, DLX, service);
  console.log(`queue      ${parked} (durable, bound to ${DLX})`);
}

console.log(
  `\nDone. The services bind their own routing keys on startup — one per @EventPattern.`,
);

await channel.close();
await connection.close();
