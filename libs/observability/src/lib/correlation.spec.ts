import {
  CORRELATION_ID_HEADER,
  correlationHeaders,
  correlationIdForEvent,
  currentCorrelationId,
  newCorrelationId,
  runWithCorrelationId,
} from './correlation';

/**
 * Tests for the correlation scope.
 *
 * These exist because the failure they guard against is invisible: a
 * correlation id that leaks between concurrent requests produces logs that
 * look perfectly fine and attribute one customer's actions to another. You
 * do not notice until you are debugging with them, and by then you trust
 * them.
 */
describe('correlation scope', () => {
  it('is undefined outside any scope', () => {
    // Not an error. Bootstrap code, timers and tests all run outside a
    // request, and logging is not allowed to throw because of it.
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('is readable anywhere inside the scope, however deep', async () => {
    await runWithCorrelationId('abc-123', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      // Several awaits later, still there — which is the whole reason this
      // is AsyncLocalStorage and not a parameter threaded through forty
      // function signatures.
      expect(currentCorrelationId()).toBe('abc-123');
    });
  });

  it('does not leak between concurrent operations', async () => {
    const seen: string[] = [];

    const first = runWithCorrelationId('first', async () => {
      // Yield, giving the other operation a chance to overwrite a naive
      // module-level variable.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentCorrelationId() ?? 'lost');
    });

    const second = runWithCorrelationId('second', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentCorrelationId() ?? 'lost');
    });

    await Promise.all([first, second]);

    // THE ASSERTION THAT MATTERS. A `let currentId` would have both of these
    // reporting 'second', and every log line of the first request would be
    // filed under the wrong customer.
    expect(seen.sort()).toEqual(['first', 'second']);
  });

  it('does not outlive the scope', async () => {
    await runWithCorrelationId('inside', async () => {
      expect(currentCorrelationId()).toBe('inside');
    });

    expect(currentCorrelationId()).toBeUndefined();
  });
});

describe('propagation helpers', () => {
  it('produces a header only when there is something to propagate', () => {
    expect(correlationHeaders()).toEqual({});

    runWithCorrelationId('abc-123', () => {
      expect(correlationHeaders()).toEqual({
        [CORRELATION_ID_HEADER]: 'abc-123',
      });
    });
  });

  it('gives an event the current id, or a fresh one', () => {
    runWithCorrelationId('abc-123', () => {
      expect(correlationIdForEvent()).toBe('abc-123');
    });

    // Published outside a request — a background job, a timer. A new id is
    // better than none: it at least keeps the downstream half of the story
    // together.
    const orphan = correlationIdForEvent();
    expect(orphan).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints distinct ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});
