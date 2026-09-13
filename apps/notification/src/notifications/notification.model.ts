import { NotificationStatus, NotificationType } from '@ecommerce/contracts';
import {
  Column,
  CreatedAt,
  DataType,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * One email, and what became of it.
 *
 * Written whether or not the send succeeded. A failure that leaves no row is
 * a customer who did not get their receipt and a system that cannot tell you
 * so.
 */
@Table({ tableName: 'notifications', underscored: true, timestamps: true })
export class Notification extends Model<Notification> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({ type: DataType.STRING(30), allowNull: false })
  type!: NotificationType;

  @Column({ type: DataType.STRING(20), allowNull: false })
  status!: NotificationStatus;

  /** The address it actually went to, not the contact's current one. */
  @Column({ type: DataType.STRING(320), allowNull: false })
  recipient!: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  subject!: string;

  /** Kept so "what did we send them?" has an answer. */
  @Column({ type: DataType.TEXT, allowNull: false })
  body!: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  failureReason!: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  sentAt!: Date | null;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
