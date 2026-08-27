import {
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  HasMany,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Product } from '../products/product.model';

/**
 * The `categories` row.
 *
 * Private to the Product Service. Not exported through
 * `@ecommerce/contracts` — `CategoryDto` is what crosses the boundary.
 */
@Table({
  tableName: 'categories',
  underscored: true,
  timestamps: true,
  // Reads `deleted_at`. SELECTs gain `WHERE deleted_at IS NULL` and
  // `destroy()` becomes an UPDATE. This is the model-side half of the soft
  // delete the migration created — the column alone does nothing.
  paranoid: true,
})
export class Category extends Model<Category> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    // Assigned in JavaScript. Sequelize always includes the primary key in
    // an INSERT, and a column DEFAULT only applies when the column is
    // ABSENT — so relying on gen_random_uuid() alone sends id = NULL and
    // Postgres rejects it. The database default still serves other writers.
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  name!: string;

  @Column({ type: DataType.STRING(140), allowNull: false })
  slug!: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  description!: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  isActive!: boolean;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;

  @DeletedAt
  override deletedAt!: Date | null;

  /**
   * The inverse side of Product.category.
   *
   * Declared so the association exists in both directions, but note that
   * nothing eager-loads it. A category with 50,000 products must never
   * serialise them, and `include: [Product]` on a category listing is
   * exactly how you accidentally load the whole catalogue.
   */
  @HasMany(() => Product)
  products!: Product[];
}
