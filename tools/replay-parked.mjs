#!/usr/bin/env node
/**
 * Inspects and replays parked messages.
 *
 *   node tools/replay-parked.mjs                       # what is parked?
 *   node tools/replay-parked.mjs --peek cart_service   # look, without consuming
 *   node tools/replay-parked.mjs --replay cart_service # put them back
 *   node tools/replay-parked.mjs --replay cart_service --limit 5
 *
 * A DEAD-LETTER QUEUE WITHOUT A REPLAY PATH IS A LANDFILL. It stops you
 * losing messages and gives you nothing to do about them, so in practice
 * nobody looks, and the parked count grows until it is ignored on principle.
 * The replay is what makes parking an actual recovery mechanism rather than
 * a place failures go to be forgotten.
 *
 * THE ORDER OF OPERATIONS MATTERS, and this script gets it right in a way
 * that is easy to get wrong: each message is REPUBLISHED FIRST and only
 * acked from the parking queue once the broker has confirmed the publish. Do
 * it the other way round — ack, then publish — and a crash in between loses
 * the message permanently, from the one queue whose entire job was not
 * losing it.
 *
 * REPLAY BEFORE YOU HAVE FIXED THE CAUSE and the message simply parks again.
 * That is not a flaw; it is the loop working. What you must not do is replay
 * blindly in a cron job, which turns parking into requeueing with extra
 * latency — the poison-message loop the DLQ existed to prevent.
 */
import amqplib from 'amqplib';

const URL = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'ecommerce.events';

const SERVICES = ['cart_service', 'order_service', 'notification_service'];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? true);
};

const peek = flag('--peek');
const replay = flag('--replay');
const limit = Number(flag('--limit') ?? 100);

const connection = await amqplib.connect(URL);
const channel = await connection.createChannel();

// ---------------------------------------------------------------- overview
if (peek === undefined && replay === undefined) {
  console.log('Parked messages:\n');
  for (const service of SERVICES) {
    const parked = `${service}.parked`;
    try {
      const { messageCount } = await channel.checkQueue(parked);
      console.log(
        `  ${parked.padEnd(30)} ${messageCount}${messageCount > 0 ? '  ← needs attention' : ''}`,
      );
    } catch {
      // checkQueue kills the channel on a missing queue.
      console.log(`  ${parked.padEnd(30)} (does not exist — run setup-broker)`);
      await channel.close();
      await connection.close();
      process.exit(1);
    }
  }
  console.log(
    '\n  --peek <service> to read them, --replay <service> to put them back.',
  );
  await channel.close();
  await connection.close();
  process.exit(0);
}

// -------------------------------------------------------------------- peek
if (typeof peek === 'string') {
  const parked = `${peek}.parked`;
  const seen = [];

  // `noAck: false` and never acking: the messages are returned to the queue
  // when the channel closes, so looking costs nothing. `get` with noAck:true
  // would CONSUME what you were only trying to read.
  for (let i = 0; i < limit; i += 1) {
    const message = await channel.get(parked, { noAck: false });
    if (message === false) break;
    seen.push(message);
  }

  console.log(`${seen.length} message(s) in ${parked}:\n`);
  for (const message of seen) {
    const death = message.properties.headers?.['x-death']?.[0];
    const body = message.content.toString();
    console.log(`  routing key : ${death?.['routing-keys']?.[0] ?? '(unknown)'}`);
    console.log(`  parked at   : ${death?.time ?? '(unknown)'}`);
    console.log(`  died        : ${death?.count ?? 1} time(s)`);
    console.log(`  body        : ${body.slice(0, 300)}`);
    console.log('');
  }

  // Closing without acking returns every message to the queue untouched.
  await channel.close();
  await connection.close();
  process.exit(0);
}

// ------------------------------------------------------------------ replay
if (typeof replay === 'string') {
  const parked = `${replay}.parked`;
  let moved = 0;

  // Publisher confirms. Without them, `publish` only means "handed to the
  // socket" — and acking the parked copy on the strength of that is exactly
  // how a replay loses the message it was rescuing.
  const confirms = await connection.createConfirmChannel();

  for (let i = 0; i < limit; i += 1) {
    const message = await channel.get(parked, { noAck: false });
    if (message === false) break;

    const death = message.properties.headers?.['x-death']?.[0];
    const routingKey = death?.['routing-keys']?.[0];

    if (routingKey === undefined) {
      // No x-death header means this did not arrive by dead-lettering, so
      // there is nothing to say where it should go. Leave it where it is.
      channel.nack(message, false, true);
      console.log('  skipped a message with no x-death header');
      continue;
    }

    await new Promise((resolve, reject) => {
      confirms.publish(
        EXCHANGE,
        routingKey,
        message.content,
        {
          // The original properties, minus the x-death header — otherwise
          // the replayed message carries a death count that is no longer
          // true and every future look at it is misleading.
          ...message.properties,
          headers: { ...message.properties.headers, 'x-death': undefined },
          persistent: true,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });

    // ONLY NOW. The broker has confirmed it holds the republished copy.
    channel.ack(message);
    moved += 1;
    console.log(`  replayed ${routingKey}`);
  }

  console.log(`\n${moved} message(s) replayed from ${parked} to ${EXCHANGE}.`);
  if (moved > 0) {
    console.log(
      'If the cause is not fixed, they will park again — which is the loop working, not a bug.',
    );
  }

  await confirms.close();
  await channel.close();
  await connection.close();
  process.exit(0);
}
