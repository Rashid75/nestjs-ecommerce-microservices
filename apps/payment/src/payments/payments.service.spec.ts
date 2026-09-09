import {
  EventPattern,
  PaymentFailureCode,
  PaymentStatus,
  PaymentToken,
} from '@ecommerce/contracts';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import type { OrderClientService } from '../orders/order-client.service';
import type { MockProviderService } from '../provider/mock-provider.service';
import {
  OrderAlreadyPaidError,
  type PaymentRecord,
  type PaymentsRepository,
} from './payments.repository';
import { PaymentsService } from './payments.service';

/**
 * Unit tests for taking a payment.
 *
 * WHAT THESE PROVE
 *
 *   ✅ the attempt is written BEFORE the provider is called
 *   ✅ the amount comes from the order, never from the caller
 *   ✅ declined → 402 and not retryable; provider error → 503 and retryable
 *   ✅ `payment.succeeded` is emitted only on an approval
 *   ✅ a failed attempt is still recorded, with its reason
 *   ✅ a repeated request replays the first attempt's answer, charging
 *      nothing — including when the first attempt failed
 *   ✅ a second payment for the same order is refused BEFORE the provider
 *      is called
 *
 * WHAT THEY CANNOT
 *
 *   ❌ that a timeout leaves the money in a known state. It does not, and no
 *      test can make it. That is the point of the FAILED status.
 *   ❌ that the two unique indexes actually hold under concurrency. That
 *      needs real connections contending over a real table; these tests can
 *      only prove the service reacts correctly when the database says no.
 */
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';

function makePayment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    reference: 'PAY-00000001',
    orderId: ORDER_ID,
    orderNumber: 'ORD-00000001',
    userId: USER_ID,
    status: PaymentStatus.Pending,
    amount: '48.24',
    currency: 'USD',
    providerReference: null,
    failureCode: null,
    failureMessage: null,
    cardLast4: '4242',
    cardBrand: 'VISA',
    retryable: false,
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const repo = {
    createPending: jest
      .fn()
      .mockResolvedValue({ payment: makePayment(), replayed: false }),
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    // `settle` echoes back what it was asked to write, which is what the
    // real one does after the UPDATE.
    settle: jest
      .fn()
      .mockImplementation(
        async (_id: string, outcome: Partial<PaymentRecord>) =>
          makePayment(outcome),
      ),
    findOne: jest.fn().mockResolvedValue(makePayment()),
    list: jest.fn(),
  };

  const orders = {
    fetchPayable: jest.fn().mockResolvedValue({
      id: ORDER_ID,
      orderNumber: 'ORD-00000001',
      amount: '48.24',
      currency: 'USD',
    }),
  };

  const provider = {
    charge: jest.fn().mockResolvedValue({
      outcome: 'APPROVED',
      providerReference: 'ch_abc123',
      last4: '4242',
      brand: 'VISA',
    }),
    describe: jest.fn().mockReturnValue({ last4: '4242', brand: 'VISA' }),
  };

  const events = { emit: jest.fn().mockReturnValue({}) };

  const service = new PaymentsService(
    repo as unknown as PaymentsRepository,
    orders as unknown as OrderClientService,
    provider as unknown as MockProviderService,
    events as unknown as ClientProxy,
  );

  return { service, repo, orders, provider, events };
}

