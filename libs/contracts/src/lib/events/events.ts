/**
 * The event contracts every service agrees on.
 *
 * COMMANDS vs EVENTS — the distinction worth learning first.
 *
 *   A COMMAND says "do this". It is addressed to ONE handler and can be
 *   refused. `ReserveStock` is a command.
 *
 *   An EVENT says "this happened". It is a statement of fact about the past,
 *   addressed to nobody in particular. `StockReserved` is an event.
 *
 * Everything here is an EVENT, named in the PAST TENSE. That is not
 * cosmetic: it stops a publisher from acquiring an opinion about who should
 * react. Write `SendWelcomeEmail` and you have coupled the Auth Service to
 * the existence of an email system. `user.registered` couples it to nothing.
 *
 * These strings are the PATTERN that `@EventPattern()` matches on, and they
 * are the contract between services — treat them as public API.
 */
export const EventPattern = {
  UserRegistered: 'user.registered',

  ProductPriceChanged: 'product.price_changed',
  ProductArchived: 'product.archived',

  StockReserved: 'inventory.reserved',
  StockReleased: 'inventory.released',

  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
} as const;

export type EventPatternValue =
  (typeof EventPattern)[keyof typeof EventPattern];

/**
 * Injection token for the RabbitMQ `ClientProxy`.
 *
 * A plain string, because that is what `ClientsModule.register({ name })`
 * takes and what `@Inject()` looks up. Declared once here so three
 * publishing services cannot drift on the spelling.
 */
export const EVENTS_CLIENT = 'EVENTS_CLIENT';

/**
 * The queue every event goes to.
 *
 * ONE QUEUE, and it is worth being clear about why. Nest's RMQ transport is
 * QUEUE-centric: a publisher sends to a named queue and a consuming service
 * reads from it. That is the simple model, and it has a real limitation —
 * if a second service also wanted these events, the two would COMPETE for
 * messages rather than each receiving a copy.
 *
 * Exchanges and bindings are the answer to that, and they arrive when we
 * have a second consumer that needs them. Not before.
 */
export const EVENTS_QUEUE = 'ecommerce_events';

// ─────────────────────────── payloads ───────────────────────────
//
// Just the data. No envelope, no eventId, no version field.
//
// A production system needs those — an id for idempotency, a correlation id
// for tracing, a version for schema evolution. They are deliberately absent
// for now, because every one of them exists to solve a problem we have not
// met yet. They arrive when the lesson calls for them.

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  firstName: string;
}

export interface ProductPriceChangedPayload {
  productId: string;
  sku: string;
  /** Exact decimal strings. Never floats — money is never a JS number. */
  previousPrice: string;
  newPrice: string;
}

export interface ProductArchivedPayload {
  productId: string;
  sku: string;
}

export interface StockReservedPayload {
  productId: string;
  quantity: number;
  available: number;
}

export interface StockReleasedPayload {
  productId: string;
  quantity: number;
  available: number;
}

export interface OrderLinePayload {
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: string;
}

/**
 * An order was placed.
 *
 * `order.confirmed`, not `order.created`, because the two mean the same
 * thing today: there is no workflow that can leave an order half-made, so an
 * order exists only once it is CONFIRMED. If a checkout workflow arrives
 * later, `order.created` becomes a separate, earlier fact — and consumers
 * that care about a FINISHED order keep listening to this one, unchanged.
 */
export interface OrderConfirmedPayload {
  orderId: string;
  orderNumber: string;
  userId: string;
  /**
   * The cart this order was built from.
   *
   * Carried in the message rather than looked up, so the consumer converts
   * exactly THIS cart and not "whatever is active now". Between publishing
   * and consuming, the customer may have started a new cart — and emptying
   * that one would take away a basket they are still filling.
   *
   * This is what eventual consistency actually costs: a consumer must be
   * written for the world as it is when the message ARRIVES, not as it was
   * when the message was sent.
   */
  cartId: string;
  total: string;
  currency: string;
  lines: OrderLinePayload[];
}

export interface OrderCancelledPayload {
  orderId: string;
  orderNumber: string;
  userId: string;
  reason: string;
}
