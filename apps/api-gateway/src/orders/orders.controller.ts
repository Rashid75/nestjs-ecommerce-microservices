import {
  CancelOrderDto,
  CreateOrderDto,
  OrderDto,
  QueryOrdersDto,
  UserProfileDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../common/authenticated-user.decorator';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import { OrderListResponse, OrdersProxyService } from './orders-proxy.service';

/**
 * The public order API.
 *
 * Guarded at the CLASS level, like the cart: every route here is inherently
 * user-scoped, and a route added later inherits the protection rather than
 * silently shipping without it.
 *
 * The gateway knows nothing about how an order is built. It authenticates,
 * forwards, and relays the answer — that is the whole job.
 */
@UseGuards(AuthenticatedUserGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersProxyService) {}

  @Post()
  create(
    @Body() dto: CreateOrderDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<OrderDto> {
    return this.orders.create(requireUser(user).id, dto);
  }

  @Get()
  list(
    @Query() query: QueryOrdersDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<OrderListResponse> {
    // Validated here as well as downstream. The gateway rejects a malformed
    // `limit` one hop early; the Order Service never trusts its caller.
    return this.orders.list(requireUser(user).id, { ...query });
  }

  @Get(':orderId')
  findOne(
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<OrderDto> {
    return this.orders.findOne(requireUser(user).id, orderId);
  }

  @Post(':orderId/cancel')
  // 200 to match the Order Service. Nest defaults every POST to 201, and a
  // gateway that quietly changed a status code would make the public API
  // disagree with the service it is fronting.
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Body() dto: CancelOrderDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<OrderDto> {
    return this.orders.cancel(requireUser(user).id, orderId, dto);
  }
}

/** Unreachable while the guard is in place — see the note in the cart's. */
function requireUser(user: UserProfileDto | undefined): UserProfileDto {
  if (user === undefined) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}
