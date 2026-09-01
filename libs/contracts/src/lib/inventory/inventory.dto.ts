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
  id!: string;

  productId!: string;

  sku!: string;

  onHand!: number;

  reserved!: number;

  available!: number;

  updatedAt!: Date;
}

/** Registers a product with the inventory system. */
export class CreateInventoryDto {
  @IsUUID('4')
  productId!: string;

  @IsString()
  @MaxLength(64)
  sku!: string;

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
  @Type(() => Number)
  // Strictly positive. Allowing 0 would let a caller write meaningless ledger
  // rows; allowing negatives would let `reserve` secretly become `release`
  // and bypass every availability check below it.
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_OPERATION)
  quantity!: number;

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
  @Type(() => Number)
  @IsInt()
  @Min(-MAX_QUANTITY_PER_OPERATION)
  @Max(MAX_QUANTITY_PER_OPERATION)
  delta!: number;

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
  id!: string;

  type!: StockMovementType;

  quantity!: number;

  reference!: string | null;

  onHandAfter!: number;

  reservedAfter!: number;

  createdAt!: Date;
}
