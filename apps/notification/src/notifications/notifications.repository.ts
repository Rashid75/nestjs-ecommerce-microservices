import { NotificationStatus, NotificationType } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { Contact } from './contact.model';
import { Notification } from './notification.model';
import { ProcessedEvent } from './processed-event.model';

export interface ContactRecord {
  userId: string;
  email: string;
  firstName: string | null;
}

export interface RecordNotificationInput {
  userId: string;
  type: NotificationType;
  status: NotificationStatus;
  recipient: string;
  subject: string;
  body: string;
  failureReason: string | null;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  type: NotificationType;
  status: NotificationStatus;
  recipient: string;
  subject: string;
  failureReason: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectModel(Contact) private readonly contacts: typeof Contact,
    @InjectModel(Notification)
    private readonly notifications: typeof Notification,
    @InjectModel(ProcessedEvent)
    private readonly processed: typeof ProcessedEvent,
  ) {}

  /**
   * Claims an event for handling. Returns false if it has been handled.
   *
   * AN INSERT, NOT A SELECT, and that is the whole design.
   *
   * "Look it up, and if it is not there, do the work" is the same
   * check-then-act race as every other one in this project: two deliveries
   * handled at the same moment by two replicas would both find nothing and
   * both send the email. The primary key on `event_id` makes the second
   * INSERT fail, and the database is the only thing here that is atomic.
   *
   * So a caught UniqueConstraintError is not an error being swallowed. It is
   * the answer: somebody else already has this one.
   */
  async claimEvent(eventId: string, pattern: string): Promise<boolean> {
    try {
      await this.processed.create({ eventId, pattern } as ProcessedEvent);
      return true;
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        return false;
      }
      // Anything else — the database is down, the column is the wrong type —
      // must propagate. Treating an unknown failure as "already handled"
      // would silently drop the email.
      throw error;
    }
  }

  /**
   * Gives the claim back, so a redelivery may try again.
   *
   * Only used when the handler could not finish for a reason that might not
   * recur. It is a compensating action in miniature, and it is why the claim
   * is safe to take BEFORE the work rather than after.
   */
  async releaseEvent(eventId: string): Promise<void> {
    await this.processed.destroy({ where: { eventId } });
  }

  /**
   * Records what this service knows about a customer.
   *
   * An UPSERT, and idempotent by construction: `user.registered` will be
   * delivered twice sooner or later, and writing the same address twice is
   * indistinguishable from writing it once. That is the cheap kind of
   * idempotency — and it is exactly the kind that sending an email cannot
   * have, which is the whole point of this milestone.
   */
  async upsertContact(contact: ContactRecord): Promise<void> {
    await this.contacts.upsert({
      userId: contact.userId,
      email: contact.email,
      firstName: contact.firstName,
    } as Contact);
  }

  async findContact(userId: string): Promise<ContactRecord | null> {
    const contact = await this.contacts.findByPk(userId);
    return contact === null
      ? null
      : {
          userId: contact.userId,
          email: contact.email,
          firstName: contact.firstName,
        };
  }

  /**
   * Writes the notification AFTER the send is attempted.
   *
   * The opposite order to the Payment Service, deliberately, and the reason
   * is what the record is FOR. A payment row must exist before the charge,
   * because a charge cannot be un-made and the row is the only evidence. An
   * email cannot be un-sent either — but the row is a log, not a ledger, and
   * writing it first would mean a database failure could stop a receipt
   * going out. Here, sending is the thing that matters most.
   *
   * The consequence is honest and worth knowing: if this process dies
   * between the send and this insert, the customer has an email nobody has a
   * record of.
   */
  async record(input: RecordNotificationInput): Promise<NotificationRecord> {
    const notification = await this.notifications.create({
      userId: input.userId,
      type: input.type,
      status: input.status,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      failureReason: input.failureReason,
      sentAt: input.status === NotificationStatus.Sent ? new Date() : null,
    } as Notification);

    return toRecord(notification);
  }

  /** Always scoped by user — an email address is personal data. */
  async list(
    userId: string,
    page: number,
    limit: number,
    filters: { type?: NotificationType; status?: NotificationStatus },
  ): Promise<{ rows: NotificationRecord[]; total: number }> {
    const { rows, count } = await this.notifications.findAndCountAll({
      where: {
        userId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { rows: rows.map(toRecord), total: count };
  }
}

function toRecord(notification: Notification): NotificationRecord {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    status: notification.status,
    recipient: notification.recipient,
    subject: notification.subject,
    failureReason: notification.failureReason,
    sentAt: notification.sentAt,
    createdAt: notification.createdAt,
  };
}
