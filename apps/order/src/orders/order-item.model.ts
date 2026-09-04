import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Order } from './order.model';

/**
 * One line of an order — the THIRD copy of the same product data.
 *
 *   catalogue → cart line (snapshot at add-time)
 *               → order line (snapshot at checkout)
 *
 * Duplication on purpose, at every step, and each copy answers a different
 * question. The catalogue says what the product costs NOW. The cart says
 * what the customer was SHOWN. The order says what they AGREED TO PAY — and
 * that one has to be immutable, because it is the figure a refund, a
 * chargeback and a tax return are all computed from.
 *
 * Normalising this away with a foreign key to the catalogue would mean an
 * order's total silently changing whenever a price does. Every real shop
 * denormalises here, and it is not a compromise: point-in-time facts belong
 * to the record that asserts them.
 */
@Table({ tableName: 'order_items', underscored: true, timestamps: true })
export class OrderItem extends Model<OrderItem> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @ForeignKey(() => Order)
  @Column({ type: DataType.UUID, allowNull: false })
  orderId!: string;

  @BelongsTo(() => Order)
  order?: Order;

  @Column({ type: DataType.UUID, allowNull: false })
  productId!: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  sku!: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  name!: string;

  @Column({ type: DataType.DECIMAL(12, 2), allowNull: false })
  unitPrice!: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  quantity!: number;

  /** Stored, and checked against unitPrice × quantity by the database. */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: false })
  lineTotal!: string;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
