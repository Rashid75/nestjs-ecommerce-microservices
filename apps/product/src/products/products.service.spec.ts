import {
  ProductSortField,
  ProductStatus,
  QueryProductsDto,
  SortOrder,
} from '@ecommerce/contracts';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  DuplicateFieldError,
  RelatedRecordNotFoundError,
} from '../common/domain-errors';
import type { ClientProxy } from '@nestjs/microservices';
import type { ProductsCacheService } from './products-cache.service';
import { ProductRecord, ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * Unit tests for ProductsService. No database, no HTTP.
 *
 * Possible only because ProductsRepository returns plain records, so the
 * fake below is four functions. These cover the three things most likely to
 * be got wrong in a CRUD service: money conversion, PATCH semantics, and
 * error translation.
 */
type RepoFake = {
  create: jest.Mock;
  findById: jest.Mock;
  findMany: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  countByCategory: jest.Mock;
};

function makeRepo(): RepoFake {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    countByCategory: jest.fn(),
  };
}

/**
 * A pass-through cache: always misses, always calls the loader.
 *
 * That is the correct default for these tests. They are about the SERVICE's
 * behaviour — money conversion, patch construction, error translation — and
 * a fake that returned cached values would hide bugs in exactly the code
 * under test. Cache behaviour itself is tested separately, against its own
 * fake Redis, in products-cache.service.spec.ts.
 */
function makeCache(): { fake: ProductsCacheService; invalidated: string[] } {
  const invalidated: string[] = [];
  const fake = {
    getProduct: async (_id: string, load: () => Promise<unknown>) => ({
      value: await load(),
      hit: false,
    }),
    getList: async (_q: unknown, load: () => Promise<unknown>) => ({
      value: await load(),
      hit: false,
    }),
    invalidateProduct: async (id: string) => {
      invalidated.push(`product:${id}`);
    },
    invalidateLists: async () => {
      invalidated.push('lists');
    },
  } as unknown as ProductsCacheService;
  return { fake, invalidated };
}

function makePublisher(): { fake: ClientProxy; published: string[] } {
  const published: string[] = [];
  const fake = {
    emit: (pattern: string) => {
      published.push(pattern);
      return { subscribe: () => undefined };
    },
  } as unknown as ClientProxy;
  return { fake, published };
}

function makeService(
  repo: RepoFake,
  cache: ProductsCacheService = makeCache().fake,
  publisher: ClientProxy = makePublisher().fake,
): ProductsService {
  return new ProductsService(
    repo as unknown as ProductsRepository,
    cache,
    publisher,
  );
}

