import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Largest quantity any single operation may move.
 *
 * Not a business rule about warehouse size — a blast-radius limit. A typo of
 * 1000000 instead of 10 in a receive call should be refused, not silently
 * turned into a million units of phantom stock that someone then has to
 * reconcile by hand.
 */
export const MAX_QUANTITY_PER_OPERATION = 100_000;

/**
 * The stock position for one product.
 *
 * THREE NUMBERS, AND ONLY ONE OF THEM IS THE INTERESTING ONE.
 *
 *   onHand     physically in the warehouse. Changes when goods arrive or
 *              ship. Never decremented merely because someone is buying.
 *   reserved   promised to carts and pending orders. Physically still there,
 *              but not available to anyone else.
 *   available  onHand − reserved. DERIVED, never stored.
 *
 * `available` is computed rather than stored on purpose. A stored third
 * column can drift out of agreement with the other two — and when it does,
 * you cannot tell which of the three is wrong. Deriving it means the
 * invariant is structural rather than something a background job has to
 * repair.
 */
export class InventoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The product this stock belongs to. Owned by the Product Service — there is no foreign key, because it lives in a different database.',
  })
  productId!: string;

  @ApiProperty({ example: 'LAP-X1C-14-2026' })
  sku!: string;

  @ApiProperty({ example: 25, description: 'Physically in the warehouse.' })
  onHand!: number;

  @ApiProperty({ example: 3, description: 'Promised to pending orders.' })
  reserved!: number;

  @ApiProperty({
    example: 22,
    description: 'onHand − reserved. Derived, never stored.',
  })
  available!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/** Registers a product with the inventory system. */
export class CreateInventoryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  productId!: string;

  @ApiProperty({
    example: 'LAP-X1C-14-2026',
    maxLength: 64,
    description:
      'Copied from the Product Service for human-readable operations. Denormalised on purpose — see the note on the model.',
  })
  @IsString()
  @MaxLength(64)
  sku!: string;

  @ApiPropertyOptional({
    example: 0,
    default: 0,
    description: 'Opening stock. Defaults to zero — nothing arrives by magic.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_QUANTITY_PER_OPERATION)
  onHand?: number;
}

/**
 * The body for receive, reserve, release and fulfil.
 *
 * One shape for all four because they are the same kind of instruction —
 * "move this many units, and here is why". The `reference` is what makes the
 * ledger useful and what idempotency will hang off in Milestone 8.
 */
export class StockOperationDto {
  @ApiProperty({
    example: 5,
    minimum: 1,
    maximum: MAX_QUANTITY_PER_OPERATION,
    description: 'Always POSITIVE. The operation decides the direction.',
  })
  @Type(() => Number)
  // Strictly positive. Allowing 0 would let a caller write meaningless ledger
  // rows; allowing negatives would let `reserve` secretly become `release`
  // and bypass every availability check below it.
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_OPERATION)
  quantity!: number;

  @ApiPropertyOptional({
    example: 'order:9f3c...',
    maxLength: 200,
    description:
      'What caused this movement — an order id, a purchase order, a support ticket. Recorded in the ledger.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

/**
 * A manual correction — a stock count, breakage, a returned item.
 *
 * Separate from `receive` because the SIGN is meaningful and the reason is
 * mandatory. An unexplained adjustment is indistinguishable from theft or a
 * bug, so the API refuses to accept one.
 */
export class AdjustStockDto {
  @ApiProperty({
    example: -2,
    description: 'Signed delta applied to onHand. May be negative.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(-MAX_QUANTITY_PER_OPERATION)
  @Max(MAX_QUANTITY_PER_OPERATION)
  delta!: number;

  @ApiProperty({
    example: 'annual stock count',
    maxLength: 200,
    description: 'Required. An adjustment with no reason is not auditable.',
  })
  @IsString()
  @MaxLength(200)
  reason!: string;
}

/** Movement types recorded in the append-only ledger. */
export enum StockMovementType {
  /** Goods arrived. onHand increases. */
  Receive = 'RECEIVE',
  /** Promised to an order. reserved increases; onHand unchanged. */
  Reserve = 'RESERVE',
  /** Promise cancelled. reserved decreases; onHand unchanged. */
  Release = 'RELEASE',
  /** Shipped. BOTH onHand and reserved decrease. */
  Fulfil = 'FULFIL',
  /** Manual correction, signed, with a mandatory reason. */
  Adjust = 'ADJUST',
}

export class StockMovementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: StockMovementType, enumName: 'StockMovementType' })
  type!: StockMovementType;

  @ApiProperty({
    example: 5,
    description: 'Signed. Negative for movements that reduce the figure.',
  })
  quantity!: number;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ example: 25, description: 'onHand AFTER this movement.' })
  onHandAfter!: number;

  @ApiProperty({ example: 3, description: 'reserved AFTER this movement.' })
  reservedAfter!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
