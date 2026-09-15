import { correlationHeaders } from '@ecommerce/observability';
import { OrderDto, OrderStatus } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

/** What the Payment Service needs to know about an order. */
export interface PayableOrder {
  id: string;
  orderNumber: string;
  amount: string;
  currency: string;
}

/**
 * Reads the order being paid for.
 *
 * THE AMOUNT COMES FROM HERE, and that is the entire reason this class
 * exists. A `POST /payments` that accepted an amount would be charging
 * whatever the client said — and the client is a browser. Every amount in
 * this system is server-side: the cart takes its prices from the catalogue,
 * the order takes its lines from the cart, and the payment takes its amount
 * from the order.
 *
 * OWNERSHIP TOO. The request is forwarded with the caller's `X-User-Id`, so
 * the Order Service answers 404 for an order that is not theirs. Paying for
 * a stranger's order is refused by the same mechanism that stops reading it,
 * rather than by a check somebody has to remember to write here.
 */
@Injectable()
export class OrderClientService {
  private readonly logger = new Logger(OrderClientService.name);

  constructor(private readonly http: HttpService) {}

  async fetchPayable(userId: string, orderId: string): Promise<PayableOrder> {
    let order: OrderDto;

    try {
      const response = await firstValueFrom(
        this.http.get<OrderDto>(`/orders/${orderId}`, {
          headers: { 'x-user-id': userId, ...correlationHeaders() },
        }),
      );
      order = response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response?.status === 404) {
        // 404 covers "no such order" AND "not yours" — the Order Service
        // deliberately does not distinguish, and neither do we.
        throw new NotFoundException(`Order ${orderId} not found`);
      }

      this.logger.error(
        `order lookup failed for ${orderId}: ${axiosError.code ?? axiosError.message}`,
      );
      throw new ServiceUnavailableException(
        'Cannot take a payment right now — the order service is unavailable',
      );
    }

    // A cancelled order must not be payable. Checking here rather than
    // trusting the caller means a stale checkout page cannot charge someone
    // for something that was called off.
    if (order.status === OrderStatus.Cancelled) {
      throw new ConflictException(
        `Order ${order.orderNumber} was cancelled and cannot be paid`,
      );
    }

    if (order.status !== OrderStatus.Confirmed) {
      // PAID, SHIPPED, DELIVERED — all mean this order has already moved
      // past the point of taking money.
      throw new ConflictException(
        `Order ${order.orderNumber} is ${order.status} and is not awaiting payment`,
      );
    }

    if (Number(order.total) <= 0) {
      // A zero-value order is a real thing (a fully discounted basket) and
      // it must not become a zero-value charge — providers reject those, and
      // the CHECK on `amount` would reject it here first. It needs its own
      // path, which does not exist yet, so it is refused rather than
      // half-handled.
      throw new BadRequestException(
        `Order ${order.orderNumber} has nothing to pay`,
      );
    }

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      amount: order.total,
      currency: order.currency,
    };
  }
}
