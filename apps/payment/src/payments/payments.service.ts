import {
  buildPageMeta,
  CreatePaymentDto,
  EventPattern,
  EVENTS_CLIENT,
  PageMetaDto,
  PaymentDto,
  PaymentFailureCode,
  PaymentStatus,
  QueryPaymentsDto,
  type PaymentFailedPayload,
  type PaymentSucceededPayload,
} from '@ecommerce/contracts';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { OrderClientService } from '../orders/order-client.service';
import { MockProviderService } from '../provider/mock-provider.service';
import { PaymentRecord, PaymentsRepository } from './payments.repository';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Taking money — the simple version, on purpose.
 *
 * THE SHAPE OF EVERY PAYMENT, and the order is not negotiable:
 *
 *   1. read the order          amount and ownership from the server
 *   2. write PENDING           before the provider is called, so a crash
 *                              mid-charge still leaves evidence
 *   3. call the provider       approved · declined · no answer
 *   4. settle the row          and publish what happened
 *
 * Step 2 before step 3 is the rule that separates a payment service from a
 * form that calls an API. If the row is written afterwards, then a process
 * that dies mid-charge leaves a customer who may have been charged and a
 * database with no record that anything was ever attempted.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — pass 2 of this milestone:
 *
 *   NO IDEMPOTENCY KEY. Send the same request twice and you get two
 *   payments. If both succeed, the customer is charged twice. This is easy
 *   to reproduce and worth reproducing once.
 *
 *   NOTHING STOPS TWO SUCCESSFUL PAYMENTS ON ONE ORDER. The index that
 *   would refuse the second is named in the migration and left out.
 *
 *   NO AUTOMATIC RETRY of a retryable failure. The API says whether a retry
 *   is worth making; nothing here makes it.
 *
 *   NO REFUND. A refund is a separate signed record, not a deleted payment,
 *   and it needs its own endpoint and its own event.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly payments: PaymentsRepository,
    private readonly orders: OrderClientService,
    private readonly provider: MockProviderService,
    @Inject(EVENTS_CLIENT) private readonly events: ClientProxy,
  ) {}

  async pay(userId: string, dto: CreatePaymentDto): Promise<PaymentDto> {
    // ── 1. what are we charging for, and how much ──────────────────────
    const order = await this.orders.fetchPayable(userId, dto.orderId);

    // Display-only details. The token itself is never returned to the
    // client and never logged.
    const card = this.provider.describe(dto.paymentMethodToken);

    // ── 2. write the attempt BEFORE calling out ───────────────────────
    const pending = await this.payments.createPending({
      orderId: order.id,
      orderNumber: order.orderNumber,
      userId,
      amount: order.amount,
      currency: order.currency,
      paymentMethodToken: dto.paymentMethodToken,
      cardLast4: card.last4,
      cardBrand: card.brand,
    });

    // ── 3. ask the provider ───────────────────────────────────────────
    const result = await this.provider.charge(
      dto.paymentMethodToken,
      order.amount,
      order.currency,
    );

    // ── 4. record it, and say what happened ───────────────────────────
    if (result.outcome === 'APPROVED') {
      const settled = await this.settle(pending, {
        status: PaymentStatus.Succeeded,
        providerReference: result.providerReference,
        failureCode: null,
        failureMessage: null,
        retryable: false,
      });

      this.logger.log(
        `${settled.reference}: ${settled.amount} ${settled.currency} approved for ${settled.orderNumber}`,
      );

      this.events.emit(EventPattern.PaymentSucceeded, {
        paymentId: settled.id,
        reference: settled.reference,
        orderId: settled.orderId,
        userId,
        amount: settled.amount,
        currency: settled.currency,
        providerReference: result.providerReference,
      } satisfies PaymentSucceededPayload);

      return toDto(settled);
    }

    if (result.outcome === 'DECLINED') {
      const settled = await this.settle(pending, {
        status: PaymentStatus.Declined,
        providerReference: result.providerReference,
        failureCode: result.code,
        failureMessage: result.message,
        // A decline is a decision, not an accident. The same request will be
        // declined again, so telling a client to retry would be a lie that
        // costs the customer a queue of failed attempts on their statement.
        retryable: false,
      });

      this.logger.warn(
        `${settled.reference}: declined (${result.code}) for ${settled.orderNumber}`,
      );

      this.emitFailure(settled, userId);

      // 402 Payment Required — the one status code that means exactly this.
      // Not 400: the request was perfectly well formed. Not 500: nothing
      // went wrong on our side. Not 503: retrying will not help.
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: result.message,
          paymentId: settled.id,
          reference: settled.reference,
          failureCode: result.code,
          retryable: false,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // ── ERROR: we do not know what happened ───────────────────────────
    const settled = await this.settle(pending, {
      status: PaymentStatus.Failed,
      // No provider reference — the request never got far enough to earn
      // one, which is precisely why this case is hard to reconcile.
      providerReference: null,
      failureCode: result.code,
      failureMessage: result.message,
      retryable: true,
    });

    this.logger.error(
      `${settled.reference}: ${result.code} for ${settled.orderNumber} — outcome UNKNOWN, may have been charged`,
    );

    this.emitFailure(settled, userId);

    // 503, and the body says `retryable: true`. The honest message is not
    // "payment failed" — it is "we could not confirm this", which is a
    // different thing and the reason the payment id comes back with it.
    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: result.message,
      paymentId: settled.id,
      reference: settled.reference,
      failureCode: result.code,
      retryable: true,
    });
  }

  async findOne(userId: string, paymentId: string): Promise<PaymentDto> {
    const payment = await this.payments.findOne(userId, paymentId);
    if (payment === null) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    return toDto(payment);
  }

  async list(
    userId: string,
    query: QueryPaymentsDto,
  ): Promise<{ data: PaymentDto[]; meta: PageMetaDto }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const { rows, total } = await this.payments.list(userId, page, limit, {
      orderId: query.orderId,
      status: query.status,
    });

    return {
      data: rows.map(toDto),
      meta: buildPageMeta(page, limit, total),
    };
  }

  /**
   * Settles the attempt, or explains loudly why it could not be settled.
   *
   * `settle` returning null means the row was no longer PENDING — something
   * else already recorded an outcome for this attempt. That should be
   * impossible in this flow, and "impossible" states are exactly the ones
   * worth failing on rather than papering over.
   */
  private async settle(
    pending: PaymentRecord,
    outcome: Parameters<PaymentsRepository['settle']>[1],
  ): Promise<PaymentRecord> {
    const settled = await this.payments.settle(pending.id, outcome);

    if (settled === null) {
      this.logger.error(
        `${pending.reference}: could not settle — the attempt was no longer PENDING`,
      );
      throw new ServiceUnavailableException(
        'The payment could not be completed. Please check your payments before trying again.',
      );
    }

    return settled;
  }

  private emitFailure(payment: PaymentRecord, userId: string): void {
    this.events.emit(EventPattern.PaymentFailed, {
      paymentId: payment.id,
      reference: payment.reference,
      orderId: payment.orderId,
      userId,
      amount: payment.amount,
      currency: payment.currency,
      failureCode: payment.failureCode ?? PaymentFailureCode.DoNotHonour,
      retryable: payment.retryable,
    } satisfies PaymentFailedPayload);
  }
}

function toDto(record: PaymentRecord): PaymentDto {
  return {
    id: record.id,
    reference: record.reference,
    orderId: record.orderId,
    orderNumber: record.orderNumber,
    userId: record.userId,
    status: record.status,
    amount: record.amount,
    currency: record.currency,
    retryable: record.retryable,
    // The token is NOT here, deliberately. The client sent it and does not
    // need it echoed; anything that is echoed ends up in a log somewhere.
    ...(record.providerReference !== null
      ? { providerReference: record.providerReference }
      : {}),
    ...(record.failureCode !== null ? { failureCode: record.failureCode } : {}),
    ...(record.failureMessage !== null
      ? { failureMessage: record.failureMessage }
      : {}),
    ...(record.cardLast4 !== null ? { cardLast4: record.cardLast4 } : {}),
    ...(record.cardBrand !== null ? { cardBrand: record.cardBrand } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Exported for the unit tests. */
export const __toDto = toDto;
