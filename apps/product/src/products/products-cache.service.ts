import { ProductDto, QueryProductsDto } from '@ecommerce/contracts';
import { CacheService } from '@ecommerce/redis';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { ProductEnv } from '../config/env.validation';

/**
 * A cached list page, as stored in Redis.
 *
 * Dates are serialised to strings by JSON.stringify and stay strings when
 * they come back. That is a real difference between a hit and a miss, and it
 * is why the type here is explicit rather than reusing PaginatedProductsDto:
 * pretending a string is a Date is exactly the kind of lie that produces
 * `createdAt.getTime is not a function` only on the cached path.
 *
 * The values still serialise to identical JSON on the way out, so clients
 * cannot tell the difference — which is the property that matters.
 */
export interface CachedPage {
  items: unknown[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

/**
 * Knows WHAT to cache and under WHICH key. `CacheService` in
 * `@ecommerce/redis` knows HOW.
 *
 * Keeping the two apart means the key scheme — the part that encodes real
 * decisions about invalidation — lives beside the domain it describes,
 * rather than in a shared library that would have to know about products.
 *
 * WHAT WE CACHE, AND WHAT WE DELIBERATELY DO NOT:
 *
 *   ✅ GET /products/:id   read constantly, changes rarely, tiny payload.
 *                          The textbook candidate.
 *   ✅ GET /products       expensive (filter + sort + count over a JOIN),
 *                          and the first page of the default query is what
 *                          almost everyone requests. Short TTL because it
 *                          reflects many rows.
 *   ❌ writes              no write-through. See the note in CacheService.
 *   ❌ categories          twenty rows, one indexed query, no JOIN. Caching
 *                          it would add an invalidation path and a staleness
 *                          window to save well under a millisecond. "Do not
 *                          cache everything" means exactly this: a cache is
 *                          not free, it is a correctness liability you take
 *                          on in exchange for load you can measure.
 */
@Injectable()
export class ProductsCacheService {
  private readonly logger = new Logger(ProductsCacheService.name);
  private readonly enabled: boolean;
  private readonly detailTtl: number;
  private readonly listTtl: number;

  /**
   * The generation counter for list keys. Incremented by every write; read
   * on every list request to build the key. See CacheService.bumpGeneration
   * for why this exists instead of `KEYS products:list:*` + DEL.
   */
  private static readonly LIST_GENERATION_KEY = 'listgen';

  constructor(
    private readonly cache: CacheService,
    config: ConfigService<ProductEnv, true>,
  ) {
    this.enabled = config.get('CACHE_ENABLED', { infer: true });
    this.detailTtl = config.get('CACHE_PRODUCT_TTL_SECONDS', { infer: true });
    this.listTtl = config.get('CACHE_LIST_TTL_SECONDS', { infer: true });

    if (!this.enabled) {
      this.logger.warn('cache is DISABLED — every read goes to PostgreSQL');
    }
  }

  /**
   * Cache-aside for a single product.
   *
   * `singleFlight` is on here and off for lists. A single product page can
   * be genuinely hot — one item in a marketing email, one SKU on a front
   * page — so the stampede risk is concentrated on one key. List keys are
   * spread across many query combinations, so no single one attracts enough
   * concurrent misses to matter, and the lock would cost more than it saves.
   */
  async getProduct(
    id: string,
    load: () => Promise<ProductDto | null>,
  ): Promise<{ value: ProductDto | null; hit: boolean }> {
    if (!this.enabled) {
      return { value: await load(), hit: false };
    }

    return this.cache.getOrSet<ProductDto>(
      detailKey(id),
      { ttlSeconds: this.detailTtl, singleFlight: true },
      load,
    );
  }

  /**
   * Cache-aside for a list page.
   *
   * The key embeds the current generation, so a single INCR on write makes
   * every previously cached page unreachable in O(1) — no scanning, no
   * enumerating which pages might have contained the changed product.
   */
  async getList(
    query: QueryProductsDto,
    load: () => Promise<CachedPage>,
  ): Promise<{ value: CachedPage; hit: boolean }> {
    if (!this.enabled) {
      return { value: await load(), hit: false };
    }

    const generation = await this.cache.getGeneration(
      ProductsCacheService.LIST_GENERATION_KEY,
    );

    const result = await this.cache.getOrSet<CachedPage>(
      listKey(generation, query),
      { ttlSeconds: this.listTtl },
      load,
    );

    // `load` never returns null for a list — an empty page is still a page —
    // so this is a type narrowing, not a real branch.
    return { value: result.value ?? (await load()), hit: result.hit };
  }

  /**
   * Called after every create, update and delete.
   *
   * Two separate actions, and the difference is worth pausing on:
   *
   *   DELETE the detail key   we know exactly which key is now wrong.
   *                           Targeted, O(1), no collateral damage.
   *
   *   BUMP the generation     we have no idea which cached LIST pages
   *                           contained this product, and the query space is
   *                           unbounded. So we invalidate all of them at
   *                           once by changing the namespace they live in.
   *
   * INVALIDATE, DO NOT UPDATE. It is tempting to write the new value into
   * the cache here instead of deleting it. Do not: two concurrent updates
   * can land in the cache in the opposite order to the database, leaving the
   * cache permanently showing the older price. Deleting means the next read
   * re-derives from the source of truth, and the worst case is one extra
   * query.
   */
  async invalidateProduct(id: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.cache.del(detailKey(id));
    await this.cache.bumpGeneration(ProductsCacheService.LIST_GENERATION_KEY);
  }

  /** For a create, where there is no existing detail key to remove. */
  async invalidateLists(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.cache.bumpGeneration(ProductsCacheService.LIST_GENERATION_KEY);
  }
}

function detailKey(id: string): string {
  return `detail:${id}`;
}

/**
 * Builds a stable key for one list query.
 *
 * Two properties are required, and both are easy to get wrong:
 *
 *   STABLE   `?limit=20&page=1` and `?page=1&limit=20` are the same query
 *            and must produce the same key. Serialising the DTO directly
 *            would depend on property order and produce two keys — halving
 *            the hit rate for no reason.
 *
 *   TOTAL    every parameter that changes the RESULT must be in the key. Miss
 *            one — say `status` — and a filtered request would be served the
 *            unfiltered page. That is not a slow response; it is a wrong one.
 *
 * Hashed rather than embedded verbatim so the key stays short and bounded
 * regardless of how long a `search` term is. SHA-1 is used because this is a
 * cache key, not a security boundary: a collision would serve the wrong page,
 * and at 2^80 that is not a risk worth spending a slower hash on.
 */
function listKey(generation: number, query: QueryProductsDto): string {
  const canonical = JSON.stringify([
    query.page,
    query.limit,
    query.search ?? '',
    query.categoryId ?? '',
    query.status ?? '',
    query.minPrice ?? '',
    query.maxPrice ?? '',
    query.sortBy,
    query.sortOrder,
  ]);

  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 16);
  return `list:${generation}:${hash}`;
}
