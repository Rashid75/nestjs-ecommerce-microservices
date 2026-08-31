import {
  Column,
  CreatedAt,
  DataType,
  HasMany,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { CartItem } from './cart-item.model';

export enum CartStatus {
  Active = 'ACTIVE',
  Converted = 'CONVERTED',
  Abandoned = 'ABANDONED',
}

/**
 * A customer's cart.
 *
 * Never deleted, only transitioned. An abandoned cart is one of the most
 * commercially useful records a shop holds — it is a stated purchase intent
 * with a known owner, which is exactly what a recovery email needs.
 */
@Table({ tableName: 'carts', underscored: true, timestamps: true })
export class Cart extends Model<Cart> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  /** Owner. Comes from the verified token, never from a request body. */
  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: CartStatus.Active,
  })
  status!: CartStatus;

  @Column({ type: DataType.STRING(3), allowNull: false, defaultValue: 'USD' })
  currency!: string;

  @HasMany(() => CartItem)
  items!: CartItem[];

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
