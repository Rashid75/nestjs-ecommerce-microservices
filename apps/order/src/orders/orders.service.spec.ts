import { CartDto, EventPattern, OrderStatus } from '@ecommerce/contracts';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import type { CartClientService } from '../cart/cart-client.service';
import type { OrderRecord, OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Unit tests for the checkout flow.
 *
 * WHAT THESE PROVE, AND WHAT THEY CANNOT.
 *
 *   ✅ that the totals are computed here, exactly, from the cart's lines
 *   ✅ that an empty cart is refused before anything is written
 *   ✅ that a client-supplied price cannot reach the order
 *   ✅ which failure becomes which HTTP status
 *   ✅ that an event is emitted only when the write actually succeeded
 *
 *   ❌ that the order and its lines are written atomically — that is
 *      PostgreSQL's guarantee, and a mocked repository has no transaction
 *   ❌ anything about concurrency. Two customers ordering the last unit is
 *      not tested because nothing here prevents it yet, deliberately.
 */
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CART_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';

function makeCart(overrides: Partial<CartDto> = {}): CartDto {
  return {
    id: CART_ID,
    userId: USER_ID,
    items: [
      {
        id: 'line-1',
        productId: PRODUCT_ID,
        sku: 'SKU-1',
        name: 'A thing',
        unitPrice: '16.08',
        quantity: 3,
        lineTotal: '48.24',
        addedAt: new Date(),
      },
    ],
    itemCount: 1,
    totalQuantity: 3,
    subtotal: '48.24',
    currency: 'USD',
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeOrderRecord(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-00000001',
    userId: USER_ID,
    cartId: CART_ID,
    status: OrderStatus.Confirmed,
    currency: 'USD',
    subtotal: '48.24',
    total: '48.24',
    cancelReason: null,
    items: [
      {
        id: 'item-1',
        productId: PRODUCT_ID,
        sku: 'SKU-1',
        name: 'A thing',
        unitPrice: '16.08',
        quantity: 3,
        lineTotal: '48.24',
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

type RepoFake = {
  create: jest.Mock;
  findOne: jest.Mock;
  list: jest.Mock;
  cancel: jest.Mock;
};

function build(cart: CartDto = makeCart()) {
  const repo: RepoFake = {
    create: jest.fn().mockResolvedValue(makeOrderRecord()),
    findOne: jest.fn().mockResolvedValue(makeOrderRecord()),
    list: jest.fn().mockResolvedValue({ rows: [makeOrderRecord()], total: 1 }),
    cancel: jest.fn().mockResolvedValue(true),
  };

  const carts = { fetchActiveCart: jest.fn().mockResolvedValue(cart) };

  // `emit` returns an Observable in real life. The service does not
  // subscribe to it — an event is fire and forget — so a plain object is
  // faithful enough here. What matters is WHICH pattern was emitted, with
  // what payload, and WHETHER it was emitted at all.
  const events = { emit: jest.fn().mockReturnValue({}) };

  const service = new OrdersService(
    repo as unknown as OrdersRepository,
    carts as unknown as CartClientService,
    events as unknown as ClientProxy,
  );

  return { service, repo, carts, events };
}

describe('OrdersService.create', () => {
  it('builds an order from the cart and returns it CONFIRMED', async () => {
    const { service, repo, carts } = build();

    const order = await service.create(USER_ID);

    expect(carts.fetchActiveCart).toHaveBeenCalledWith(USER_ID);
    expect(order.status).toBe(OrderStatus.Confirmed);
    expect(order.orderNumber).toMatch(/^ORD-\d{8}$/);

    const [input] = repo.create.mock.calls[0];
    // The cart is recorded, so "why does this order say three?" is
    // answerable months later.
    expect(input.cartId).toBe(CART_ID);
    expect(input.userId).toBe(USER_ID);
  });

  it('announces the order, carrying the cart it came from', async () => {
    const { service, events } = build();

    await service.create(USER_ID);

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [pattern, payload] = events.emit.mock.calls[0];
    expect(pattern).toBe(EventPattern.OrderConfirmed);
    // The consumer converts THIS cart, not "whatever is active on arrival".
    expect(payload).toMatchObject({ orderId: ORDER_ID, cartId: CART_ID });
    expect(payload.lines[0]).toMatchObject({ sku: 'SKU-1', quantity: 3 });
  });

  it('computes exact totals — 16.08 × 3 is 48.24, not 48.239999999999995', async () => {
    const { service, repo } = build();

    await service.create(USER_ID);

    const [input] = repo.create.mock.calls[0];
    expect(input.lines[0].lineTotal).toBe('48.24');
    expect(input.subtotal).toBe('48.24');
    expect(input.total).toBe('48.24');
  });

  it('takes prices from the cart, never from the caller', async () => {
    const { service, repo } = build();

    await service.create(USER_ID);

    const [input] = repo.create.mock.calls[0];
    // `create(userId)` takes no price argument at all — the type system is
    // what enforces this, and the assertion documents why.
    expect(input.lines[0].unitPrice).toBe('16.08');
    expect(input.currency).toBe('USD');
  });

  it('refuses an empty cart before writing anything', async () => {
    const { service, repo } = build(makeCart({ items: [] }));

    await expect(service.create(USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // A validation failure before the first write is a clean rejection with
    // nothing to clean up — and nothing announced. An event for an order
    // that was never created is a lie consumers would act on.
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('sums several lines', async () => {
    const cart = makeCart();
    cart.items.push({
      id: 'line-2',
      productId: '55555555-5555-4555-8555-555555555555',
      sku: 'SKU-2',
      name: 'Another thing',
      unitPrice: '0.07',
      quantity: 99,
      lineTotal: '6.93',
      addedAt: new Date(),
    });

    const { service, repo } = build(cart);
    await service.create(USER_ID);

    const [input] = repo.create.mock.calls[0];
    // 48.24 + 6.93. Through floats, 0.07 × 99 is 6.930000000000001.
    expect(input.subtotal).toBe('55.17');
  });
});

describe('OrdersService.findOne', () => {
  it('404s for an order that is not yours', async () => {
    const { service, repo } = build();
    // The repository scopes by user, so someone else's order simply is not
    // found. 404 rather than 403: a 403 would confirm the order exists.
    repo.findOne.mockResolvedValue(null);

    await expect(service.findOne(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('OrdersService.cancel', () => {
  it('cancels a confirmed order and keeps the reason', async () => {
    const { service, repo } = build();
    repo.findOne.mockResolvedValueOnce(makeOrderRecord()).mockResolvedValueOnce(
      makeOrderRecord({
        status: OrderStatus.Cancelled,
        cancelReason: 'changed my mind',
      }),
    );

    const order = await service.cancel(USER_ID, ORDER_ID, {
      reason: 'changed my mind',
    });

    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(order.cancelReason).toBe('changed my mind');

    const [, , reason, allowedFrom] = repo.cancel.mock.calls[0];
    expect(reason).toBe('changed my mind');
    // Compare-and-set: the legal source states go to the database, not into
    // an `if` up here.
    expect(allowedFrom).toEqual([OrderStatus.Confirmed]);
  });

  it('announces the cancellation', async () => {
    const { service, repo, events } = build();
    repo.findOne.mockResolvedValue(makeOrderRecord());

    await service.cancel(USER_ID, ORDER_ID, { reason: 'too slow' });

    const [pattern, payload] = events.emit.mock.calls[0];
    expect(pattern).toBe(EventPattern.OrderCancelled);
    expect(payload).toMatchObject({ orderId: ORDER_ID, reason: 'too slow' });
  });

  it('409s when the order was not in a cancellable state', async () => {
    const { service, repo } = build();
    repo.findOne.mockResolvedValue(
      makeOrderRecord({ status: OrderStatus.Shipped }),
    );
    // The UPDATE matched no rows, which is how the database reports "that
    // transition is not allowed".
    repo.cancel.mockResolvedValue(false);

    await expect(service.cancel(USER_ID, ORDER_ID, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('says nothing when the cancellation did not happen', async () => {
    const { service, repo, events } = build();
    repo.findOne.mockResolvedValue(makeOrderRecord());
    repo.cancel.mockResolvedValue(false);

    await expect(service.cancel(USER_ID, ORDER_ID, {})).rejects.toThrow();

    // THE ASSERTION THAT MATTERS. An `order.cancelled` event for an order
    // that is still confirmed would have consumers undoing work that was
    // never undone.
    expect(events.emit).not.toHaveBeenCalled();
  });
});
