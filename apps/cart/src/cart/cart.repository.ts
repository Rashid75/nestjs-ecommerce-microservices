import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Transaction, UniqueConstraintError } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { ProductSnapshot } from '../catalog/product-lookup.service';
import { CartItem } from './cart-item.model';
import { Cart, CartStatus } from './cart.model';

export interface CartItemRecord {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unitPrice: string;
  quantity: number;
  addedAt: Date;
  cataloguePrice: string | null;
  unavailable: boolean;
}

export interface CartRecord {
  id: string;
  userId: string;
  currency: string;
  items: CartItemRecord[];
  updatedAt: Date;
}

/** Raised when a line the caller named is not in the cart. */
export class CartItemNotFoundError extends Error {
  constructor(productId: string) {
    super(`no cart line for product ${productId}`);
    this.name = 'CartItemNotFoundError';
  }
}

/** Raised when adding an item priced in a currency the cart cannot hold. */
export class CurrencyMismatchError extends Error {
  constructor(
    readonly cartCurrency: string,
    readonly itemCurrency: string,
  ) {
    super(`cart is in ${cartCurrency}, item is in ${itemCurrency}`);
    this.name = 'CurrencyMismatchError';
  }
}

@Injectable()
export class CartRepository {
  constructor(
    @InjectModel(Cart) private readonly carts: typeof Cart,
    @InjectModel(CartItem) private readonly items: typeof CartItem,
    private readonly sequelize: Sequelize,
  ) {}

  /**
   * Returns the user's active cart, creating one if there is none.
   *
   * THE RACE, AND WHY THE CATCH IS THE FIX. Two simultaneous first requests
   * from the same user both find nothing and both try to insert. This is the
   * same check-then-act shape as the duplicate email and the last unit of
   * stock, and it has the same answer: let the database arbitrate.
   *
   * The partial unique index `carts_one_active_per_user` makes the loser's
   * INSERT fail. Catching that and re-reading is not a workaround — it is
   * the correct handling, because the constraint is the only thing that is
   * actually atomic. A pre-check would simply move the race, not remove it.
   */
  async findOrCreateActive(userId: string): Promise<CartRecord> {
    const existing = await this.findActive(userId);
    if (existing !== null) {
      return existing;
    }

    try {
      await this.carts.create({
        userId,
        status: CartStatus.Active,
        currency: 'USD',
      } as Cart);
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) {
        throw error;
      }
      // Lost the race. The winner's cart is now committed, so read it.
    }

