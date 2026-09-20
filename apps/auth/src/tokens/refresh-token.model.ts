import {
  Column,
  CreatedAt,
  DataType,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * The `refresh_tokens` row.
 *
 * As with `User`, this is one process's VIEW of the schema — the migration is
 * the authority. If the two ever disagree, the migration is right and this is
 * a bug.
 *
 * Note there is no `token` column anywhere in this class, because there is no
 * such column. Only the hash is stored; the token itself exists exactly twice
 * — in the response that hands it to the client, and in the request that
 * brings it back.
 */
@Table({
  tableName: 'refresh_tokens',
  underscored: true,
  timestamps: true,
})
export class RefreshToken extends Model<RefreshToken> {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.CHAR(64), allowNull: false })
  declare tokenHash: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare familyId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare replacedBy: string | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