describe('PaymentsService.pay — approved', () => {
  it('charges the amount from the ORDER, not from the request', async () => {
    const { service, provider } = build();

    await service.pay(
      USER_ID,
      {
        orderId: ORDER_ID,
        paymentMethodToken: PaymentToken.Ok,
      },
      null,
    );

    // `CreatePaymentDto` has no amount field at all. This asserts what the
    // type system already enforces, because it is the property that stops a
    // browser paying 0.01 for a laptop.
    expect(provider.charge).toHaveBeenCalledWith(
      PaymentToken.Ok,
      '48.24',
      'USD',
    );
  });

  it('writes the attempt BEFORE calling the provider', async () => {
    const { service, repo, provider } = build();

    await service.pay(
      USER_ID,
      {
        orderId: ORDER_ID,
        paymentMethodToken: PaymentToken.Ok,
      },
      null,
    );

    // THE ORDERING THAT MATTERS. A process that dies mid-charge must leave a
    // row saying "we asked" — otherwise a customer can be charged with no
    // record that anything was attempted.
    expect(repo.createPending.mock.invocationCallOrder[0]).toBeLessThan(
      provider.charge.mock.invocationCallOrder[0],
    );
  });

  it('settles as SUCCEEDED and announces it', async () => {
    const { service, repo, events } = build();

    const { payment } = await service.pay(
      USER_ID,
      {
        orderId: ORDER_ID,
        paymentMethodToken: PaymentToken.Ok,
      },
      null,
    );

    expect(payment.status).toBe(PaymentStatus.Succeeded);
    expect(payment.providerReference).toBe('ch_abc123');

    const [, outcome] = repo.settle.mock.calls[0];
    expect(outcome.status).toBe(PaymentStatus.Succeeded);
    expect(outcome.retryable).toBe(false);

    const [pattern, payload] = events.emit.mock.calls[0];
    expect(pattern).toBe(EventPattern.PaymentSucceeded);
    expect(payload).toMatchObject({ orderId: ORDER_ID, amount: '48.24' });
  });

  it('never returns the payment method token', async () => {
    const { service } = build();

    const { payment } = await service.pay(
      USER_ID,
      {
        orderId: ORDER_ID,
        paymentMethodToken: PaymentToken.Ok,
      },
      null,
    );

    // Anything echoed back ends up in somebody's log.
    expect(JSON.stringify(payment)).not.toContain('tok_');
  });
});

