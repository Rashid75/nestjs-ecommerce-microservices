import { PaymentFailureCode, PaymentStatus } from '@ecommerce/contracts';
import {
  Column,
  CreatedAt,
  DataType,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * One attempt to take money.
 *
 * Never deleted and never edited except to record the provider's answer. A
 * payment row is the strongest evidence this system holds that a customer
 * was or was not charged, and the day there is a dispute it is the only
 * thing anyone will look at.
 */
@Table({ tableName: 'payments', underscored: true, timestamps: true })
export class Payment extends Model<Payment> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  /** From the database sequence, so this model never sets it. */
  @Column({ type: DataType.STRING(20), allowNull: false })
  reference!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  orderId!: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  orderNumber!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: PaymentStatus.Pending,
  })
  status!: PaymentStatus;

  /** DECIMAL arrives as a string from the pg driver. It stays one. */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: false })
  amount!: string;

  @Column({ type: DataType.STRING(3), allowNull: false, defaultValue: 'USD' })
  currency!: string;

  /**
   * The provider's token for the card. NOT a card number — see the long
   * note in the migration for why no such column exists.
   */
  @Column({ type: DataType.STRING(64), allowNull: false })
  paymentMethodToken!: string;

  @Column({ type: DataType.STRING(4), allowNull: true })
  cardLast4!: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true })
  cardBrand!: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  providerReference!: string | null;

  @Column({ type: DataType.STRING(40), allowNull: true })
  failureCode!: PaymentFailureCode | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  failureMessage!: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  retryable!: boolean;

  /**
   * The client's key for this attempt. NULL when none was sent.
   *
   * Unique per user, so the same key always identifies the same attempt —
   * see the two indexes in the migration and why they are different things.
   */
  @Column({ type: DataType.STRING(100), allowNull: true })
  idempotencyKey!: string | null;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
