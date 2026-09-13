import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * What a notification is about.
 *
 * Named after the BUSINESS EVENT, not after the template. `ORDER_CONFIRMED`,
 * not `order-confirmation-email-v2`: the type is what happened, and the
 * template is one changeable way of expressing it. Naming these after
 * templates would mean a redesign becomes a new enum value and a contract
 * change.
 */
export enum NotificationType {
  Welcome = 'WELCOME',
  OrderConfirmed = 'ORDER_CONFIRMED',
  PaymentReceipt = 'PAYMENT_RECEIPT',
}

export enum NotificationStatus {
  /** Handed to the mail transport and accepted. */
  Sent = 'SENT',
  /**
   * The transport refused it, or there was no address to send to. Recorded
   * rather than thrown away — an email nobody received is exactly the thing
   * support needs to see.
   */
  Failed = 'FAILED',
}

export class NotificationDto {
  id!: string;

  type!: NotificationType;

  status!: NotificationStatus;

  /** Where it went. Shown to the owner of the address only. */
  recipient!: string;

  subject!: string;

  /** Set when the transport refused it. */
  failureReason?: string | null;

  sentAt?: Date | null;

  createdAt!: Date;
}

export class QueryNotificationsDto {
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