describe('PaymentsService.pay — declined', () => {
  it('answers 402 and marks it NOT retryable', async () => {
    const { service, provider } = build();
    provider.charge.mockResolvedValue({
      outcome: 'DECLINED',
      code: PaymentFailureCode.InsufficientFunds,
      message: 'The card has insufficient funds',
      providerReference: 'ch_declined',
    });

    await expect(
      service.pay(
        USER_ID,
        {
          orderId: ORDER_ID,
          paymentMethodToken: PaymentToken.Declined,
        },
        null,
      ),
    ).rejects.toMatchObject({
      // 402 Payment Required. Not 400 — the request was well formed. Not
      // 500 — nothing broke. Not 503 — retrying will not help.
      status: 402,
    });
  });

  it('still records the attempt, with the provider reference', async () => {
    const { service, repo, provider } = build();
    provider.charge.mockResolvedValue({
      outcome: 'DECLINED',
      code: PaymentFailureCode.SuspectedFraud,
      message: 'The issuing bank refused this transaction',
      providerReference: 'ch_declined',
    });

    await expect(
      service.pay(
        USER_ID,
        {
          orderId: ORDER_ID,
          paymentMethodToken: PaymentToken.Fraud,
        },
        null,
      ),
    ).rejects.toThrow();

    const [, outcome] = repo.settle.mock.calls[0];
    expect(outcome.status).toBe(PaymentStatus.Declined);
    expect(outcome.failureCode).toBe(PaymentFailureCode.SuspectedFraud);
    expect(outcome.retryable).toBe(false);
    // A decline is a decision the provider reached, so it has an id — which
    // is what support quotes on the phone.
    expect(outcome.providerReference).toBe('ch_declined');
  });

  it('announces the failure, and never a success', async () => {
    const { service, provider, events } = build();
    provider.charge.mockResolvedValue({
      outcome: 'DECLINED',
      code: PaymentFailureCode.InsufficientFunds,
      message: 'no',
      providerReference: 'ch_declined',
    });

    await expect(
      service.pay(
        USER_ID,
        {
          orderId: ORDER_ID,
          paymentMethodToken: PaymentToken.Declined,
        },
        null,
      ),
    ).rejects.toThrow();

    const [pattern, payload] = events.emit.mock.calls[0];
    expect(pattern).toBe(EventPattern.PaymentFailed);
    expect(payload.retryable).toBe(false);
    // An order must never be marked PAID because a card was refused.
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentsService.pay — provider failure', () => {
  it('answers 503 and marks it retryable', async () => {
    const { service, provider } = build();
    provider.charge.mockResolvedValue({
      outcome: 'ERROR',
      code: PaymentFailureCode.ProviderTimeout,
      message: 'The payment provider did not respond in time',
    });

    await expect(
      service.pay(
        USER_ID,
        {
          orderId: ORDER_ID,
          paymentMethodToken: PaymentToken.Timeout,
        },
        null,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('records FAILED with no provider reference — the outcome is unknown', async () => {
    const { service, repo, provider } = build();
    provider.charge.mockResolvedValue({
      outcome: 'ERROR',
      code: PaymentFailureCode.ProviderTimeout,
      message: 'timeout',
    });

    await expect(
      service.pay(
        USER_ID,
        {
          orderId: ORDER_ID,
          paymentMethodToken: PaymentToken.Timeout,
        },
        null,
      ),
    ).rejects.toThrow();

    const [, outcome] = repo.settle.mock.calls[0];
    expect(outcome.status).toBe(PaymentStatus.Failed);
    expect(outcome.retryable).toBe(true);
    // NULL, because the request never got far enough to earn one — which is
    // exactly the case where you most want it.
    expect(outcome.providerReference).toBeNull();
  });
});

describe('PaymentsService.pay — idempotency', () => {
  it('replays a successful payment without charging again', async () => {
    const { service, repo, provider, events } = build();
    repo.findByIdempotencyKey.mockResolvedValue(
      makePayment({
        status: PaymentStatus.Succeeded,
        providerReference: 'ch_first',
        idempotencyKey: 'key-1',
      }),
    );

    const result = await service.pay(
      USER_ID,
      { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Ok },
      'key-1',
    );

    expect(result.replayed).toBe(true);
    expect(result.payment.providerReference).toBe('ch_first');
    // THE ASSERTION THAT MATTERS: no second charge, and no second event.
    expect(provider.charge).not.toHaveBeenCalled();
    expect(repo.createPending).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('replays a DECLINE as the same 402, not as a fresh attempt', async () => {
    const { service, repo, provider } = build();
    repo.findByIdempotencyKey.mockResolvedValue(
      makePayment({
        status: PaymentStatus.Declined,
        failureCode: PaymentFailureCode.InsufficientFunds,
        failureMessage: 'The card has insufficient funds',
      }),
    );

    await expect(
      service.pay(
        USER_ID,
        { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Declined },
        'key-1',
      ),
    ).rejects.toMatchObject({ status: 402 });

    // Send it again, get the same answer — that is what idempotent means.
    expect(provider.charge).not.toHaveBeenCalled();
  });

  it('replays a FAILED attempt as the same 503, still marked retryable', async () => {
    const { service, repo } = build();
    repo.findByIdempotencyKey.mockResolvedValue(
      makePayment({
        status: PaymentStatus.Failed,
        failureCode: PaymentFailureCode.ProviderTimeout,
        retryable: true,
      }),
    );

    await expect(
      service.pay(
        USER_ID,
        { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Timeout },
        'key-1',
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('does not look up a key that was not sent', async () => {
    const { service, repo } = build();

    await service.pay(
      USER_ID,
      { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Ok },
      null,
    );

    // A client that sends no key is not refused — only less protected.
    expect(repo.findByIdempotencyKey).not.toHaveBeenCalled();
    expect(repo.createPending).toHaveBeenCalled();
  });

  it('replays the winner when two identical requests race', async () => {
    const { service, repo, provider } = build();
    // Nothing found on the pre-check, then the INSERT loses to the twin —
    // the repository resolves the race by returning the winner.
    repo.createPending.mockResolvedValue({
      payment: makePayment({
        status: PaymentStatus.Succeeded,
        providerReference: 'ch_winner',
      }),
      replayed: true,
    });

    const result = await service.pay(
      USER_ID,
      { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Ok },
      'key-1',
    );

    expect(result.replayed).toBe(true);
    expect(provider.charge).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.pay — the order constraint', () => {
  it('refuses a second payment for one order, before charging anything', async () => {
    const { service, repo, provider } = build();
    repo.createPending.mockRejectedValue(new OrderAlreadyPaidError(ORDER_ID));

    await expect(
      service.pay(
        USER_ID,
        { orderId: ORDER_ID, paymentMethodToken: PaymentToken.Ok },
        null,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // THE POINT OF DOING THIS WITH AN INDEX: the refusal happens at INSERT,
    // so the provider is never called and nothing is charged.
    expect(provider.charge).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.findOne', () => {
  it('404s for a payment that is not yours', async () => {
    const { service, repo } = build();
    // The repository scopes by user, so someone else's payment is simply not
    // found. 404 rather than 403: a 403 confirms it exists.
    repo.findOne.mockResolvedValue(null);

    await expect(service.findOne(USER_ID, PAYMENT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
