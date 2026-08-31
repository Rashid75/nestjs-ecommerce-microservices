import { StockMovementType } from '@ecommerce/contracts';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  InsufficientStockError,
  InventoryNotFoundError,
  InventoryRecord,
  InventoryRepository,
} from './inventory.repository';
import { InventoryService } from './inventory.service';

/**
 * Unit tests for InventoryService.
 *
 * WHAT THESE CAN AND CANNOT PROVE — worth being explicit, because it is easy
 * to mistake a green suite here for proof that overselling is impossible.
 *
 *   ✅ error translation: which domain failure becomes which status code
 *   ✅ that the service adds no read-modify-write of its own
 *   ✅ that the reference and sign reach the repository intact
 *
 *   ❌ that the reservation is actually atomic
 *
 * That last one cannot be tested here at all. A race needs real concurrent
 * connections contending over a real row; a mocked repository has no rows.
 * `tools/oversell-demo.mjs` is what proves it, end to end, against a running
 * database — and it is the only thing that can.
 */
type RepoFake = {
  create: jest.Mock;
  findByProductId: jest.Mock;
  findMovements: jest.Mock;
  receive: jest.Mock;
  reserve: jest.Mock;
  release: jest.Mock;
  fulfil: jest.Mock;
  adjust: jest.Mock;
};

const PRODUCT_ID = '55555555-5555-4555-8555-555555555555';

function makeRepo(): RepoFake {
  return {
    create: jest.fn(),
    findByProductId: jest.fn(),
    findMovements: jest.fn(),
    receive: jest.fn(),
    reserve: jest.fn(),
    release: jest.fn(),
    fulfil: jest.fn(),
    adjust: jest.fn(),
  };
}

function makeService(repo: RepoFake): InventoryService {
  return new InventoryService(repo as unknown as InventoryRepository);
}

function makeRecord(overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  const onHand = overrides.onHand ?? 10;
  const reserved = overrides.reserved ?? 2;
  return {
    id: '66666666-6666-4666-8666-666666666666',
    productId: PRODUCT_ID,
    sku: 'DEMO-1',
    onHand,
    reserved,
    available: onHand - reserved,
    updatedAt: new Date('2026-08-30T00:00:00Z'),
    ...overrides,
  };
}

