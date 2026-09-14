import { Column, DataType, Model, Table } from 'sequelize-typescript';

/**
 * An event this service has already handled.
 *
 * No `updatedAt`: a row here is written once and never touched again. It is
 * a fact — "I have done this one" — and facts are not edited.
 */
@Table({
  tableName: 'processed_events',
  underscored: true,
  // `createdAt` would duplicate `handledAt`, and two timestamps that must
  // agree are two timestamps that eventually will not.
  timestamps: false,
})
export class ProcessedEvent extends Model<ProcessedEvent> {
  /** The publisher's id for the event. The same for every delivery of it. */
  @Column({ type: DataType.UUID, primaryKey: true, allowNull: false })
  eventId!: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  pattern!: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  handledAt!: Date;
}
