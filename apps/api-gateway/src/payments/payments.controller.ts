import {
  CreatePaymentDto,
  PaymentDto,
  QueryPaymentsDto,
  UserProfileDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../common/authenticated-user.decorator';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import {
  PaymentListResponse,
  PaymentsProxyService,
} from './payments-proxy.service';

/**
 * The public payment API.
 *
 * Guarded at the class level. Note that the DTO is validated HERE as well as
 * downstream, and on this route that is worth more than usual: a body
 * carrying a `cardNumber` is rejected at the edge, one hop before it could
 * be written to any log this system keeps.
 */
@UseGuards(AuthenticatedUserGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsProxyService) {}

  @Post()
  pay(
    @Body() dto: CreatePaymentDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<PaymentDto> {
    return this.payments.pay(requireUser(user).id, dto);
  }

  @Get()
  list(
    @Query() query: QueryPaymentsDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<PaymentListResponse> {
    return this.payments.list(requireUser(user).id, { ...query });
  }

  @Get(':paymentId')
  findOne(
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<PaymentDto> {
    return this.payments.findOne(requireUser(user).id, paymentId);
  }
}

/** Unreachable while the guard is in place — see the note in the cart's. */
function requireUser(user: UserProfileDto | undefined): UserProfileDto {
  if (user === undefined) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}
