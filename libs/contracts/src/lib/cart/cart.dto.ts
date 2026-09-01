import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Most units of one product a single cart line may hold. */
export const MAX_LINE_QUANTITY = 99;

/**
 * One line in a cart.
 *
 * THE SNAPSHOT DECISION — the most consequential choice in this milestone.
 *
 * `unitPrice` and `name` are COPIED from the catalogue when the item is
 * added, not looked up when the cart is read. Two options, both defensible:
 *
 *   LIVE LOOKUP    join to the current product on every read. The cart is
 *                  always accurate — and the total silently changes while
 *                  the customer is looking at it. A £40 basket becomes £46
 *                  between the cart page and the checkout button, with no
 *                  explanation. It also couples cart reads to the Product
 *                  Service being up.
 *
 *   SNAPSHOT       copy the price at add-time. The total is stable, the cart
 *                  renders with the Product Service down, and you have a
 *                  record of what the customer was actually shown — which is
 *                  what a dispute or a regulator will ask for.
 *
 * We snapshot. The cost is staleness: a price change is not reflected in an
 * existing cart. That is handled by RE-VALIDATING at checkout — comparing
 * each snapshot against the live price and telling the customer what moved,
 * rather than silently charging either figure. That comparison belongs to
 * the order workflow, and is noted as deferred with M8 as its trigger.
 *
 * The general rule: snapshot what the customer was shown; re-check before
 * taking money.
 */
export class CartItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ example: 'LAP-X1C-14-2026' })
  sku!: string;

  @ApiProperty({
    example: 'ThinkPad X1 Carbon',
    description: 'Snapshot of the product name at the time it was added.',
  })
  name!: string;

  @ApiProperty({
    type: String,
    example: '1899.00',
    description:
      'Snapshot of the unit price at add-time. Exact decimal string — never parse as a float for money.',
  })
  unitPrice!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({
    type: String,
    example: '3798.00',
    description:
      'unitPrice × quantity, computed with exact decimal arithmetic.',
  })
  lineTotal!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  addedAt!: Date;

  /**
   * Set when a `product.price_changed` event arrived after this line was
   * added. The snapshot above is UNCHANGED — this only says it is stale.
   *
   * A UI shows both: "was 19.99, now 24.99". Checkout uses it to force a
   * re-confirmation rather than silently charging either figure.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '24.99',
    description:
      'The catalogue price now, if it has changed since this line was added. Null means the snapshot is still current.',
  })
  cataloguePrice?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'True when the product has been archived. The line stays in the cart — removing it silently is more alarming than showing it with a reason.',
  })
  unavailable?: boolean;
}

export class CartDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The owner. Taken from the access token, never from the body.',
  })
  userId!: string;

  @ApiProperty({ type: [CartItemDto] })
  items!: CartItemDto[];

  @ApiProperty({ example: 3, description: 'Number of distinct lines.' })
  itemCount!: number;

  @ApiProperty({ example: 5, description: 'Sum of quantities across lines.' })
  totalQuantity!: number;

  @ApiProperty({
    type: String,
    example: '3798.00',
    description:
      'Sum of line totals. Exact decimal string, computed in integer minor units.',
  })
  subtotal!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  productId!: string;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // A per-line cap. Not a business rule about how much anyone may buy — a
  // guard against a typo or a script turning one cart line into a
  // denial-of-service against the checkout arithmetic and the warehouse.
  @Max(MAX_LINE_QUANTITY)
  quantity?: number;

  // NOTE what is absent: no `unitPrice`, no `name`, no `userId`.
  //
  // A client that could send its own price would set it to 0.01. A client
  // that could send its own userId would read and edit other people's carts.
  // Both are supplied by the SERVER — the price from the Product Service,
  // the user from the verified access token — and `forbidNonWhitelisted`
  // means sending them is a 400 rather than a silent strip.
}

export class UpdateCartItemDto {
  @ApiProperty({
    example: 3,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description:
      'The ABSOLUTE new quantity, not a delta. Use DELETE to remove a line.',
  })
  @Type(() => Number)
  @IsInt()
  // Minimum 1, deliberately. Accepting 0 as "remove" would give two ways to
  // do the same thing, and a client that sends 0 by accident would silently
  // lose a line instead of getting an error. DELETE means delete.
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
