import {
  buildPageMeta,
  EventPattern,
  NotificationDto,
  NotificationStatus,
  NotificationType,
  PageMetaDto,
  QueryNotificationsDto,
  type OrderConfirmedPayload,
  type PaymentSucceededPayload,
  type UserRegisteredPayload,
} from '@ecommerce/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '../mailer/mailer.service';
import {
  orderConfirmedEmail,
  paymentReceiptEmail,
  welcomeEmail,
  type RenderedEmail,
} from '../templates/templates';
import {
  NotificationRecord,
  NotificationsRepository,
} from './notifications.repository';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Turns events into emails.
 *
 * WHY THIS IS A SERVICE OF ITS OWN, which is the point of the milestone.
 *
 * Every one of these emails could have been sent from the service that owns
 * the event — a line in `AuthService.register`, another in
 * `OrdersService.create`. It would work, and it would be wrong in four ways:
 *
 *   IT COUPLES REGISTRATION TO EMAIL. If the mail server is slow,
 *   registration is slow. If it is down, registration fails — over a welcome
 *   email nobody would have missed.
 *
 *   IT SPREADS THE TEMPLATES. Three services would each own some email, and
 *   a change to the footer would be three pull requests.
 *
 *   IT MAKES THE PUBLISHER DECIDE. `user.registered` is a fact. `send a
 *   welcome email` is an instruction, and the moment Auth issues
 *   instructions it has to know that an email system exists, then that an
 *   SMS system exists, then which customers opted out of which.
 *
 *   IT HAS NOWHERE TO RECORD ANYTHING. "Did the customer get their receipt?"
 *   has no answer unless something owns that question.
 *
 * So the business services state facts, and this service decides what a fact
 * implies. Adding SMS later touches nothing but this app.
 *
 * EXACTLY ONCE, BY RECOGNISING THE REPEAT. RabbitMQ delivers at least once,
 * so every handler here WILL be given the same message twice eventually.
 * Every other consumer in this system survives that by being naturally
 * repeatable — a conditional UPDATE does nothing the second time. An email
 * cannot be: there is no WHERE clause that un-sends one.
 *
 * So this service claims each `eventId` in a ledger before it acts, and a
 * second delivery finds the claim already taken. See `handleOnce` for the
 * trade that ordering makes.
 *
 * STILL NOT BUILT:
 *
 *   NO RETRY. A send that fails is recorded FAILED and left alone. Nothing
 *   tries again, and nothing tells anyone.
 *
 *   NO PREFERENCES. Every customer gets every email. A real system needs
 *   opt-outs before it sends anything that is not strictly transactional.
 *
 *   NO RETENTION on the ledger. One row per event, forever.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Remembers a new customer, then welcomes them.
   *
   * The contact is written FIRST, and it is not merely convenient ordering:
   * every other email this service sends depends on that row existing. If
   * the welcome fails, the customer is still reachable for their order
   * confirmation.
   */
  async onUserRegistered(user: UserRegisteredPayload): Promise<void> {
    // The contact is written OUTSIDE the claim, deliberately. It is an
    // upsert — naturally repeatable — and it is what every later email
    // depends on, so a duplicate delivery doing it twice is harmless while a
    // duplicate delivery skipping it would not be.
    await this.notifications.upsertContact({
      userId: user.userId,
      email: user.email,
      firstName: user.firstName,
    });

    await this.handleOnce(user.eventId, EventPattern.UserRegistered, () =>
      this.deliver(
        user.userId,
        NotificationType.Welcome,
        user.email,
        welcomeEmail(user),
      ),
    );
  }

  async onOrderConfirmed(order: OrderConfirmedPayload): Promise<void> {
    await this.handleOnce(order.eventId, EventPattern.OrderConfirmed, () =>
      this.sendOrderConfirmation(order),
    );
  }

  async onPaymentSucceeded(payment: PaymentSucceededPayload): Promise<void> {
    await this.handleOnce(payment.eventId, EventPattern.PaymentSucceeded, () =>
      this.sendReceipt(payment),
    );
  }

  private async sendOrderConfirmation(
    order: OrderConfirmedPayload,
  ): Promise<void> {
    const contact = await this.notifications.findContact(order.userId);

    if (contact === null) {
      // A customer who registered before this service existed, or whose
      // `user.registered` event was lost. Recorded as a failure with a
      // reason rather than silently skipped — an email nobody received is
      // precisely what support needs to be able to find.
      await this.recordUnreachable(
        order.userId,
        NotificationType.OrderConfirmed,
      );
      return;
    }

    await this.deliver(
      order.userId,
      NotificationType.OrderConfirmed,
      contact.email,
      orderConfirmedEmail(order, contact.firstName),
    );
  }

  private async sendReceipt(payment: PaymentSucceededPayload): Promise<void> {
    const contact = await this.notifications.findContact(payment.userId);

    if (contact === null) {
      await this.recordUnreachable(
        payment.userId,
        NotificationType.PaymentReceipt,
      );
      return;
    }

    await this.deliver(
      payment.userId,
      NotificationType.PaymentReceipt,
      contact.email,
      paymentReceiptEmail(payment, contact.firstName),
    );
  }

  async list(
    userId: string,
    query: QueryNotificationsDto,
  ): Promise<{ data: NotificationDto[]; meta: PageMetaDto }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const { rows, total } = await this.notifications.list(userId, page, limit, {
      type: query.type,
      status: query.status,
    });

    return {
      data: rows.map(toDto),
      meta: buildPageMeta(page, limit, total),
    };
  }

  /**
   * Runs the work once per event id, however many times it is delivered.
   *
   * THE CLAIM COMES FIRST, and the ordering is a real trade with two
   * possible failures:
   *
   *   CLAIM, then send   the process dies in between and the email is never
   *                      sent — because the redelivery finds the claim taken
   *                      and skips it. ONE MISSED EMAIL. (this)
   *
   *   SEND, then claim   the process dies in between and the redelivery
   *                      sends a SECOND email, every time.
   *
   * There is no third option: the send is an external side effect and cannot
   * join a database transaction, which is the same shape as the
   * publish-versus-commit problem in the Order Service. We take the first,
   * because a customer who is missing a receipt can find it in
   * `GET /notifications` and support can resend it, whereas a customer who
   * gets the same receipt three times concludes the shop is broken.
   *
   * The claim is RELEASED if the work throws, so an unexpected failure — the
   * database refusing a write, say — does not permanently swallow the event.
   * Note what is not released: a send that merely FAILED. That is recorded,
   * not thrown, and it stays claimed on purpose, because redelivering it
   * would retry a bad address forever. A deliberate retry is pass 3's job,
   * if it ever earns one.
   */
  private async handleOnce(
    eventId: string,
    pattern: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const claimed = await this.notifications.claimEvent(eventId, pattern);

    if (!claimed) {
      // The ordinary case, not an error. At-least-once delivery makes this
      // routine, which is why it is logged at debug.
      this.logger.debug(
        `${pattern} ${eventId.slice(0, 8)}: already handled, skipping`,
      );
      return;
    }

    try {
      await work();
    } catch (error) {
      await this.notifications.releaseEvent(eventId);
      this.logger.error(
        `${pattern} ${eventId.slice(0, 8)}: handler failed, claim released for redelivery`,
      );
      throw error;
    }
  }

  /**
   * Sends one email and records the outcome.
   *
   * NEVER THROWS on a send failure, and that is a decision rather than
   * laziness. Throwing out of a message handler makes Nest nack the message
   * and RabbitMQ redeliver it — which retries a bad address forever, and
   * would re-send an email that DID go out if the failure was on our side of
   * the acknowledgement. A recorded failure is the safer outcome, and a
   * deliberate retry is a thing to build on purpose (pass 2) rather than to
   * get by accident.
   */
  private async deliver(
    userId: string,
    type: NotificationType,
    recipient: string,
    email: RenderedEmail,
  ): Promise<void> {
    const result = await this.mailer.send({
      to: recipient,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    await this.notifications.record({
      userId,
      type,
      status: result.sent ? NotificationStatus.Sent : NotificationStatus.Failed,
      recipient,
      subject: email.subject,
      // The text part is what gets stored. Keeping the HTML too would double
      // the row for no extra information about what was communicated.
      body: email.text,
      failureReason: result.sent ? null : result.reason,
    });

    if (result.sent) {
      this.logger.log(`${type} → ${recipient}`);
    } else {
      this.logger.warn(`${type} → ${recipient} FAILED: ${result.reason}`);
    }
  }

  private async recordUnreachable(
    userId: string,
    type: NotificationType,
  ): Promise<void> {
    this.logger.warn(
      `${type}: no contact for user ${userId} — nothing was sent`,
    );

    await this.notifications.record({
      userId,
      type,
      status: NotificationStatus.Failed,
      // A placeholder rather than an empty string, because the column is NOT
      // NULL and because "unknown" is more honest than "".
      recipient: 'unknown',
      subject: `${type} (not sent)`,
      body: '',
      failureReason:
        'No contact on file for this user. The user.registered event was never received.',
    });
  }
}

function toDto(record: NotificationRecord): NotificationDto {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    recipient: record.recipient,
    subject: record.subject,
    ...(record.failureReason !== null
      ? { failureReason: record.failureReason }
      : {}),
    ...(record.sentAt !== null ? { sentAt: record.sentAt } : {}),
    createdAt: record.createdAt,
  };
}

/** Exported for the unit tests. */
export const __toDto = toDto;