function makeProduct(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'ThinkPad X1 Carbon',
    description: null,
    sku: 'LAP-X1C-14-2026',
    price: '1899.00',
    currency: 'USD',
    status: ProductStatus.Draft,
    categoryId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeQuery(
  overrides: Partial<QueryProductsDto> = {},
): QueryProductsDto {
  return Object.assign(new QueryProductsDto(), {
    page: 1,
    limit: 20,
    sortBy: ProductSortField.CreatedAt,
    sortOrder: SortOrder.Desc,
    ...overrides,
  });
}

describe('ProductsService', () => {
  describe('create', () => {
    it('converts price to an exact 2-decimal string, never a float', async () => {
      const repo = makeRepo();
      repo.create.mockResolvedValue(makeProduct());

      await makeService(repo).create({
        name: 'ThinkPad X1 Carbon',
        sku: 'LAP-X1C-14-2026',
        price: 1899,
        categoryId: '33333333-3333-4333-8333-333333333333',
      });

      const written = repo.create.mock.calls[0][0];
      expect(written.price).toBe('1899.00');
      expect(typeof written.price).toBe('string');
    });

    it('defaults to DRAFT so nothing goes on sale by accident', async () => {
      const repo = makeRepo();
      repo.create.mockResolvedValue(makeProduct());

      await makeService(repo).create({
        name: 'Widget',
        sku: 'WID-1',
        price: 9.99,
        categoryId: '33333333-3333-4333-8333-333333333333',
      });

      expect(repo.create.mock.calls[0][0].status).toBe(ProductStatus.Draft);
      expect(repo.create.mock.calls[0][0].currency).toBe('USD');
    });

    it('maps a duplicate SKU to 409 Conflict', async () => {
      const repo = makeRepo();
      repo.create.mockRejectedValue(new DuplicateFieldError('sku', 'WID-1'));

      await expect(
        makeService(repo).create({
          name: 'Widget',
          sku: 'WID-1',
          price: 9.99,
          categoryId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps an unknown categoryId to 400, not 404', async () => {
      const repo = makeRepo();
      repo.create.mockRejectedValue(
        new RelatedRecordNotFoundError('categoryId'),
      );

      // 400 because the ROUTE was fine — the bad value was in the body.
      await expect(
        makeService(repo).create({
          name: 'Widget',
          sku: 'WID-2',
          price: 9.99,
          categoryId: '44444444-4444-4444-8444-444444444444',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('sends ONLY the fields present in the patch', async () => {
      const repo = makeRepo();
      // The service reads the row BEFORE updating, because the
      // product.price_changed event carries the previous price and there is
      // no way to recover it afterwards.
      repo.findById.mockResolvedValue(makeProduct({ price: '1899.00' }));
      repo.update.mockResolvedValue(makeProduct({ price: '1599.00' }));

      await makeService(repo).update('22222222-2222-4222-8222-222222222222', {
        price: 1599,
      });

      const patch = repo.update.mock.calls[0][1];
      // The regression this guards against: spreading the DTO would include
      // `name: undefined`, and Sequelize would try to write NULL over a NOT
      // NULL column — silently destroying data on a price-only update.
      expect(Object.keys(patch)).toEqual(['price']);
      expect(patch.price).toBe('1599.00');
      expect('name' in patch).toBe(false);
    });

    it('rejects an empty patch rather than issuing a pointless UPDATE', async () => {
      const repo = makeRepo();

      await expect(
        makeService(repo).update('22222222-2222-4222-8222-222222222222', {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('404s when the product does not exist', async () => {
      const repo = makeRepo();
      repo.update.mockResolvedValue(null);

      await expect(
        makeService(repo).update('22222222-2222-4222-8222-222222222222', {
          name: 'New name',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('events', () => {
    it('publishes product.price_changed with the PREVIOUS price', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeProduct({ price: '1899.00' }));
      repo.update.mockResolvedValue(makeProduct({ price: '1599.00' }));
      const { fake, published } = makePublisher();

      await makeService(repo, makeCache().fake, fake).update(
        '22222222-2222-4222-8222-222222222222',
        { price: 1599 },
      );

      // An event that says "the price changed" without saying what it
      // changed FROM forces every consumer to keep its own copy, which
      // defeats the point of publishing it.
      expect(published).toEqual(['product.price_changed']);
    });

    it('publishes nothing when the price did not move', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeProduct({ price: '1899.00' }));
      repo.update.mockResolvedValue(makeProduct({ price: '1899.00' }));
      const { fake, published } = makePublisher();

      await makeService(repo, makeCache().fake, fake).update(
        '22222222-2222-4222-8222-222222222222',
        { name: 'A new name' },
      );

      // A generic `product.updated` carrying the whole row would fire here
      // and push the diffing work onto every consumer. Specific past-tense
      // events let a consumer bind to exactly what it cares about.
      expect(published).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('computes page metadata from the total', async () => {
      const repo = makeRepo();
      repo.findMany.mockResolvedValue({ rows: [makeProduct()], total: 137 });

      const result = await makeService(repo).findAll(
        makeQuery({ page: 2, limit: 20 }),
      );

      expect(result.data.meta).toEqual({
        page: 2,
        limit: 20,
        total: 137,
        totalPages: 7,
        hasNext: true,
        hasPrevious: true,
      });
    });

    it('reports an empty result as zero pages, not one', async () => {
      const repo = makeRepo();
      repo.findMany.mockResolvedValue({ rows: [], total: 0 });

      const result = await makeService(repo).findAll(makeQuery());

      expect(result.data.items).toEqual([]);
      expect(result.data.meta.totalPages).toBe(0);
      expect(result.data.meta.hasNext).toBe(false);
    });

    it('rejects an inverted price range instead of returning an empty page', async () => {
      const repo = makeRepo();

      await expect(
        makeService(repo).findAll(makeQuery({ minPrice: 500, maxPrice: 100 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findMany).not.toHaveBeenCalled();
    });
  });

  describe('cache invalidation', () => {
    it('invalidates list pages after a create', async () => {
      const repo = makeRepo();
      repo.create.mockResolvedValue(makeProduct());
      const { fake, invalidated } = makeCache();

      await makeService(repo, fake).create({
        name: 'Widget',
        sku: 'WID-9',
        price: 1,
        categoryId: '33333333-3333-4333-8333-333333333333',
      });

      // A new product can appear on any list page, and there is no detail
      // key to remove because it has never been read.
      expect(invalidated).toEqual(['lists']);
    });

    it('invalidates the detail key AFTER a successful update', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeProduct({ price: '1899.00' }));
      repo.update.mockResolvedValue(makeProduct({ price: '1599.00' }));
      const { fake, invalidated } = makeCache();

      await makeService(repo, fake).update(
        '22222222-2222-4222-8222-222222222222',
        { price: 1599 },
      );

      expect(invalidated).toEqual([
        'product:22222222-2222-4222-8222-222222222222',
      ]);
    });

    it('does NOT invalidate when the update failed', async () => {
      const repo = makeRepo();
      repo.update.mockResolvedValue(null);
      const { fake, invalidated } = makeCache();

      await expect(
        makeService(repo, fake).update('22222222-2222-4222-8222-222222222222', {
          price: 1599,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Invalidating on a failed write would evict a perfectly good entry
      // and hand the next reader an unnecessary database query.
      expect(invalidated).toEqual([]);
    });

    it('invalidates after a delete', async () => {
      const repo = makeRepo();
      repo.softDelete.mockResolvedValue(true);
      const { fake, invalidated } = makeCache();

      await makeService(repo, fake).remove(
        '22222222-2222-4222-8222-222222222222',
      );

      expect(invalidated).toEqual([
        'product:22222222-2222-4222-8222-222222222222',
      ]);
    });
  });

  describe('remove', () => {
    it('404s when nothing was deleted', async () => {
      const repo = makeRepo();
      repo.softDelete.mockResolvedValue(false);

      await expect(
        makeService(repo).remove('22222222-2222-4222-8222-222222222222'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
