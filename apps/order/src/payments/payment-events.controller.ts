import { runWithCorrelationId } from '@ecommerce/observability';
import {
  EventPattern as Events,
  type PaymentFailedPayload,
  type PaymentSucceededPayload,
} from '@ecommerce/contracts';
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { OrdersRepository } from '../orders/orders.repository';

/**
 * Reacts to payment events.
 *
 * This is what makes the Order Service a HYBRID application: it serves HTTP
 * and consumes messages in one process, the same shape the Cart Service has
 * had since Milestone 7.
 *
 * WHY THE ORDER DOES NOT ASK. The obvious alternative is for the Order
 * Service to call the Payment Service and ask whether an order is paid.
 * That is a poll — it is either too slow or too expensive, it puts Payments
 * on the critical path of reading an order, and it inverts the dependency:
 * the service that knows a fact should state it, rather than being
 * interrogated for it.
 */
@Controller()
export class PaymentEventsController {
  private readonly logger = new Logger(PaymentEventsController.name);

  constructor(private readonly orders: OrdersRepository) {}

  @EventPattern(Events.PaymentSucceeded)
  async onPaymentSucceeded(
    @Payload() payment: PaymentSucceededPayload,
  ): Promise<void> {
    await runWithCorrelationId(payment.correlationId, () =>
      this.markPaid(payment),
    );
  }

  private async markPaid(payment: PaymentSucceededPayload): Promise<void> {
    const paid = await this.orders.markPaid(payment.orderId);

    if (paid) {
      this.logger.log(
        `payment ${payment.reference}: order ${payment.orderId} → PAID`,
      );
      return;
    }

    // Nothing was updated. Two very different reasons, and they need very
    // different reactions — so find out which before deciding how loud to be.
    const order = await this.orders.findAny(payment.orderId);

    if (order === null) {
      // A payment for an order this service has never heard of. Either the
      // databases disagree or something is publishing fiction.
      this.logger.error(
        `payment ${payment.reference}: order ${payment.orderId} does not exist`,
      );
      return;
    }

    if (order.status === 'PAID') {
      // The ordinary case: this message has been delivered before.
      // At-least-once delivery makes it routine, so it is logged at debug.
      this.logger.debug(
        `payment ${payment.reference}: order ${order.orderNumber} was already PAID`,
      );
      return;
    }

    // THE CASE THAT NEEDS A HUMAN. Money was taken for an order that is no
    // longer confirmed — cancelled between confirmation and payment. The
    // system cannot fix this on its own: somebody has to issue a refund, and
    // refunds do not exist yet.
    this.logger.error(
      `payment ${payment.reference}: order ${order.orderNumber} is ${order.status}, NOT confirmed — ${payment.amount} ${payment.currency} was taken and needs refunding`,
    );
  }

  /**
   * A failed payment leaves the order exactly as it was: CONFIRMED, and
   * still payable.
   *
   * That is deliberate. Marking the order FAILED because one card was
   * declined would end an order the customer is perfectly able to pay for
   * with another card — the commonest thing that happens after a decline.
   * The event is recorded here so the failure is visible in the order's own
   * log without changing its state.
   */
  @EventPattern(Events.PaymentFailed)
  async onPaymentFailed(
    @Payload() payment: PaymentFailedPayload,
  ): Promise<void> {
    await runWithCorrelationId(payment.correlationId, () => {
      this.logger.warn(
        `payment ${payment.reference}: ${payment.failureCode} on order ${payment.orderId} (retryable: ${payment.retryable}) — the order stays payable`,
      );
      return Promise.resolve();
    });
  }
}
