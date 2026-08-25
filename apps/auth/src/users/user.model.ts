import { UserRole } from '@ecommerce/contracts';
import {
  Column,
  CreatedAt,
  DataType,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * The `users` row, as this process reads and writes it.
 *
 * A model is NOT a migration. The migration is the authoritative history of
 * the schema; this class is one process's view of it. They are kept in sync by
 * hand, on purpose — `synchronize` is off, so nothing here can alter the
 * database. If they ever disagree, the migration is right and this file is a
 * bug.
 *
 * This model lives inside the Auth Service and is NOT exported through
 * `@ecommerce/contracts`. No other service may read the users table. When the
 * Order Service needs a customer's name it will ask the Auth/User Service over
 * HTTP or consume an event — it will not join across databases. That rule is
 * what makes database-per-service mean anything.
 */
@Table({
  tableName: 'users',
  // Maps camelCase attributes to snake_case columns: passwordHash ->
  // password_hash, createdAt -> created_at. TypeScript code reads naturally,
  // SQL reads naturally, and neither side has to compromise.
  underscored: true,
  timestamps: true,
  // LAYER 1 of the defence around the credential.
  //
  // With this scope the column is not even named in the SELECT list, so the
  // hash never enters the process unless something explicitly asks for it via
  // `.scope('withPasswordHash')`. Compare that to remembering to delete a
  // property before every response: one forgotten branch and the hash is on
  // the wire.
  defaultScope: {
    attributes: { exclude: ['passwordHash'] },
  },
  scopes: {
    // The single, named, greppable exception. Login needs the hash to compare
    // against; nothing else does. `git grep withPasswordHash` should return a
    // very short list, and every entry should be obviously justified.
    withPasswordHash: {
      attributes: { include: ['passwordHash'] },
    },
  },
})
export class User extends Model<User> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    // Generated in JavaScript even though the migration also sets a
    // database-side DEFAULT gen_random_uuid().
    //
    // Letting the database assign the id does not work with Sequelize's
    // create(): Sequelize always includes the primary key in the INSERT, and a
    // column DEFAULT only applies when the column is ABSENT. So it sends
    // id = NULL and Postgres rejects it.
    //
    // The database default is not dead code — it still applies to writers that
    // omit the column, such as a psql insert or a data-fix script. Two
    // writers, two mechanisms, both producing v4 UUIDs.
    defaultValue: DataType.UUIDV4,
  })
  override id!: string;

  @Column({ type: DataType.STRING(320), allowNull: false })
  email!: string;

  /**
   * bcrypt output. Excluded by `defaultScope` above.
   *
   * The name says `hash`, not `password`, everywhere it appears. That is not
   * pedantry: the moment a field is called `password` somebody logs it.
   */
  @Column({ type: DataType.STRING(255), allowNull: false })
  passwordHash!: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  firstName!: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  lastName!: string;

  /**
   * Typed as the shared UserRole enum, stored as VARCHAR with a CHECK
   * constraint in the database. TypeScript stops us writing a bad value;
   * the CHECK constraint stops anything else from doing so.
   */
  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: UserRole.Customer,
  })
  role!: UserRole;

  /** False disables login without deleting the row or orphaning its history. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  isActive!: boolean;

  @CreatedAt
  override createdAt!: Date;

  @UpdatedAt
  override updatedAt!: Date;
}
