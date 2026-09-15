import { NotificationStatus, NotificationType } from '@ecommerce/contracts';
import type { MailerService } from '../mailer/mailer.service';
import type { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Unit tests for turning events into emails.
 *
 * WHAT THESE PROVE
 *
 *   ✅ a new customer is remembered BEFORE the welcome is attempted
 *   ✅ the address comes from the local projection, not from the event
 *   ✅ a customer with no contact row is recorded as FAILED, not skipped
 *   ✅ a transport failure is recorded and does NOT throw — because
 *      throwing would make RabbitMQ redeliver and re-send
 *   ✅ the rendered email carries the order number and an exact total
 *
 *   ✅ a second delivery of the same event sends nothing
 *
 *   ❌ that the ledger holds under real concurrency. The primary key is what
 *      makes that true, and only a real database can prove it.
 */
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
// A DIFFERENT id from the event id, on purpose: this one is the customer's
// whole journey, and every event of one checkout shares it.
const CORRELATION_ID = '66666666-6666-4666-8666-666666666666';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';

function build() {
  const repo = {
    // Claims succeed by default: the ordinary case is an event nobody has
    // handled yet.
    claimEvent: jest.fn().mockResolvedValue(true),
    releaseEvent: jest.fn().mockResolvedValue(undefined),
    upsertContact: jest.fn().mockResolvedValue(undefined),
    findContact: jest.fn().mockResolvedValue({
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
    }),
    record: jest.fn().mockResolvedValue(undefined),
    list: jest.fn(),
  };

  const mailer = {
    send: jest.fn().mockResolvedValue({ sent: true, detail: 'logged' }),
  };

  const service = new NotificationsService(
    repo as unknown as NotificationsRepository,
    mailer as unknown as MailerService,
  );

  return { service, repo, mailer };
}

describe('NotificationsService.onUserRegistered', () => {
  it('remembers the contact before sending anything', async () => {
    const { service, repo, mailer } = build();

    await service.onUserRegistered({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
    });

    expect(repo.upsertContact).toHaveBeenCalledWith({
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
    });
    // THE ORDERING: every later email depends on that row existing, so a
    // failed welcome must not cost us the address.
    expect(repo.upsertContact.mock.invocationCallOrder[0]).toBeLessThan(
      mailer.send.mock.invocationCallOrder[0],
    );
  });

  it('greets the customer by name', async () => {
    const { service, mailer } = build();

    await service.onUserRegistered({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
    });

    const [email] = mailer.send.mock.calls[0];
    expect(email.to).toBe('ada@example.test');
    expect(email.text).toContain('Hello Ada');
    // Both parts, every time: the plain-text part is what screen readers and
    // spam filters actually read.
    expect(email.html).toContain('Ada');
  });

  it('falls back to a neutral greeting when there is no name', async () => {
    const { service, mailer } = build();

    await service.onUserRegistered({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: '   ',
    });

    const [email] = mailer.send.mock.calls[0];
    expect(email.text).toContain('Hello there');
  });
});

describe('NotificationsService.onOrderConfirmed', () => {
  const order = {
    eventId: EVENT_ID,
    correlationId: CORRELATION_ID,
    orderId: ORDER_ID,
    orderNumber: 'ORD-00000042',
    userId: USER_ID,
    cartId: 'cart-1',
    total: '48.24',
    currency: 'USD',
    lines: [
      {
        productId: 'p1',
        sku: 'LAP-X1C',
        quantity: 3,
        unitPrice: '16.08',
      },
    ],
  };

  it('takes the address from the local projection, not from the event', async () => {
    const { service, repo, mailer } = build();

    await service.onOrderConfirmed(order);

    // The event carries a userId and no address. Looking it up locally is
    // what keeps this service from calling the Auth Service on every email.
    expect(repo.findContact).toHaveBeenCalledWith(USER_ID);
    const [email] = mailer.send.mock.calls[0];
    expect(email.to).toBe('ada@example.test');
  });

  it('puts the order number in the subject and the exact total in the body', async () => {
    const { service, mailer } = build();

    await service.onOrderConfirmed(order);

    const [email] = mailer.send.mock.calls[0];
    // The order number is what a customer searches their inbox for.
    expect(email.subject).toBe('Order ORD-00000042 confirmed');
    expect(email.text).toContain('$48.24');
    expect(email.text).toContain('3 × LAP-X1C');
    // Said out loud, because a customer who thinks they have paid will not
    // answer the email asking them to.
    expect(email.text).toContain('not a payment receipt');
  });

  it('records a FAILURE when there is no contact, and sends nothing', async () => {
    const { service, repo, mailer } = build();
    // A customer who registered before this service existed, or whose
    // `user.registered` event was lost.
    repo.findContact.mockResolvedValue(null);

    await service.onOrderConfirmed(order);

    expect(mailer.send).not.toHaveBeenCalled();
    const [recorded] = repo.record.mock.calls[0];
    expect(recorded.status).toBe(NotificationStatus.Failed);
    expect(recorded.type).toBe(NotificationType.OrderConfirmed);
    // Recorded rather than silently skipped: an email nobody received is
    // exactly what support needs to be able to find.
    expect(recorded.failureReason).toContain('No contact on file');
  });
});

describe('NotificationsService.onPaymentSucceeded', () => {
  it('sends a receipt carrying the provider reference', async () => {
    const { service, mailer } = build();

    await service.onPaymentSucceeded({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      paymentId: 'pay-1',
      reference: 'PAY-00000007',
      orderId: ORDER_ID,
      userId: USER_ID,
      amount: '48.24',
      currency: 'USD',
      providerReference: 'ch_abc123',
    });

    const [email] = mailer.send.mock.calls[0];
    expect(email.subject).toContain('PAY-00000007');
    // The provider's id is the only thing that lets a bank or a support
    // agent match this to a line on a statement.
    expect(email.text).toContain('ch_abc123');
  });
});

describe('NotificationsService — a transport failure', () => {
  it('records it and does not throw', async () => {
    const { service, repo, mailer } = build();
    mailer.send.mockResolvedValue({ sent: false, reason: 'ECONNREFUSED' });

    // THE ASSERTION THAT MATTERS. Throwing out of a handler makes Nest nack
    // the message and RabbitMQ redeliver it — retrying a broken address
    // forever, and re-sending an email that may already have gone out.
    await expect(
      service.onUserRegistered({
        eventId: EVENT_ID,
        correlationId: CORRELATION_ID,
        userId: USER_ID,
        email: 'ada@example.test',
        firstName: 'Ada',
      }),
    ).resolves.toBeUndefined();

    const [recorded] = repo.record.mock.calls[0];
    expect(recorded.status).toBe(NotificationStatus.Failed);
    expect(recorded.failureReason).toBe('ECONNREFUSED');
    // The recipient is still recorded, so you can see who did not get it.
    expect(recorded.recipient).toBe('ada@example.test');
  });
});

describe('NotificationsService — at-least-once delivery', () => {
  const order = {
    eventId: EVENT_ID,
    correlationId: CORRELATION_ID,
    orderId: ORDER_ID,
    orderNumber: 'ORD-00000042',
    userId: USER_ID,
    cartId: 'cart-1',
    total: '48.24',
    currency: 'USD',
    lines: [
      { productId: 'p1', sku: 'LAP-X1C', quantity: 3, unitPrice: '16.08' },
    ],
  };

  it('sends nothing when the event has already been handled', async () => {
    const { service, repo, mailer } = build();
    // The INSERT into processed_events hit the primary key: somebody has
    // this one already.
    repo.claimEvent.mockResolvedValue(false);

    await service.onOrderConfirmed(order);

    // THE ASSERTION THAT MATTERS. Every other consumer in this system
    // survives a redelivery by being naturally repeatable. There is no WHERE
    // clause that un-sends an email, so this one has to recognise the repeat.
    expect(mailer.send).not.toHaveBeenCalled();
    expect(repo.record).not.toHaveBeenCalled();
  });

  it('claims the event BEFORE sending', async () => {
    const { service, repo, mailer } = build();

    await service.onOrderConfirmed(order);

    // The ordering is a deliberate trade: a crash in between costs ONE
    // MISSED EMAIL, where claiming afterwards would cost a duplicate on
    // every crash. A missing receipt can be found in GET /notifications and
    // resent; a customer who gets three receipts concludes the shop is
    // broken.
    expect(repo.claimEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mailer.send.mock.invocationCallOrder[0],
    );
    expect(repo.claimEvent).toHaveBeenCalledWith(EVENT_ID, 'order.confirmed');
  });

  it('releases the claim when the handler throws, so a redelivery retries', async () => {
    const { service, repo } = build();
    // Not a failed SEND — those are recorded, not thrown. This is the
    // database refusing a write, or something equally unexpected.
    repo.findContact.mockRejectedValue(new Error('connection terminated'));

    await expect(service.onOrderConfirmed(order)).rejects.toThrow();

    expect(repo.releaseEvent).toHaveBeenCalledWith(EVENT_ID);
  });

  it('still records the contact when the welcome is a duplicate', async () => {
    const { service, repo, mailer } = build();
    repo.claimEvent.mockResolvedValue(false);

    await service.onUserRegistered({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      userId: USER_ID,
      email: 'ada@example.test',
      firstName: 'Ada',
    });

    // The upsert sits OUTSIDE the claim on purpose: it is naturally
    // repeatable, and every later email depends on that row existing.
    expect(repo.upsertContact).toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
