import { ProductStatus } from '@ecommerce/contracts';
import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Category } from '../categories/category.model';

/**
 * The `products` row.
 *
 * Private to the Product Service. When the Order Service later needs a
 * product's name and price it will call this service's API or consume an
 * event — it will not import this class and it will not query this table.
 * That rule is the whole of database-per-service.
 */
@Table({
  tableName: 'products',
  underscored: true,
  timestamps: true,
  paranoid: true,
})
export class Product extends Model<Product> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  name!: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  description!: string | null;

  @Column({ type: DataType.STRING(64), allowNull: false })
  sku!: string;

  /**
   * Typed as `string`, not `number`, and this is not a mistake.
   *
   * The `pg` driver returns NUMERIC as a STRING on purpose: a JavaScript
   * number is an IEEE-754 double and cannot represent every DECIMAL(12,2)
   * value exactly. Handing you a string means the driver has not silently
   * lost precision before you even see the value.
   *
   * You CAN tell pg to parse NUMERIC into a float — and people do, and then
   * spend an afternoon working out why a total is off by a cent. Keep it a
   * string; convert only at the point of arithmetic, and only with a decimal
   * library.
   */
  @Column({ type: DataType.DECIMAL(12, 2), allowNull: false })
  price!: string;

  @Column({ type: DataType.STRING(3), allowNull: false, defaultValue: 'USD' })
  currency!: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: ProductStatus.Draft,
  })
  status!: ProductStatus;

  @ForeignKey(() => Category)
  @Column({ type: DataType.UUID, allowNull: false })
  categoryId!: string;

  /**
   * Populated only when a query explicitly includes it.
   *
   * The N+1 QUERY PROBLEM lives here. Fetch 20 products and then read
   * `product.category` on each one and you issue 1 + 20 queries. Sequelize
   * will not warn you; the endpoint just gets slower as the page size grows.
   *
   * The fix is `include: [Category]`, which turns it into a single JOIN.
   * `ProductsRepository` does exactly that — see the `include` in its
   * findMany and findById.
   */
  @BelongsTo(() => Category)
  category?: Category;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;

  @DeletedAt
  override deletedAt!: Date | null;
}
