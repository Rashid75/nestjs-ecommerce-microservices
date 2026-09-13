import {
  Column,
  CreatedAt,
  DataType,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * A local copy of what this service needs to reach a customer.
 *
 * A PROJECTION built from `user.registered` — see the long note in the
 * migration for why this service keeps its own copy instead of asking the
 * Auth Service every time.
 */
@Table({ tableName: 'contacts', underscored: true, timestamps: true })
export class Contact extends Model<Contact> {
  /** The user id is the primary key: one contact per user, by definition. */
  @Column({ type: DataType.UUID, primaryKey: true, allowNull: false })
  userId!: string;

  @Column({ type: DataType.STRING(320), allowNull: false })
  email!: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  firstName!: string | null;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
