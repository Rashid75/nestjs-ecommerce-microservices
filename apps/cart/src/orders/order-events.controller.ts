import { runWithCorrelationId } from '@ecommerce/observability';
import {
  EventPattern as Events,
  type OrderConfirmedPayload,
} from '@ecommerce/contracts';
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { CartRepository } from '../cart/cart.repository';

/**
 * Reacts to order events.
 *
 * ONE HANDLER, and it is the first place in this project where an event
 * causes a WRITE that the publisher could not have made itself. The Order
 * Service cannot touch `ecommerce_cart_db` — it has no credentials for it,
 * which is what database-per-service means in practice. So it states a fact,
 * and the service that owns the data decides what that fact implies.
 *
 * THE ALTERNATIVE, and why this is better. The Order Service could have
 * called `POST /cart/convert` synchronously during checkout. The cart would
 * empty instantly — and the Cart Service would be on the critical path of
 * taking an order. Cart down, no orders. Worse, a failure after that call
 * would leave the customer with no basket AND no order.
 *
 * Converting asynchronously means the order is safely written FIRST and the
 * cart catches up. The cost is a window — usually well under a second — in
 * which the order exists and the cart still looks full. That window is what
 * "eventual consistency" actually means, and it is worth naming the risk it
 * carries: a customer who checks out twice inside it gets two orders.
 */
@Controller()
export class OrderEventsController {
  private readonly logger = new Logger(OrderEventsController.name);

  constructor(private readonly carts: CartRepository) {}

  @EventPattern(Events.OrderConfirmed)
  async onOrderConfirmed(
    @Payload() order: OrderConfirmedPayload,
  ): Promise<void> {
    // The id crossed the broker in the payload. Putting it back into the
    // async context is what makes this handler's logs part of the same
    // story as the checkout that caused it.
    await runWithCorrelationId(order.correlationId, async () => {
      // Converts the cart NAMED IN THE EVENT, not "the user's active cart".
      //
      // Those are the same thing when the message arrives promptly and
      // different things when it does not. A broker that was down for a minute
      // delivers an event about a cart the customer has already replaced — and
      // converting whatever is active now would silently empty a basket they
      // are still filling.
      const converted = await this.carts.markConverted(order.cartId);

      if (converted) {
        this.logger.log(
          `order ${order.orderNumber}: cart ${order.cartId} marked CONVERTED`,
        );
        return;
      }

      // Not an error. Either this event has been delivered before — which
      // at-least-once delivery makes routine — or the cart has moved on.
      // Logged at debug because it is expected traffic, not a problem.
      this.logger.debug(
        `order ${order.orderNumber}: cart ${order.cartId} was not ACTIVE (duplicate delivery, or already replaced)`,
      );
    });
  }
}
