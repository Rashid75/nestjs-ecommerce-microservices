import { runWithCorrelationId } from '@ecommerce/observability';
import {
  ackOrPark,
  EventPattern as Events,
  type OrderConfirmedPayload,
  type PaymentSucceededPayload,
  type UserRegisteredPayload,
} from '@ecommerce/contracts';
import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Every event this service listens to.
 *
 * ONE CONTROLLER for all three, unlike the Cart Service which splits its
 * handlers by the service the events come from. The difference is what the
 * handlers have in common: these three all do the same job — "turn a fact
 * into an email" — and reading them together is how you see the whole
 * responsibility of the service at a glance. The Cart Service's handlers do
 * genuinely different things to different tables.
 *
 * THE ROUTING KEYS ARE THE BINDINGS. Nest reads these three
 * `@EventPattern()` strings at boot and binds `notification_service` to the
 * exchange once per pattern. Adding a fourth handler adds a fourth binding
 * automatically — and it is worth knowing that removing one does NOT remove
 * its binding from a queue that already exists. A binding outlives the code
 * that asked for it, so a deleted handler leaves messages piling up in the
 * queue until someone unbinds it by hand.
 *
 * Each handler is `async` and awaited by Nest, so the message is not
 * acknowledged until the email has been attempted and recorded. That is what
 * makes a restart mid-handler safe: the message comes back.
 */
@Controller()
export class NotificationEventsController {
  private readonly logger = new Logger(NotificationEventsController.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * A new customer: remember how to reach them, and say hello.
   *
   * This is the only event that carries an email address, which is why the
   * contact projection is built from it. Everything else arrives with a user
   * id and nothing else.
   */
  @EventPattern(Events.UserRegistered)
  async onUserRegistered(
    @Payload() user: UserRegisteredPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrPark(context, this.logger, 'user.registered', async () => {
      // Back into the customer's story, on the other side of the broker.
      await runWithCorrelationId(user.correlationId, () =>
        this.notifications.onUserRegistered(user),
      );
    });
  }

  @EventPattern(Events.OrderConfirmed)
  async onOrderConfirmed(
    @Payload() order: OrderConfirmedPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrPark(context, this.logger, 'order.confirmed', async () => {
      await runWithCorrelationId(order.correlationId, () =>
        this.notifications.onOrderConfirmed(order),
      );
    });
  }

  /**
   * A receipt.
   *
   * NOTE that the Cart Service also binds to `order.confirmed` and does
   * something completely different with it. That is the exchange earning its
   * place: two services, one event, two copies, neither aware of the other.
   * On a single shared queue this handler and the cart's would have been
   * taking turns.
   */
  @EventPattern(Events.PaymentSucceeded)
  async onPaymentSucceeded(
    @Payload() payment: PaymentSucceededPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrPark(context, this.logger, 'payment.succeeded', async () => {
      await runWithCorrelationId(payment.correlationId, () =>
        this.notifications.onPaymentSucceeded(payment),
      );
    });
  }
}
