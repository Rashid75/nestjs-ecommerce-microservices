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
  newEventId,
} from '@ecommerce/contracts';
import {
  ConflictException,
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
import {
  OrderAlreadyPaidError,
  PaymentRecord,
  PaymentsRepository,
} from './payments.repository';

const DEFAULT_PAGE_SIZE = 20;

/** What `pay` returns: the payment, and whether it is a replay. */
export interface PaymentResult {
  payment: PaymentDto;
  replayed: boolean;
}

/**
 * Taking money.
 *
 * THE SHAPE OF EVERY PAYMENT, and the order is not negotiable:
 *
 *   0. have we seen this request before?   replay, charging nothing
 *   1. read the order                      amount and ownership, server-side
 *   2. write PENDING                       both unique indexes fire HERE,
 *                                          before a penny has moved
 *   3. call the provider                   approved · declined · no answer
 *   4. settle the row                      and publish what happened
 *
 * Step 2 before step 3 is the rule that separates a payment service from a
 * form that calls an API. It is where the record is created for a charge
 * that might die mid-flight, and it is where the database gets to refuse a
 * duplicate while refusing still costs nothing.
 *
 * TWO PROTECTIONS AGAINST A DOUBLE CHARGE, answering different questions.
 * Both are database constraints, because only a constraint is atomic:
 *
 *   THE ORDER INDEX refuses a second payment for an order that already has
 *   one in flight or successful. It is what stops the double charge.
 *
 *   THE IDEMPOTENCY KEY returns the FIRST attempt's answer when the same
 *   request arrives again. It is what a client that never found out what
 *   happened actually needs — a 409 would tell it nothing.
 *
 * A key identifies ONE attempt, including a failed one: retrying under the
 * same key replays that outcome. To genuinely try again — another card, or
 * after the provider recovers — the client sends a NEW key, and the order
 * index decides whether that is allowed.
 *
 * STILL NOT BUILT:
 *
 *   NO AUTOMATIC RETRY of a retryable failure. The API says whether a retry
 *   is worth making; nothing here makes it.
 *
 *   NO RECONCILIATION. A payment stuck PENDING blocks its order, because
 *   nothing goes back to the provider to ask what happened. Safer than
 *   charging twice, and it needs a human today.
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

  async pay(
    userId: string,
    dto: CreatePaymentDto,
    idempotencyKey: string | null,
  ): Promise<PaymentResult> {
    // ── 0. have we seen this exact request before? ─────────────────────
    //
    // Before the order lookup, before anything. A replay must not depend on
    // the Order Service being up: the customer has already been charged (or
    // already failed), and saying so is a read of our own database.
    if (idempotencyKey !== null) {
      const seen = await this.payments.findByIdempotencyKey(
        userId,
        idempotencyKey,
      );
      if (seen !== null) {
        return this.replay(seen);
      }
    }

    // ── 1. what are we charging for, and how much ──────────────────────
    const order = await this.orders.fetchPayable(userId, dto.orderId);

    // Display-only details. The token itself is never returned to the
    // client and never logged.
    const card = this.provider.describe(dto.paymentMethodToken);

    // ── 2. write the attempt BEFORE calling out ───────────────────────
    const created = await this.createAttempt({
      idempotencyKey,
      orderId: order.id,
      orderNumber: order.orderNumber,
      userId,
      amount: order.amount,
      currency: order.currency,
      paymentMethodToken: dto.paymentMethodToken,
      cardLast4: card.last4,
      cardBrand: card.brand,
    });

    // Two identical requests raced and this one lost. The winner's attempt
    // is what the caller gets — not a second charge.
    if (created.replayed) {
      return this.replay(created.payment);
    }

    const pending = created.payment;

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
        eventId: newEventId(),
        paymentId: settled.id,
        reference: settled.reference,
        orderId: settled.orderId,
        userId,
        amount: settled.amount,
        currency: settled.currency,
        providerReference: result.providerReference,
      } satisfies PaymentSucceededPayload);

      return { payment: toDto(settled), replayed: false };
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
   * Answers with a payment that already exists, exactly as it answered the
   * first time.
   *
   * A SUCCEEDED replay comes back as a value; a DECLINED or FAILED one is
   * re-thrown with the same status and body the original attempt produced.
   * That is what "idempotent" has to mean to a client: send it again, get
   * the same answer — not a different answer that happens to be about the
   * same payment.
   */
  private replay(payment: PaymentRecord): PaymentResult {
    this.logger.log(
      `${payment.reference}: idempotent replay (${payment.status})`,
    );

    if (payment.status === PaymentStatus.Succeeded) {
      return { payment: toDto(payment), replayed: true };
    }

    if (payment.status === PaymentStatus.Declined) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: payment.failureMessage ?? 'The card was declined',
          paymentId: payment.id,
          reference: payment.reference,
          failureCode: payment.failureCode,
          retryable: false,
          replayed: true,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (payment.status === PaymentStatus.Failed) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: payment.failureMessage ?? 'The payment could not be completed',
        paymentId: payment.id,
        reference: payment.reference,
        failureCode: payment.failureCode,
        // Still true — but a retry needs a NEW key, or this same answer
        // comes back forever. A key identifies the attempt, not the
        // intention.
        retryable: true,
        replayed: true,
      });
    }

    // PENDING: the first attempt is still in flight, or it died without
    // settling. Either way the honest answer is "we do not know yet", and it
    // must not be a second charge.
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'A payment for this request is still in progress',
      paymentId: payment.id,
      reference: payment.reference,
      replayed: true,
    });
  }

  /** Turns the order constraint into a 409 rather than a 500. */
  private async createAttempt(
    input: Parameters<PaymentsRepository['createPending']>[0],
  ): Promise<{ payment: PaymentRecord; replayed: boolean }> {
    try {
      return await this.payments.createPending(input);
    } catch (error) {
      if (error instanceof OrderAlreadyPaidError) {
        // The database refused, BEFORE the provider was called. NOTHING WAS
        // CHARGED, which is the entire reason this is an index rather than a
        // read-then-write in TypeScript.
        this.logger.warn(`refused a second payment for order ${input.orderId}`);

        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message:
            'This order already has a payment in progress or completed. Nothing was charged.',
          orderId: input.orderId,
        });
      }
      throw error;
    }
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
      eventId: newEventId(),
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
    // Neither the token nor the idempotency key is here, deliberately. The
    // client sent both and does not need either echoed; anything echoed
    // ends up in a log somewhere.
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
