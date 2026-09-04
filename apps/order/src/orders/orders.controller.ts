import {
  CancelOrderDto,
  CreateOrderDto,
  OrderDto,
  PageMetaDto,
  QueryOrdersDto,
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
} from '@nestjs/common';
import { CurrentUserId } from './current-user.decorator';
import { OrdersService } from './orders.service';

/**
 * REST for orders.
 *
 *   POST   /orders             place one, from the caller's cart
 *   GET    /orders             the caller's orders, newest first
 *   GET    /orders/:id         one order
 *   POST   /orders/:id/cancel  cancel it
 *
 * `POST /orders/:id/cancel` rather than `PATCH /orders/:id { status }`, for
 * the same reason the Inventory Service has `/reserve` and `/release`.
 * Cancelling is a state transition that may be refused, not "write a value
 * into a field" — and `PATCH` invites the client to believe it can set any
 * status it likes, including SHIPPED.
 *
 * There is no `userId` and no `:cartId` anywhere: an order belongs to the
 * caller, and every query is scoped by the id the gateway verified. Nothing
 * in a URL can be edited to reach someone else's order.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * `_dto` is accepted and ignored, and that is not an oversight.
   *
   * `CreateOrderDto` has no fields, so the global ValidationPipe with
   * `forbidNonWhitelisted` rejects a body that contains anything at all.
   * Without the parameter there would be no DTO to validate against, and a
   * client could POST its own prices and have them silently discarded —
   * which looks identical to having them accepted.
   */
  @Post()
  create(
    @CurrentUserId() userId: string,
    @Body() _dto: CreateOrderDto,
  ): Promise<OrderDto> {
    return this.orders.create(userId);
  }

  @Get()
  list(
    @CurrentUserId() userId: string,
    @Query() query: QueryOrdersDto,
  ): Promise<{ data: OrderDto[]; meta: PageMetaDto }> {
    return this.orders.list(userId, query);
  }

  @Get(':orderId')
  findOne(
    @CurrentUserId() userId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<OrderDto> {
    return this.orders.findOne(userId, orderId);
  }

  @Post(':orderId/cancel')
  // 200, not 201: cancelling creates nothing. The updated order comes back
  // so the client never needs a follow-up GET.
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUserId() userId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Body() dto: CancelOrderDto,
  ): Promise<OrderDto> {
    return this.orders.cancel(userId, orderId, dto);
  }
}
