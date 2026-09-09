import { PaymentFailureCode, PaymentStatus } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { Payment } from './payment.model';

/**
 * Raised when this order already has a payment in flight or a successful
 * one, and the database refused a second.
 *
 * A named error rather than letting the UniqueConstraintError escape,
 * because the caller has to tell it apart from the idempotency collision —
 * they arrive as the same class from Sequelize and mean opposite things.
 */
export class OrderAlreadyPaidError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} already has an active or successful payment`);
    this.name = 'OrderAlreadyPaidError';
  }
}

export interface CreatePaymentInput {
  idempotencyKey: string | null;
  orderId: string;
  orderNumber: string;
  userId: string;
  amount: string;
  currency: string;
  paymentMethodToken: string;
  cardLast4: string | null;
  cardBrand: string | null;
}

export interface SettleInput {
  status: PaymentStatus;
  providerReference: string | null;
  failureCode: PaymentFailureCode | null;
  failureMessage: string | null;
  retryable: boolean;
}

export interface PaymentRecord {
  id: string;
  reference: string;
  orderId: string;
  orderNumber: string;
  userId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  providerReference: string | null;
  failureCode: PaymentFailureCode | null;
  failureMessage: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  retryable: boolean;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PaymentsRepository {
  constructor(
    @InjectModel(Payment) private readonly payments: typeof Payment,
  ) {}

  /**
   * Writes the attempt BEFORE the provider is called.
   *
   * The order matters more here than anywhere else in this project. If the
   * row were written after the answer came back, then a process that died
   * mid-charge would leave no trace of a customer who may well have been
   * charged. Writing PENDING first means the worst case is a row that says
   * "we asked, and we never found out" — which is a thing you can
   * reconcile, alert on, and explain.
   *
   * IT IS ALSO THE GUARD. Both unique indexes fire HERE, at insert time,
   * before a single penny has moved. That is the whole reason the row is
   * written first: a constraint that fired after the charge would leave the
   * customer paid and the database refusing to say so.
   *
   * Returns `{ payment }` when it wrote one, or `{ replay }` when this exact
   * request has been seen before. Throws `OrderAlreadyPaidError` when a
   * DIFFERENT request is trying to pay an order that is already covered.
   */
  async createPending(
    input: CreatePaymentInput,
  ): Promise<{ payment: PaymentRecord; replayed: boolean }> {
    // Checked before inserting, so the ordinary replay does not depend on
    // catching an exception. The catch below is still required — it is what
    // closes the race between two simultaneous retries — but a check that
    // usually succeeds keeps the common path readable.
    if (input.idempotencyKey !== null) {
      const seen = await this.findByIdempotencyKey(
        input.userId,
        input.idempotencyKey,
      );
      if (seen !== null) {
        return { payment: seen, replayed: true };
      }
    }

    try {
      return { payment: await this.insert(input), replayed: false };
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) {
        throw error;
      }

      // TWO INDEXES CAN FIRE HERE, and they mean opposite things.
      //
      //   the idempotency index  a retry of the SAME request lost a race
      //                          with itself. Return the winner's payment.
      //   the order index        a DIFFERENT request is trying to pay an
      //                          order that already has an active or
      //                          successful payment. Refuse it.
      //
      // Sequelize reports both as UniqueConstraintError, so the constraint
      // NAME is what tells them apart. Guessing instead — "if a key was
      // sent, assume it was the key" — would turn a genuine double-payment
      // attempt into a silent replay of an unrelated charge.
      const constraint = constraintName(error);

      if (
        constraint === 'payments_user_idempotency_key' &&
        input.idempotencyKey !== null
      ) {
        const winner = await this.findByIdempotencyKey(
          input.userId,
          input.idempotencyKey,
        );
        if (winner !== null) {
          return { payment: winner, replayed: true };
        }
      }

      if (constraint === 'payments_one_active_per_order') {
        throw new OrderAlreadyPaidError(input.orderId);
      }

      throw error;
    }
  }

  /** The attempt this user made under this key, if any. */
  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    const payment = await this.payments.findOne({
      where: { userId, idempotencyKey },
    });
    return payment === null ? null : toRecord(payment);
  }

  private async insert(input: CreatePaymentInput): Promise<PaymentRecord> {
    const payment = await this.payments.create(
      {
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        userId: input.userId,
        status: PaymentStatus.Pending,
        amount: input.amount,
        currency: input.currency,
        paymentMethodToken: input.paymentMethodToken,
        cardLast4: input.cardLast4,
        cardBrand: input.cardBrand,
        idempotencyKey: input.idempotencyKey,
      } as Payment,
      {
        // `reference` is NOT listed: it comes from the sequence DEFAULT, and
        // sending `undefined` would override that default with NULL.
        fields: [
          'orderId',
          'orderNumber',
          'userId',
          'status',
          'amount',
          'currency',
          'paymentMethodToken',
          'cardLast4',
          'cardBrand',
          'idempotencyKey',
        ],
      },
    );

    return toRecord(payment);
  }

  /**
   * Records what the provider said.
   *
   * `WHERE status = 'PENDING'` is a compare-and-set: an attempt is settled
   * exactly once. Without it, a stray second call could turn a DECLINED
   * payment into a SUCCEEDED one, which is the worst possible bug in this
   * service — a customer who was refused, marked as having paid.
   */
  async settle(
    paymentId: string,
    outcome: SettleInput,
  ): Promise<PaymentRecord | null> {
    const [affected] = await this.payments.update(
      {
        status: outcome.status,
        providerReference: outcome.providerReference,
        failureCode: outcome.failureCode,
        failureMessage: outcome.failureMessage,
        retryable: outcome.retryable,
      },
      { where: { id: paymentId, status: PaymentStatus.Pending } },
    );

    if (affected === 0) {
      return null;
    }

    return this.findById(paymentId);
  }

  /** One payment, always scoped by user. */
  async findOne(
    userId: string,
    paymentId: string,
  ): Promise<PaymentRecord | null> {
    const payment = await this.payments.findOne({
      where: { id: paymentId, userId },
    });
    return payment === null ? null : toRecord(payment);
  }

  async list(
    userId: string,
    page: number,
    limit: number,
    filters: { orderId?: string; status?: PaymentStatus },
  ): Promise<{ rows: PaymentRecord[]; total: number }> {
    const { rows, count } = await this.payments.findAndCountAll({
      where: {
        userId,
        ...(filters.orderId === undefined ? {} : { orderId: filters.orderId }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { rows: rows.map(toRecord), total: count };
  }

  private async findById(paymentId: string): Promise<PaymentRecord> {
    const payment = await this.payments.findByPk(paymentId);
    if (payment === null) {
      // Unreachable: we just updated it.
      throw new Error(`payment ${paymentId} vanished after settlement`);
    }
    return toRecord(payment);
  }
}

function toRecord(payment: Payment): PaymentRecord {
  return {
    id: payment.id,
    reference: payment.reference,
    orderId: payment.orderId,
    orderNumber: payment.orderNumber,
    userId: payment.userId,
    status: payment.status,
    // String all the way out — this is the number on someone's statement.
    amount: String(payment.amount),
    currency: payment.currency,
    providerReference: payment.providerReference,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    cardLast4: payment.cardLast4,
    cardBrand: payment.cardBrand,
    retryable: payment.retryable,
    idempotencyKey: payment.idempotencyKey,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

/**
 * The name of the index a UniqueConstraintError came from.
 *
 * Sequelize surfaces the driver's error as `.parent`, and `pg` puts the
 * constraint name on it. Typed loosely because the shape belongs to the
 * driver rather than to Sequelize's public API — and read defensively,
 * because an undefined constraint name must fall through to "rethrow"
 * rather than silently matching one of the branches above.
 */
function constraintName(error: UniqueConstraintError): string | undefined {
  const parent = error.parent as { constraint?: string } | undefined;
  return parent?.constraint;
}
