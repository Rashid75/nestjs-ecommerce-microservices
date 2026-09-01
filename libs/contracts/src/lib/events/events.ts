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