describe('InventoryService', () => {
  describe('reserve', () => {
    it('reports available as onHand minus reserved, never a stored column', async () => {
      const repo = makeRepo();
      repo.reserve.mockResolvedValue(makeRecord({ onHand: 10, reserved: 4 }));

      const result = await makeService(repo).reserve(PRODUCT_ID, {
        quantity: 2,
      });

      expect(result.available).toBe(6);
      expect(result.onHand).toBe(10);
      expect(result.reserved).toBe(4);
    });

    it('passes the reference straight through to the ledger', async () => {
      const repo = makeRepo();
      repo.reserve.mockResolvedValue(makeRecord());

      await makeService(repo).reserve(PRODUCT_ID, {
        quantity: 3,
        reference: 'order:abc',
      });

      expect(repo.reserve).toHaveBeenCalledWith(PRODUCT_ID, 3, 'order:abc');
    });

    it('does NOT read the current stock before reserving', async () => {
      const repo = makeRepo();
      repo.reserve.mockResolvedValue(makeRecord());

      await makeService(repo).reserve(PRODUCT_ID, { quantity: 1 });

      // THE REGRESSION THIS GUARDS. A helpful-looking
      // "check availability first, then reserve" in the service would
      // reintroduce exactly the check-then-act race the repository's single
      // atomic statement exists to close — and it would still pass every
      // other test in this file.
      expect(repo.findByProductId).not.toHaveBeenCalled();
      expect(repo.reserve).toHaveBeenCalledTimes(1);
    });

    it('turns insufficient stock into 409, not 400', async () => {
      const repo = makeRepo();
      repo.reserve.mockRejectedValue(
        new InsufficientStockError(PRODUCT_ID, 5, 2),
      );

      const failure = await makeService(repo)
        .reserve(PRODUCT_ID, { quantity: 5 })
        .catch((error: unknown) => error);

      // 409, because the request was perfectly well formed — it failed on
      // current state. A client reading 409 knows a retry may work; a client
      // reading 400 knows it never will.
      expect(failure).toBeInstanceOf(ConflictException);
      const body = (failure as ConflictException).getResponse() as {
        requested: number;
        available: number;
      };
      expect(body.requested).toBe(5);
      expect(body.available).toBe(2);
    });

    it('turns an unknown product into 404', async () => {
      const repo = makeRepo();
      repo.reserve.mockRejectedValue(new InventoryNotFoundError(PRODUCT_ID));

      await expect(
        makeService(repo).reserve(PRODUCT_ID, { quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('release', () => {
    it('refuses to release more than is reserved', async () => {
      const repo = makeRepo();
      repo.release.mockRejectedValue(
        new InsufficientStockError(PRODUCT_ID, 9, 2),
      );

      // Without this guard a buggy caller could drive `reserved` negative and
      // silently invent available stock.
      await expect(
        makeService(repo).release(PRODUCT_ID, { quantity: 9 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('fulfil', () => {
    it('reduces BOTH counters — reserving alone never touches onHand', async () => {
      const repo = makeRepo();
      repo.fulfil.mockResolvedValue(makeRecord({ onHand: 8, reserved: 0 }));

      const result = await makeService(repo).fulfil(PRODUCT_ID, {
        quantity: 2,
        reference: 'order:abc',
      });

      // Until goods ship they are still physically on the shelf, so a
      // reservation must not decrement onHand. Fulfilment is the only
      // operation in the normal flow that does.
      expect(result.onHand).toBe(8);
      expect(result.reserved).toBe(0);
      expect(result.available).toBe(8);
    });
  });

  describe('adjust', () => {
    it('forwards a negative delta with its mandatory reason', async () => {
      const repo = makeRepo();
      repo.adjust.mockResolvedValue(makeRecord({ onHand: 8, reserved: 2 }));

      await makeService(repo).adjust(PRODUCT_ID, {
        delta: -2,
        reason: 'breakage',
      });

      expect(repo.adjust).toHaveBeenCalledWith(PRODUCT_ID, -2, 'breakage');
    });

    it('surfaces a rejected adjustment as 409', async () => {
      const repo = makeRepo();
      repo.adjust.mockRejectedValue(
        new InsufficientStockError(PRODUCT_ID, 20, 8),
      );

      // Writing off damaged goods must not invalidate promises already made
      // to customers, so an adjustment that would leave reserved > onHand is
      // refused at the database.
      await expect(
        makeService(repo).adjust(PRODUCT_ID, { delta: -20, reason: 'flood' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('history', () => {
    it('404s rather than returning an empty ledger for an unknown product', async () => {
      const repo = makeRepo();
      repo.findByProductId.mockResolvedValue(null);

      // An empty array would say "this product has no movements", which is a
      // different and misleading claim.
      await expect(
        makeService(repo).history(PRODUCT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns signed quantities and post-movement balances', async () => {
      const repo = makeRepo();
      repo.findByProductId.mockResolvedValue(makeRecord());
      repo.findMovements.mockResolvedValue([
        {
          id: 'm1',
          type: StockMovementType.Release,
          quantity: -3,
          reference: 'order:abc',
          onHandAfter: 10,
          reservedAfter: 2,
          createdAt: new Date('2026-08-30T00:00:00Z'),
        },
      ]);

      const [entry] = await makeService(repo).history(PRODUCT_ID);

      // Signed, so SUM(quantity) reconstructs the balance — which is what
      // makes reconciliation against a physical count possible.
      expect(entry.quantity).toBe(-3);
      expect(entry.type).toBe(StockMovementType.Release);
      expect(entry.onHandAfter).toBe(10);
    });
  });
});
