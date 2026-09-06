import { OrderStatus } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { OrderItem } from './order-item.model';
import { Order } from './order.model';

/** A line as the service hands it to the repository. */
export interface OrderLineInput {
  productId: string;
  sku: string;
  name: string;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

export interface CreateOrderInput {
  userId: string;
  cartId: string;
  currency: string;
  subtotal: string;
  total: string;
  lines: OrderLineInput[];
}

export interface OrderItemRecord extends OrderLineInput {
  id: string;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  userId: string;
  cartId: string;
  status: OrderStatus;
  currency: string;
  subtotal: string;
  total: string;
  cancelReason: string | null;
  items: OrderItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The only place Sequelize is used for orders.
 *
 * Controller → Service → **Repository** → Model → PostgreSQL, the same fixed
 * layering as every other service here.
 */
@Injectable()
export class OrdersRepository {
  constructor(
    @InjectModel(Order) private readonly orders: typeof Order,
    @InjectModel(OrderItem) private readonly items: typeof OrderItem,
    private readonly sequelize: Sequelize,
  ) {}

  /**
   * Writes the order and all of its lines.
   *
   * ONE TRANSACTION, and this is where it matters most in step 1: an order
   * with no lines is not a smaller order, it is a corrupt one. Two separate
   * writes would leave exactly that behind if the process died between them.
   *
   * Worth noticing what this transaction can and cannot cover. Everything
   * inside it is in THIS database, so PostgreSQL guarantees all-or-nothing.
   * The cart, which lives in another service's database, is completely
   * outside it — and that is the gap step 2 of this milestone is about.
   */
  async create(input: CreateOrderInput): Promise<OrderRecord> {
    const orderId = await this.sequelize.transaction(async (transaction) => {
      // Columns listed explicitly. `order_number` is NOT among them — it
      // comes from the sequence DEFAULT, and sending `undefined` would
      // override that default with NULL.
      const order = await this.orders.create(
        {
          userId: input.userId,
          cartId: input.cartId,
          status: OrderStatus.Confirmed,
          currency: input.currency,
          subtotal: input.subtotal,
          total: input.total,
        } as Order,
        {
          transaction,
          fields: [
            'userId',
            'cartId',
            'status',
            'currency',
            'subtotal',
            'total',
          ],
        },
      );

      // One INSERT for every line, not one per line in a loop. `bulkCreate`
      // sends a single multi-row statement — the same reasoning as the JOIN
      // that avoids N+1 on the read side.
      await this.items.bulkCreate(
        input.lines.map(
          (line) =>
            ({
              orderId: order.id,
              productId: line.productId,
              sku: line.sku,
              name: line.name,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
            }) as OrderItem,
        ),
        { transaction },
      );

      return order.id;
    });

    const created = await this.findById(orderId);
    if (created === null) {
      // Unreachable: we just committed it. Thrown rather than force-unwrapped
      // so a genuine impossibility surfaces here instead of as `undefined`
      // two frames later.
      throw new Error(`order ${orderId} vanished immediately after creation`);
    }
    return created;
  }

  /**
   * One order, ALWAYS scoped by user.
   *
   * `userId` is part of the WHERE clause rather than checked afterwards, so
   * there is no path through this method that reads another customer's order
   * and relies on a later `if` to hide it. A missing filter fails closed — it
   * returns nothing — instead of leaking.
   */
  async findOne(userId: string, orderId: string): Promise<OrderRecord | null> {
    const order = await this.orders.findOne({
      where: { id: orderId, userId },
      include: [OrderItem],
    });
    return order === null ? null : toRecord(order);
  }

  async list(
    userId: string,
    page: number,
    limit: number,
    status?: OrderStatus,
  ): Promise<{ rows: OrderRecord[]; total: number }> {
    // `distinct: true` because `findAndCountAll` with an `include` counts
    // JOINED ROWS otherwise — an order with three lines would count as
    // three. This is the single most common way a paginated total ends up
    // wrong.
    const { rows, count } = await this.orders.findAndCountAll({
      where: status === undefined ? { userId } : { userId, status },
      include: [OrderItem],
      distinct: true,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { rows: rows.map(toRecord), total: count };
  }

  /**
   * CONFIRMED → CANCELLED. Returns false when the order was not cancellable.
   *
   * A COMPARE-AND-SET: the current status is in the WHERE clause, so the
   * database decides whether the transition is legal. Reading the status,
   * checking it in TypeScript and then updating would be the same
   * check-then-act race as everywhere else in this project — two concurrent
   * cancellations would both pass the check.
   */
  async cancel(
    userId: string,
    orderId: string,
    reason: string,
    allowedFrom: OrderStatus[],
  ): Promise<boolean> {
    const [affected] = await this.orders.update(
      {
        status: OrderStatus.Cancelled,
        cancelReason: reason,
        cancelledAt: new Date(),
      },
      { where: { id: orderId, userId, status: allowedFrom } },
    );
    return affected > 0;
  }

  /**
   * CONFIRMED → PAID, driven by the `payment.succeeded` event.
   *
   * NOT scoped by user, unlike every other method here — the caller is the
   * message handler, not a customer, and there is no request to take an
   * identity from. The payload names the order, and the Payment Service
   * already checked ownership before it charged anyone.
   *
   * IDEMPOTENT BY CONSTRUCTION: `WHERE status = 'CONFIRMED'` means a
   * duplicate delivery updates nothing. RabbitMQ delivers at-least-once, so
   * this WILL be called twice for the same payment, and the second call
   * must be a no-op rather than a mistake.
   *
   * It is also the guard against a genuinely bad outcome: an order that was
   * cancelled between confirmation and payment cannot be quietly marked
   * PAID. `false` comes back, the handler logs it loudly, and a human has a
   * refund to arrange.
   */
  async markPaid(orderId: string): Promise<boolean> {
    const [affected] = await this.orders.update(
      { status: OrderStatus.Paid },
      { where: { id: orderId, status: OrderStatus.Confirmed } },
    );
    return affected > 0;
  }

  /** Read by the message handler, which has no user to scope by. */
  async findAny(orderId: string): Promise<OrderRecord | null> {
    return this.findById(orderId);
  }

  private async findById(orderId: string): Promise<OrderRecord | null> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      include: [OrderItem],
    });
    return order === null ? null : toRecord(order);
  }
}

function toRecord(order: Order): OrderRecord {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    cartId: order.cartId,
    status: order.status,
    currency: order.currency,
    // String all the way out. DECIMAL arrives as a string from the pg driver
    // precisely so it has not already lost precision by the time you see it.
    subtotal: String(order.subtotal),
    total: String(order.total),
    cancelReason: order.cancelReason,
    items: (order.items ?? []).map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      unitPrice: String(item.unitPrice),
      quantity: item.quantity,
      lineTotal: String(item.lineTotal),
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
