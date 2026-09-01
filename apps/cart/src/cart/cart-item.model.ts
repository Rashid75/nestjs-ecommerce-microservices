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
import { Cart } from './cart.model';

/**
 * One line in a cart, carrying a SNAPSHOT of the product at add-time.
 *
 * The snapshot is why this table duplicates `sku`, `name` and `unitPrice`
 * from the catalogue. That duplication is the feature: it is the record of
 * what the customer was actually shown, it keeps cart reads working when the
 * Product Service is down, and it stops the total moving under the customer
 * while they look at it.
 */
@Table({ tableName: 'cart_items', underscored: true, timestamps: true })
export class CartItem extends Model<CartItem> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @ForeignKey(() => Cart)
  @Column({ type: DataType.UUID, allowNull: false })
  cartId!: string;

  @BelongsTo(() => Cart)
  cart?: Cart;

  @Column({ type: DataType.UUID, allowNull: false })
  productId!: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  sku!: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  name!: string;

  /**
   * String, not number — the pg driver returns NUMERIC as a string precisely
   * so it has not silently lost precision before you see it.
   */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: false })
  unitPrice!: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  quantity!: number;

  /**
   * What the catalogue says now, set by the `product.price_changed` handler.
   * NULL means the snapshot still matches the catalogue.
   *
   * Shown ALONGSIDE unitPrice, never instead of it — the customer keeps
   * seeing the price they were shown, and the UI can say what moved.
   */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: true })
  cataloguePrice!: string | null;

  /**
   * Set by the `product.archived` consumer. The line stays in the cart —
   * silently removing an item alarms a customer more than showing it greyed
   * out with a reason.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  unavailableAt!: Date | null;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
