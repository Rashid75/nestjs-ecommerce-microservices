import {
  AddCartItemDto,
  CartDto,
  CartItemDto,
  MAX_LINE_QUANTITY,
  UpdateCartItemDto,
} from '@ecommerce/contracts';
import { lineTotal, sumDecimals } from '@ecommerce/money';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ProductLookupService } from '../catalog/product-lookup.service';
import { CartItemRecord, CartRecord, CartRepository } from './cart.repository';

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly carts: CartRepository,
    private readonly products: ProductLookupService,
  ) {}

  /**
   * GET /cart — get or create.
   *
   * A GET that can create a row is unusual and worth defending. The
   * alternative is `POST /cart` first, which means every client has to
   * handle "no cart yet" and the very first page load becomes two round
   * trips. "Your cart" is a thing that conceptually always exists and is
   * merely empty, so the API models it that way.
   *
   * It stays safe because the operation is IDEMPOTENT: calling it a hundred
   * times yields the same single cart, guaranteed by the partial unique
   * index rather than by hope.
   */
  async getCart(userId: string): Promise<CartDto> {
    return toDto(await this.carts.findOrCreateActive(userId));
  }

  /**
   * Adds a product to the cart.
   *
   * The order of operations matters: fetch the product FIRST, then write.
   * A failed lookup then leaves the cart untouched, so there is nothing to
   * undo. Writing first and enriching afterwards would need a compensating
   * delete if the lookup failed — a miniature Saga, for no benefit.
   */
  async addItem(userId: string, dto: AddCartItemDto): Promise<CartDto> {
    const cart = await this.carts.findOrCreateActive(userId);

    // Server-supplied price and name. A client-supplied price would be
    // 0.01 within a day of launch.
    const snapshot = await this.products.fetchSnapshot(dto.productId);

    await this.carts.addItem(
      cart.id,
      snapshot,
      dto.quantity ?? 1,
      MAX_LINE_QUANTITY,
    );

    this.logger.log(`cart ${cart.id}: added ${snapshot.sku}`);
    return toDto(await this.carts.findOrCreateActive(userId));
  }

  /** Sets an absolute quantity on an existing line. */
  async updateItem(
    userId: string,
    productId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartDto> {
    const cart = await this.carts.findOrCreateActive(userId);

    const updated = await this.carts.setQuantity(
      cart.id,
      productId,
      dto.quantity,
    );
    if (!updated) {
      throw new NotFoundException(`Product ${productId} is not in your cart`);
    }

    // No product lookup here, deliberately. Changing a quantity must not
    // re-price the line — the snapshot is what the customer was shown, and
    // quietly repricing on an unrelated action is exactly the surprise
    // snapshotting exists to prevent.
    return toDto(await this.carts.findOrCreateActive(userId));
  }

  async removeItem(userId: string, productId: string): Promise<CartDto> {
    const cart = await this.carts.findOrCreateActive(userId);

    const removed = await this.carts.removeItem(cart.id, productId);
    if (!removed) {
      throw new NotFoundException(`Product ${productId} is not in your cart`);
    }

    return toDto(await this.carts.findOrCreateActive(userId));
  }

  async clear(userId: string): Promise<CartDto> {
    const cart = await this.carts.findOrCreateActive(userId);
    await this.carts.clear(cart.id);
    this.logger.log(`cart ${cart.id}: cleared`);
    return toDto(await this.carts.findOrCreateActive(userId));
  }
}

/**
 * Record → DTO, computing the totals.
 *
 * Totals are DERIVED on every read, never stored — the same reasoning as
 * `available` in the Inventory Service. A stored subtotal is one more thing
 * that can disagree with the lines it summarises, and when it does you
 * cannot tell which is wrong.
 *
 * The arithmetic goes through `@ecommerce/money`, which works in integer minor
 * units. Summing `Number(unitPrice) * quantity` would be simpler and would
 * quietly produce 59.96999999999999.
 */
function toDto(record: CartRecord): CartDto {
  const items: CartItemDto[] = record.items.map((item) => ({
    id: item.id,
    productId: item.productId,
    sku: item.sku,
    name: item.name,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    lineTotal: lineTotal(item.unitPrice, item.quantity),
    addedAt: item.addedAt,
    // Only present when something actually changed, so a normal cart is not
    // cluttered with nulls.
    ...(item.cataloguePrice !== null
      ? { cataloguePrice: item.cataloguePrice }
      : {}),
    ...(item.unavailable ? { unavailable: true } : {}),
  }));

  return {
    id: record.id,
    userId: record.userId,
    items,
    itemCount: items.length,
    totalQuantity: items.reduce(
      (total: number, item: CartItemDto) => total + item.quantity,
      0,
    ),
    subtotal: sumDecimals(items.map((item) => item.lineTotal)),
    currency: record.currency,
    updatedAt: record.updatedAt,
  };
}

/** Exported for the unit tests, which assert on the derived totals. */
export const __toDto = toDto;
export type { CartItemRecord };
