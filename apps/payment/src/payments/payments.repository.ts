import { PaymentFailureCode, PaymentStatus } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Payment } from './payment.model';

export interface CreatePaymentInput {
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
   */
  async createPending(input: CreatePaymentInput): Promise<PaymentRecord> {
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
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
