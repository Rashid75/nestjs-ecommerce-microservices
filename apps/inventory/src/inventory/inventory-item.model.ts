import {
  Column,
  CreatedAt,
  DataType,
  HasMany,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { StockMovement } from './stock-movement.model';

/**
 * The current stock position for one product.
 *
 * No soft delete here, unlike products and categories. An inventory row IS
 * the balance — hiding it would not make the stock disappear, it would make
 * the stock unaccounted for. Retiring a product means adjusting its quantity
 * to zero, which leaves a ledger entry explaining where the units went.
 */
@Table({
  tableName: 'inventory_items',
  underscored: true,
  timestamps: true,
})
export class InventoryItem extends Model<InventoryItem> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  /**
   * The product this stock belongs to.
   *
   * Owned by the Product Service, in a different database, with no foreign
   * key. See the long note in the migration — that absence is the design,
   * not an oversight.
   */
  @Column({ type: DataType.UUID, allowNull: false })
  productId!: string;

  /** Denormalised label for operations. Never read to make a decision. */
  @Column({ type: DataType.STRING(64), allowNull: false })
  sku!: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'quantity_on_hand',
  })
  onHand!: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'quantity_reserved',
  })
  reserved!: number;

  /**
   * OPTIMISTIC LOCKING counter. Incremented by every write in this service.
   *
   * Deliberately a PLAIN column rather than Sequelize's managed `version:
   * true` model option. Turning that on would make Sequelize append
   * `WHERE version = :seen` to every model-level save and throw
   * OptimisticLockError — useful, but it would also collide confusingly with
   * the raw atomic UPDATEs in the repository, which bump the same column
   * themselves.
   *
   * The reserve path does not need it at all: one atomic conditional UPDATE
   * has no read-modify-write window to protect. This column is here for the
   * flow that genuinely needs optimistic locking — a human holding an
   * edit form open for thirty seconds, where you cannot hold a row lock for
   * the duration and must instead re-check `WHERE version = :seen` and
   * reject the loser.
   *
   * Pessimistic locking blocks writers. Optimistic locking lets them race
   * and makes the loser retry. Which is right depends entirely on how likely
   * a collision is.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  override version!: number;

  @HasMany(() => StockMovement)
  movements!: StockMovement[];

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
