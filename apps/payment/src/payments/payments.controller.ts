import {
  CreatePaymentDto,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  PageMetaDto,
  PaymentDto,
  QueryPaymentsDto,
} from '@ecommerce/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUserId } from './current-user.decorator';
import { PaymentsService } from './payments.service';

/**
 * REST for payments.
 *
 *   POST /payments       pay for one of your orders
 *   GET  /payments       your payments, newest first
 *   GET  /payments/:id   one payment
 *
 * There is no `PATCH` and no `DELETE`. A payment is not editable and not
 * removable — it is the record of whether a customer's card was charged, and
 * the only two things that may ever change it are the provider's answer and,
 * later, a refund, which is a NEW record rather than an edit to this one.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Takes a payment.
   *
   *   201  charged
   *   200  replayed — this exact request was made before, and this is what
   *        happened the first time
   *   402  the card was declined
   *   409  this order already has a payment, or the first attempt is still
   *        in flight. NOTHING WAS CHARGED.
   *   503  the provider could not be reached; the outcome is unknown
   *
   * The 201/200 distinction is the client's signal that its retry found
   * existing work rather than doing new work — the same convention Stripe
   * uses, and the reason the replay header exists alongside it.
   */
  @Post()
  async pay(
    @CurrentUserId() userId: string,
    @Body() dto: CreatePaymentDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentDto> {
    const result = await this.payments.pay(
      userId,
      dto,
      normaliseKey(idempotencyKey),
    );

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    if (result.replayed) {
      response.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
    }

    return result.payment;
  }

  @Get()
  list(
    @CurrentUserId() userId: string,
    @Query() query: QueryPaymentsDto,
  ): Promise<{ data: PaymentDto[]; meta: PageMetaDto }> {
    return this.payments.list(userId, query);
  }

  @Get(':paymentId')
  findOne(
    @CurrentUserId() userId: string,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
  ): Promise<PaymentDto> {
    return this.payments.findOne(userId, paymentId);
  }
}

/**
 * An absent key is allowed; a malformed one is not.
 *
 * Silently ignoring an over-long key would be the worst outcome on this
 * endpoint of all: the client believes its charge is protected against
 * retries, it is not, and it finds out by charging the customer twice.
 */
function normaliseKey(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestException(
      `${IDEMPOTENCY_KEY_HEADER} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }

  return trimmed;
}
