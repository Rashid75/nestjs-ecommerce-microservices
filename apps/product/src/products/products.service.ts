import {
  buildPageMeta,
  CreateProductDto,
  PaginatedProductsDto,
  ProductDto,
  ProductStatus,
  QueryProductsDto,
  UpdateProductDto,
} from '@ecommerce/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DuplicateFieldError,
  RelatedRecordNotFoundError,
} from '../common/domain-errors';
import { CachedPage, ProductsCacheService } from './products-cache.service';
import {
  ProductRecord,
  ProductsRepository,
  UpdateProductInput,
} from './products.repository';

const DEFAULT_CURRENCY = 'USD';

/**
 * A result plus where it came from.
 *
 * The controller turns `cacheHit` into an `X-Cache: HIT|MISS` response
 * header — the same convention CDNs use. Without it a cache is invisible:
 * you cannot tell a hit from a miss, cannot demonstrate that invalidation
 * worked, and cannot tell whether a stale response came from Redis or from a
 * bug. Making the cache observable is not a nicety; it is the difference
 * between a cache you can operate and one you can only hope about.
 */
export interface Cacheable<T> {
  data: T;
  cacheHit: boolean;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly products: ProductsRepository,
    private readonly cache: ProductsCacheService,
  ) {}

  async create(dto: CreateProductDto): Promise<ProductDto> {
    try {
      const created = await this.products.create({
        name: dto.name,
        description: dto.description,
        sku: dto.sku,
        price: toDecimalString(dto.price),
        currency: dto.currency ?? DEFAULT_CURRENCY,
        // DRAFT unless the caller says otherwise, so an incomplete import
        // cannot put items on sale.
        status: dto.status ?? ProductStatus.Draft,
        categoryId: dto.categoryId,
      });
      // A new product can appear in any list page matching any filter, so
      // every cached list is now potentially wrong. There is no detail key
      // to delete — the product has never been read.
      await this.cache.invalidateLists();

      this.logger.log(`created product ${created.id} (${created.sku})`);
      return toDto(created);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async findAll(
    query: QueryProductsDto,
  ): Promise<Cacheable<PaginatedProductsDto>> {
    // A cheap guard the DTO cannot express: two independently valid fields
    // that are invalid together. minPrice=500&maxPrice=100 would otherwise
    // return an empty page and look like "no results" rather than a mistake.
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException(
        'minPrice must be less than or equal to maxPrice',
      );
    }

    const { value, hit } = await this.cache.getList(query, async () => {
      const { rows, total } = await this.products.findMany(query);
      return {
        items: rows.map(toDto),
        meta: buildPageMeta(query.page, query.limit, total),
      } satisfies CachedPage;
    });

    return {
      data: value as PaginatedProductsDto,
      cacheHit: hit,
    };
  }

  /**
   * Cache-aside read.
   *
   * Note the ORDER: the cache is consulted, and only on a miss does the
   * loader run. The NotFoundException is thrown AFTER the cache layer
   * returns, not inside the loader — because a thrown exception would escape
   * `getOrSet` before it could store anything, and every 404 would keep
   * hitting PostgreSQL forever.
   *
   * Instead the loader returns `null`, that null is cached (NEGATIVE
   * CACHING), and the 404 is raised here. A scripted probe for random UUIDs
   * then costs one database query per id rather than one per request.
   */
  async findOne(id: string): Promise<Cacheable<ProductDto>> {
    const { value, hit } = await this.cache.getProduct(id, async () => {
      const found = await this.products.findById(id);
      return found === null ? null : toDto(found);
    });

    if (value === null) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    return { data: value, cacheHit: hit };
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDto> {
    // Build the patch from ONLY the keys the caller actually sent.
    //
    // `{ ...dto }` would look equivalent and is not: class-transformer
    // materialises every optional property as `undefined`, and passing
    // `{ name: undefined }` to Sequelize's update is a request to write NULL
    // over a NOT NULL column. This is the single most common way a PATCH
    // endpoint destroys data.
    const patch: UpdateProductInput = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.sku !== undefined) patch.sku = dto.sku;
    if (dto.price !== undefined) patch.price = toDecimalString(dto.price);
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.categoryId !== undefined) patch.categoryId = dto.categoryId;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    try {
      const updated = await this.products.update(id, patch);
      if (updated === null) {
        throw new NotFoundException(`Product ${id} not found`);
      }
      // AFTER the database write succeeded, never before.
      //
      // Invalidating first would open a window in which a concurrent read
      // repopulates the cache from the OLD row, and that stale value then
      // survives for a full TTL. Write, then invalidate.
      //
      // This is still not atomic: a crash between the two leaves a stale
      // entry until its TTL expires. The industrial answers are
      // transactional outbox or change-data-capture, both of which arrive
      // naturally once RabbitMQ exists (Milestone 7). A bounded TTL is the
      // cheap backstop until then — which is the real reason every cached
      // key has one.
      await this.cache.invalidateProduct(id);

      this.logger.log(`updated product ${id}`);
      return toDto(updated);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Soft delete.
   *
   * Worth being explicit about what "delete a product" should usually mean:
   * setting `status` to ARCHIVED, not this. Archiving keeps the item
   * listable in an admin UI and searchable in reports. Deletion — even soft
   * deletion — hides it everywhere.
   *
   * Neither one removes the row, because order history will reference it.
   */
  async remove(id: string): Promise<void> {
    const removed = await this.products.softDelete(id);
    if (!removed) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    await this.cache.invalidateProduct(id);

    this.logger.log(`soft-deleted product ${id}`);
  }

  private translate(error: unknown): unknown {
    if (error instanceof DuplicateFieldError) {
      return new ConflictException(
        `A product with this ${error.field} already exists`,
      );
    }
    if (error instanceof RelatedRecordNotFoundError) {
      // 400, not 404. The PRODUCT route resolved fine; the problem is a
      // value inside the request body. A 404 here would suggest the URL was
      // wrong, which it was not.
      return new BadRequestException(
        'categoryId does not reference an existing category',
      );
    }
    return error;
  }
}

/**
 * Number in, exact decimal string out.
 *
 * `toFixed(2)` is safe for the range we allow because the DTO already
 * rejects anything with more than 2 decimal places and anything above
 * DECIMAL(12,2)'s ceiling. Sequelize then hands the string to the pg driver,
 * which passes it to PostgreSQL as NUMERIC — the value never round-trips
 * through a float on its way into the database.
 */
function toDecimalString(price: number): string {
  return price.toFixed(2);
}

function toDto(record: ProductRecord): ProductDto {
  const dto: ProductDto = {
    id: record.id,
    name: record.name,
    description: record.description,
    sku: record.sku,
    price: record.price,
    currency: record.currency,
    status: record.status,
    categoryId: record.categoryId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.category) {
    dto.category = record.category;
  }
  return dto;
}
