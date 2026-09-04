import {
  buildPageMeta,
  CancelOrderDto,
  CartItemDto,
  OrderDto,
  OrderStatus,
  PageMetaDto,
  QueryOrdersDto,
} from '@ecommerce/contracts';
import { lineTotal, sumDecimals } from '@ecommerce/money';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CartClientService } from '../cart/cart-client.service';
import {
  OrderLineInput,
  OrderRecord,
  OrdersRepository,
} from './orders.repository';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Turning a cart into an order — the simple version, on purpose.
 *
 * WHAT THIS DOES
 *
 *   1. read the caller's cart from the Cart Service
 *   2. refuse it if there is nothing to buy
 *   3. copy the lines into an order, in one local transaction
 *   4. return the order, CONFIRMED
 *
 * WHAT IT DELIBERATELY DOES NOT DO YET — and this list is the point of
 * building it this way. Every item is a real defect, and each one motivates
 * a specific piece of machinery in step 2 of this milestone:
 *
 *   NO STOCK RESERVATION. Two customers can both order the last unit. The
 *   Inventory Service already has an atomic `reserve`; nothing calls it. The
 *   moment we do, we have changed another service's database — and if a
 *   later step fails we have to UNDO that, which is what a saga is.
 *
 *   THE CART IS NOT EMPTIED. Place an order and the cart still has
 *   everything in it, so ordering twice creates two identical orders. The
 *   cart lives in another database, so emptying it cannot be part of the
 *   transaction above — that is the same problem again.
 *
 *   NO IDEMPOTENCY. A double-clicked button creates two orders. Nothing here
 *   can tell a retry from a new request.
 *
 *   NOTHING ELSE IS TOLD. No event is published, so no email, no analytics,
 *   no warehouse. Publishing after the commit can lose the message; before
 *   it can announce an order that never existed. That is what the outbox
 *   solves.
 *
 * Read those four again after this version works. Each one is a problem you
 * can now see rather than take on trust, which is the only reason to build
 * the naive version first.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly carts: CartClientService,
  ) {}

  /**
   * Places an order from the caller's cart.
   *
   * The order of operations still matters, even here: READ the cart first,
   * then write. A failed read leaves nothing behind to clean up. Writing the
   * order first and fetching the lines afterwards would need a compensating
   * delete when the read failed — a miniature saga, for no benefit.
   */
  async create(userId: string): Promise<OrderDto> {
    const cart = await this.carts.fetchActiveCart(userId);

    if (cart.items.length === 0) {
      throw new BadRequestException('Your cart is empty');
    }

    const lines = cart.items.map(toLine);

    // Computed here rather than copied from `cart.subtotal`. The arithmetic
    // is the same function from the same library, so the two agree — but the
    // ORDER computes its own totals, because it is the record of what will
    // be charged and it must not depend on another service getting the
    // multiplication right.
    const subtotal = sumDecimals(lines.map((line) => line.lineTotal));

    const order = await this.orders.create({
      userId,
      cartId: cart.id,
      currency: cart.currency,
      subtotal,
      // Equal to the subtotal until shipping and tax exist. Named separately
      // so that the day they arrive, there is one place to change.
      total: subtotal,
      lines,
    });

    this.logger.log(
      `order ${order.orderNumber}: ${order.items.length} line(s), ${order.total} ${order.currency}`,
    );

    return toDto(order);
  }

  async findOne(userId: string, orderId: string): Promise<OrderDto> {
    const order = await this.orders.findOne(userId, orderId);
    if (order === null) {
      // 404 for "not yours" as well as "does not exist", deliberately.
      // Answering 403 for someone else's order would confirm that the order
      // exists, which is information the caller has no right to.
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    return toDto(order);
  }

  async list(
    userId: string,
    query: QueryOrdersDto,
  ): Promise<{ data: OrderDto[]; meta: PageMetaDto }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const { rows, total } = await this.orders.list(
      userId,
      page,
      limit,
      query.status,
    );

    return {
      data: rows.map((row) => toDto(row)),
      meta: buildPageMeta(page, limit, total),
    };
  }

  /**
   * Cancels an order.
   *
   * Today this is only a status change, because nothing was reserved and
   * nobody was charged — there is genuinely nothing to undo. That is exactly
   * what makes it a good marker: the same method in step 2 has to release
   * stock, and in M9 it has to issue a refund. The signature stays; the work
   * behind it grows.
   */
  async cancel(
    userId: string,
    orderId: string,
    dto: CancelOrderDto,
  ): Promise<OrderDto> {
    const existing = await this.orders.findOne(userId, orderId);
    if (existing === null) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    const reason = dto.reason ?? 'Cancelled by customer';

    const cancelled = await this.orders.cancel(userId, orderId, reason, [
      // From CONFIRMED only. A cancelled order stays cancelled, and PAID and
      // beyond are refused because undoing those needs a refund and possibly
      // a recall from a courier — real workflows with real consequences, not
      // a status update.
      OrderStatus.Confirmed,
    ]);

    if (!cancelled) {
      throw new ConflictException(
        `Order ${existing.orderNumber} is ${existing.status} and can no longer be cancelled`,
      );
    }

    this.logger.log(`order ${existing.orderNumber}: cancelled`);

    const updated = await this.orders.findOne(userId, orderId);
    return toDto(updated ?? existing);
  }
}

function toLine(item: CartItemDto): OrderLineInput {
  return {
    productId: item.productId,
    sku: item.sku,
    name: item.name,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    // Recomputed rather than copied from the cart's own `lineTotal`, for the
    // reason given in `create`. `@ecommerce/money` works in integer minor
    // units, so 16.08 × 3 is 48.24 and not 48.239999999999995.
    lineTotal: lineTotal(item.unitPrice, item.quantity),
  };
}

function toDto(record: OrderRecord): OrderDto {
  return {
    id: record.id,
    orderNumber: record.orderNumber,
    userId: record.userId,
    status: record.status,
    items: record.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    subtotal: record.subtotal,
    total: record.total,
    currency: record.currency,
    // Only present once it means something, so a normal order is not
    // cluttered with nulls.
    ...(record.cancelReason !== null
      ? { cancelReason: record.cancelReason }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Exported for the unit tests, which assert on the mapping. */
export const __toDto = toDto;
