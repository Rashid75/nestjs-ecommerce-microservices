import {
  CreatePaymentDto,
  PageMetaDto,
  PaymentDto,
  QueryPaymentsDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
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
 *
 * `POST /payments` rather than `POST /orders/:id/pay`: a payment is a
 * resource in its own right, with its own id that a client keeps and quotes.
 * The order is an attribute of it, not its owner.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Takes a payment.
   *
   * 201 on success; 402 when the card was declined; 503 when the provider
   * could not be reached. All three are documented answers rather than
   * accidents — see the service for why 402 and 503 are different in a way
   * that matters to the caller.
   */
  @Post()
  pay(
    @CurrentUserId() userId: string,
    @Body() dto: CreatePaymentDto,
  ): Promise<PaymentDto> {
    return this.payments.pay(userId, dto);
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
