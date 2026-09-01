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
  id!: string;

  productId!: string;

  sku!: string;

  name!: string;

  unitPrice!: string;

  quantity!: number;

  lineTotal!: string;

  addedAt!: Date;

  /**
   * Set when a `product.price_changed` event arrived after this line was
   * added. The snapshot above is UNCHANGED — this only says it is stale.
   *
   * A UI shows both: "was 19.99, now 24.99". Checkout uses it to force a
   * re-confirmation rather than silently charging either figure.
   */
  cataloguePrice?: string | null;

  unavailable?: boolean;
}

export class CartDto {
  id!: string;

  userId!: string;

  items!: CartItemDto[];

  itemCount!: number;

  totalQuantity!: number;

  subtotal!: string;

  currency!: string;

  updatedAt!: Date;
}

export class AddCartItemDto {
  @IsUUID('4')
  productId!: string;

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
  @Type(() => Number)
  @IsInt()
  // Minimum 1, deliberately. Accepting 0 as "remove" would give two ways to
  // do the same thing, and a client that sends 0 by accident would silently
  // lose a line instead of getting an error. DELETE means delete.
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
