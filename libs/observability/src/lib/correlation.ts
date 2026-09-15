import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** The header the correlation id travels in, between services. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

interface CorrelationStore {
  correlationId: string;
}

/**
 * Where the current correlation id lives.
 *
 * `AsyncLocalStorage` is Node's answer to "I need a value available
 * everywhere inside one logical operation, without passing it through every
 * function signature". It keeps a store bound to an async execution context,
 * so anything running inside `run()` — however many awaits deep — can read
 * it, while a concurrent request sees its own.
 *
 * WHY NOT A MODULE-LEVEL VARIABLE. Because Node serves requests
 * concurrently: a `let currentCorrelationId` would be overwritten by the next
 * request the moment the first one awaited anything, and every log line
 * afterwards would carry the wrong id. That bug is silent, intermittent, and
 * only appears under load.
 *
 * WHY NOT NEST'S REQUEST SCOPE. Nest can inject a request-scoped provider,
 * and it works for HTTP — but it means marking providers REQUEST scope,
 * which makes them (and everything that injects them) rebuild per request.
 * It also does not help at all in a RabbitMQ handler, where there is no
 * request. This works the same in both.
 */
const storage = new AsyncLocalStorage<CorrelationStore>();

/** A fresh correlation id, for a request that arrived without one. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Runs `fn` with a correlation id in scope.
 *
 * Everything awaited inside — controllers, services, repositories, the
 * logger — sees the same id. Called once at each ENTRY POINT into a service:
 * an HTTP request, or a message handler.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/**
 * The correlation id for the current operation, if there is one.
 *
 * Returns undefined outside any scope — during bootstrap, in a background
 * timer, in a test. That is deliberately not an error: logging is not
 * allowed to throw just because it does not know which request it belongs
 * to.
 */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * The header to attach to an outbound call, so the next service continues
 * the same story.
 *
 * PROPAGATION IS A DELIBERATE ACT. There is no framework magic that carries
 * this across a network hop — every outbound client has to send it, and the
 * day one of them forgets, the trail stops there and nobody notices until
 * they are trying to debug that exact path. Spreading this into an existing
 * headers object keeps the omission visible in review.
 */
export function correlationHeaders(): Record<string, string> {
  const correlationId = currentCorrelationId();
  return correlationId === undefined
    ? {}
    : { [CORRELATION_ID_HEADER]: correlationId };
}

/**
 * The correlation id to stamp on an event that is about to be published.
 *
 * Falls back to a NEW id rather than to undefined, because an event with no
 * correlation id is a dead end: whatever consumes it — possibly minutes
 * later, in another process — has nothing to join its logs to. A fresh id at
 * least keeps the downstream half of the story together.
 *
 * The fallback should be rare. It happens when something publishes outside
 * any request: a background job, a timer, a startup task.
 */
export function correlationIdForEvent(): string {
  return currentCorrelationId() ?? newCorrelationId();
}