    const cart = await this.findActive(userId);
    if (cart === null) {
      // Unreachable in practice: either our insert succeeded or someone
      // else's did. Thrown rather than force-unwrapped so a genuine
      // impossibility surfaces as an error, not as `undefined` two frames
      // later.
      throw new Error(`could not obtain an active cart for user ${userId}`);
    }
    return cart;
  }

  async findActive(userId: string): Promise<CartRecord | null> {
    const cart = await this.carts.findOne({
      where: { userId, status: CartStatus.Active },
      // One JOIN, not one query per line. Without the include, mapping over
      // `cart.items` below would issue a query per line — the N+1 problem.
      include: [{ model: CartItem, required: false }],
      order: [[{ model: CartItem, as: 'items' }, 'createdAt', 'ASC']],
    });

    return cart === null ? null : toRecord(cart);
  }

  /**
   * Adds a product, or increases the quantity if it is already there.
   *
   * An UPSERT, because `cart_items` has a unique index on
   * (cart_id, product_id). Adding a product twice must mean "two of them",
   * not "two lines" — and the index makes the second interpretation
   * impossible rather than merely discouraged.
   *
   * `ON CONFLICT ... DO UPDATE` does the whole thing in one statement, so
   * two concurrent adds of the same product cannot interleave into a lost
   * update. Note the snapshot fields are NOT overwritten on conflict: the
   * price the customer first saw is the price that stays, which is the whole
   * point of snapshotting.
   */
  async addItem(
    cartId: string,
    snapshot: ProductSnapshot,
    quantity: number,
    maxQuantity: number,
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO cart_items
         (id, cart_id, product_id, sku, name, unit_price, quantity, created_at, updated_at)
       VALUES
         (gen_random_uuid(), :cartId, :productId, :sku, :name, :unitPrice, :quantity, now(), now())
       ON CONFLICT (cart_id, product_id) DO UPDATE
          SET quantity   = LEAST(cart_items.quantity + EXCLUDED.quantity, :maxQuantity),
              updated_at = now()`,
      {
        replacements: {
          cartId,
          productId: snapshot.productId,
          sku: snapshot.sku,
          name: snapshot.name,
          unitPrice: snapshot.unitPrice,
          quantity,
          // LEAST() clamps rather than rejects. Adding "one more" to a line
          // already at the cap is a harmless action from the customer's point
          // of view, and failing it would be a confusing 400 for something
          // they cannot see. Contrast with PATCH, which sets an absolute
          // value and therefore validates strictly.
          maxQuantity,
        },
      },
    );

    await this.touch(cartId);
  }

  /** Sets an absolute quantity. Returns false when the line does not exist. */
  async setQuantity(
    cartId: string,
    productId: string,
    quantity: number,
  ): Promise<boolean> {
    const [affected] = await this.items.update(
      { quantity },
      { where: { cartId, productId } },
    );
    if (affected === 0) {
      return false;
    }
    await this.touch(cartId);
    return true;
  }

  async removeItem(cartId: string, productId: string): Promise<boolean> {
    const removed = await this.items.destroy({ where: { cartId, productId } });
    if (removed === 0) {
      return false;
    }
    await this.touch(cartId);
    return true;
  }

  /**
   * ACTIVE → CONVERTED, for a cart that became an order.
   *
   * The lines are KEPT. The cart is not emptied and not deleted — it becomes
   * the record of what the customer had in front of them when they checked
   * out. `findOrCreateActive` gives them a fresh empty cart on their next
   * visit, because the partial unique index only covers ACTIVE rows.
   *
   * IDEMPOTENT BY CONSTRUCTION, which is the whole reason it is written as a
   * conditional UPDATE. RabbitMQ delivers at-least-once, so this WILL be
   * called twice for the same cart eventually. `WHERE status = 'ACTIVE'`
   * makes the second call a no-op instead of a mistake — no ledger of
   * processed event ids required.
   *
   * That is the cheapest kind of idempotency and always the first to reach
   * for: make the operation naturally repeatable. A processed-events table
   * is what you need when the work genuinely cannot be repeated — sending an
   * email, charging a card.
   *
   * Returns false when nothing was updated: already converted, or the
   * customer has since started a new cart. Both are ordinary.
   */
  async markConverted(cartId: string): Promise<boolean> {
    const [affected] = await this.carts.update(
      { status: CartStatus.Converted },
      { where: { id: cartId, status: CartStatus.Active } },
    );
    return affected > 0;
  }

  /**
   * Empties the cart but KEEPS it.
   *
   * Deleting the cart row would work and would be wrong: the row carries the
   * creation time and the identity that abandonment analytics and recovery
   * emails rely on. Emptying is a smaller, reversible action; deleting
   * destroys history to save one row.
   */
  async clear(cartId: string): Promise<void> {
    await this.items.destroy({ where: { cartId } });
    await this.touch(cartId);
  }

  /**
   * Bumps `updated_at` on the cart when a LINE changes.
   *
   * Without this, adding an item leaves the cart's timestamp untouched,
   * because Sequelize only updates the row it wrote. The abandonment sweep
   * reads `carts.updated_at`, so an actively-used cart would look stale and
   * be emailed about — or worse, expired — while the customer was still
   * shopping.
   */
  private async touch(
    cartId: string,
    transaction?: Transaction,
  ): Promise<void> {
    await this.carts.update(
      { updatedAt: new Date() },
      { where: { id: cartId }, silent: true, transaction },
    );
  }
}

function toRecord(cart: Cart): CartRecord {
  return {
    id: cart.id,
    userId: cart.userId,
    currency: cart.currency,
    updatedAt: cart.updatedAt,
    items: (cart.items ?? []).map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      // String all the way. See money.ts for why this must never become a
      // JavaScript number.
      unitPrice: String(item.unitPrice),
      quantity: item.quantity,
      addedAt: item.createdAt,
      cataloguePrice:
        item.cataloguePrice === null ? null : String(item.cataloguePrice),
      unavailable: item.unavailableAt !== null,
    })),
  };
}
