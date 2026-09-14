import { randomUUID } from 'node:crypto';

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

  PaymentSucceeded: 'payment.succeeded',
  PaymentFailed: 'payment.failed',
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
 * The topic EXCHANGE every event is published to.
 *
 * WHY THIS REPLACED A SINGLE QUEUE, IN MILESTONE 10. Through M7–M9 every
 * event went to one queue, `ecommerce_events`, and one service read it. That
 * was simple and it had a limitation written down at the time: RabbitMQ
 * delivers each message in a queue to exactly ONE consumer. A second
 * consuming service reading the same queue does not get a copy — it COMPETES
 * for messages, and roughly half of every event goes to the wrong service.
 *
 * The Notification Service is that second consumer. It needs
 * `order.confirmed`, and so does the Cart Service. There is no arrangement
 * of one queue that gives both of them the same message.
 *
 * So publishers now publish to a topic exchange, and every consuming service
 * declares its OWN queue bound to the routing keys it cares about. The
 * exchange copies each message into every queue whose binding matches:
 *
 *   publish "order.confirmed" ──► exchange ecommerce.events (topic)
 *                                    ├──► cart_service         (has a binding)
 *                                    ├──► notification_service (has a binding)
 *                                    └──► order_service        (no binding, no copy)
 *
 * NOTHING IN THE PUBLISHERS CHANGED except this configuration. That is the
 * point of an exchange: who listens is not the publisher's business, and
 * adding the fourth consumer will not touch them either.
 */
export const EVENTS_EXCHANGE = 'ecommerce.events';

/**
 * One durable queue per CONSUMING SERVICE.
 *
 * Not per event type, and not per instance. Two replicas of the Cart Service
 * share `cart_service` and therefore COMPETE for its messages — which is
 * exactly what you want for scaling out: each message is handled once, by
 * whichever replica is free. Competing consumers within a service is a
 * feature; competing consumers across services was the bug.
 *
 * The names are constants rather than configuration because a queue name
 * identifies WHO is consuming, which is a property of the code, not of the
 * environment it runs in.
 */
export const ServiceQueue = {
  Cart: 'cart_service',
  Order: 'order_service',
  Notification: 'notification_service',
} as const;

/**
 * What every event payload carries, on top of its own data.
 *
 * ONE FIELD, and it took until Milestone 10 to need it.
 *
 * RabbitMQ delivers AT LEAST ONCE. Every consumer in this system has always
 * had to survive being handed the same message twice, and until now every
 * one of them did it the cheap way — by being naturally repeatable.
 * `UPDATE carts SET status='CONVERTED' WHERE status='ACTIVE'` does nothing
 * the second time. `UPDATE orders SET status='PAID' WHERE status='CONFIRMED'`
 * does nothing the second time. Neither needs to know it has seen the
 * message before, so neither needs an id.
 *
 * SENDING AN EMAIL CANNOT BE MADE REPEATABLE. There is no WHERE clause that
 * un-sends one, and the customer simply receives two receipts. The only way
 * out is for the consumer to RECOGNISE the repeat — and to recognise it, the
 * message has to be identifiable.
 *
 * Which is why this is not an envelope. There is no `{ meta, data }`
 * wrapper, no version, no timestamp, no correlation id: each of those solves
 * a problem, and only this one has a problem today. The correlation id
 * arrives in M11 with tracing, and it will be worth its own field then.
 */
export interface EventMeta {
  /**
   * Unique per PUBLISHED event, not per delivery.
   *
   * That distinction is the whole mechanism. The broker may hand the same
   * message to a consumer any number of times, and every one of those
   * deliveries carries the SAME `eventId` — so a consumer that has recorded
   * the id knows it has already done the work, no matter how many copies
   * arrive.
   *
   * It is generated where the event is published, once. A consumer that
   * generated its own would be numbering deliveries, which is exactly the
   * thing it must not do.
   */
  eventId: string;
}

/**
 * A fresh event id.
 *
 * A v4 UUID: no coordination needed between the five publishing services,
 * and no chance of two of them minting the same one.
 */
export function newEventId(): string {
  return randomUUID();
}

// ─────────────────────────── payloads ───────────────────────────
//
// Just the data. No envelope, no eventId, no version field.
//
// A production system needs those — an id for idempotency, a correlation id
// for tracing, a version for schema evolution. They are deliberately absent
// for now, because every one of them exists to solve a problem we have not
// met yet. They arrive when the lesson calls for them.

export interface UserRegisteredPayload extends EventMeta {
  userId: string;
  email: string;
  firstName: string;
}

export interface ProductPriceChangedPayload extends EventMeta {
  productId: string;
  sku: string;
  /** Exact decimal strings. Never floats — money is never a JS number. */
  previousPrice: string;
  newPrice: string;
}

export interface ProductArchivedPayload extends EventMeta {
  productId: string;
  sku: string;
}

export interface StockReservedPayload extends EventMeta {
  productId: string;
  quantity: number;
  available: number;
}

export interface StockReleasedPayload extends EventMeta {
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
export interface OrderConfirmedPayload extends EventMeta {
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

export interface OrderCancelledPayload extends EventMeta {
  orderId: string;
  orderNumber: string;
  userId: string;
  reason: string;
}

/**
 * Money was taken for an order.
 *
 * The Order Service consumes this and moves the order to PAID. It does not
 * poll the Payment Service and the Payment Service does not write orders —
 * each owns its own database, so the only thing that crosses is a fact.
 */
export interface PaymentSucceededPayload extends EventMeta {
  paymentId: string;
  reference: string;
  orderId: string;
  userId: string;
  amount: string;
  currency: string;
  /** The provider's id for the charge, for reconciliation. */
  providerReference: string;
}

/**
 * An attempt to take money did not succeed.
 *
 * `retryable` is the field that matters. A DECLINED card will decline again;
 * a provider timeout might not. Anything reacting to this — a dunning email,
 * an alert, an automatic retry — needs to know which it was.
 */
export interface PaymentFailedPayload extends EventMeta {
  paymentId: string;
  reference: string;
  orderId: string;
  userId: string;
  amount: string;
  currency: string;
  failureCode: string;
  retryable: boolean;
}
