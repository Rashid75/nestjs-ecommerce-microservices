import { StockMovementType } from '@ecommerce/contracts';
import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { InventoryItem } from './inventory-item.model';

/**
 * One entry in the append-only stock ledger.
 *
 * `timestamps: false` with a hand-declared `createdAt` and NO `updatedAt`,
 * because a ledger entry is never updated. Giving the model an `updatedAt`
 * would advertise a capability that must not exist.
 */
@Table({
  tableName: 'stock_movements',
  underscored: true,
  timestamps: true,
  updatedAt: false,
})
export class StockMovement extends Model<StockMovement> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @ForeignKey(() => InventoryItem)
  @Column({ type: DataType.UUID, allowNull: false })
  inventoryItemId!: string;

  @BelongsTo(() => InventoryItem)
  item?: InventoryItem;

  @Column({ type: DataType.STRING(20), allowNull: false })
  type!: StockMovementType;

  /** Signed: +10 for a receive, −3 for a release. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  quantity!: number;

  @Column({ type: DataType.STRING(200), allowNull: true })
  reference!: string | null;

  /** Balances immediately after this movement, captured at write time. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  onHandAfter!: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  reservedAfter!: number;

  @CreatedAt
  override createdAt!: Date;
}
