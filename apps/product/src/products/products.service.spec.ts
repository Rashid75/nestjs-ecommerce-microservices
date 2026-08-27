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

function makeService(repo: RepoFake): ProductsService {
  return new ProductsService(repo as unknown as ProductsRepository);
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

  describe('findAll', () => {
    it('computes page metadata from the total', async () => {
      const repo = makeRepo();
      repo.findMany.mockResolvedValue({ rows: [makeProduct()], total: 137 });

      const result = await makeService(repo).findAll(
        makeQuery({ page: 2, limit: 20 }),
      );

      expect(result.meta).toEqual({
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

      expect(result.items).toEqual([]);
      expect(result.meta.totalPages).toBe(0);
      expect(result.meta.hasNext).toBe(false);
    });

    it('rejects an inverted price range instead of returning an empty page', async () => {
      const repo = makeRepo();

      await expect(
        makeService(repo).findAll(makeQuery({ minPrice: 500, maxPrice: 100 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findMany).not.toHaveBeenCalled();
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
