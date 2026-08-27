import {
  ProductSortField,
  ProductStatus,
  QueryProductsDto,
  SortOrder,
} from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import {
  ForeignKeyConstraintError,
  Op,
  UniqueConstraintError,
  WhereOptions,
} from 'sequelize';
import { Category } from '../categories/category.model';
import {
  DuplicateFieldError,
  RelatedRecordNotFoundError,
} from '../common/domain-errors';
import { Product } from './product.model';

export interface ProductRecord {
  id: string;
  name: string;
  description: string | null;
  sku: string;
  price: string;
  currency: string;
  status: ProductStatus;
  categoryId: string;
  category?: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductInput {
  name: string;
  description?: string;
  sku: string;
  price: string;
  currency: string;
  status: ProductStatus;
  categoryId: string;
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface PageResult {
  rows: ProductRecord[];
  total: number;
}

/**
 * Maps the sort field a client may request onto a model attribute.
 *
 * The enum has already restricted the input to four literals, so this map is
 * belt and braces — but it is also the place where an API name and a column
 * name are allowed to diverge. Exposing raw column names in a public query
 * parameter couples your URL contract to your schema, and then a column
 * rename becomes a breaking API change.
 */
const SORT_COLUMN: Record<ProductSortField, keyof Product> = {
  [ProductSortField.Name]: 'name',
  [ProductSortField.Price]: 'price',
  [ProductSortField.CreatedAt]: 'createdAt',
  [ProductSortField.UpdatedAt]: 'updatedAt',
};

/**
 * The only place that queries `products`.
 *
 *   ProductsController → ProductsService → ProductsRepository
 *                      → Product model → PostgreSQL
 */
@Injectable()
export class ProductsRepository {
  constructor(@InjectModel(Product) private readonly model: typeof Product) {}

  async create(input: CreateProductInput): Promise<ProductRecord> {
    try {
      const created = await this.model.create({
        name: input.name,
        description: input.description ?? null,
        sku: input.sku,
        price: input.price,
        currency: input.currency,
        status: input.status,
        categoryId: input.categoryId,
      } as Product);

      // Re-read so the response carries the category, and so `price` comes
      // back in the exact form Postgres stores it ('1899.00', not '1899').
      const withCategory = await this.findById(created.id);
      return withCategory ?? toRecord(created);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Single product, with its category joined in.
   *
   * `include` turns what would be two queries into one JOIN. Without it,
   * reading `product.category` in the mapper below would trigger a second
   * round trip per product — the N+1 problem in miniature.
   */
  async findById(id: string): Promise<ProductRecord | null> {
    const found = await this.model.findByPk(id, {
      include: [{ model: Category, required: false }],
    });
    return found === null ? null : toRecord(found);
  }

  /**
   * The listing query: filter, sort, paginate — in one round trip for the
   * rows and one for the count.
   *
   * `findAndCountAll` issues both. The alternative, `findAll` plus a manual
   * `count`, is the same two queries with more code and an easy way to let
   * the two disagree by building the WHERE clause twice.
   */
  async findMany(query: QueryProductsDto): Promise<PageResult> {
    const where = buildWhere(query);

    const { rows, count } = await this.model.findAndCountAll({
      where,
      include: [{ model: Category, required: false }],
      order: [
        [
          SORT_COLUMN[query.sortBy],
          query.sortOrder === SortOrder.Asc ? 'ASC' : 'DESC',
        ],
        // A deterministic tiebreaker.
        //
        // Without it, two products with the same price have no defined
        // relative order, and PostgreSQL is free to return them differently
        // between calls. With offset pagination that means an item can
        // appear on both page 1 and page 2, or on neither. Any sort used for
        // pagination needs a unique final key.
        ['id', 'ASC'],
      ],
      limit: query.limit,
      offset: (query.page - 1) * query.limit,

      // Required whenever `include` is present.
      //
      // Without it Sequelize counts JOINED ROWS rather than distinct
      // products. With a belongsTo that happens to be the same number, but
      // add one hasMany include later and `total` silently becomes wrong —
      // and a wrong total means a wrong page count in every client.
      distinct: true,
    });

    return { rows: rows.map(toRecord), total: count };
  }

  async update(
    id: string,
    patch: UpdateProductInput,
  ): Promise<ProductRecord | null> {
    const found = await this.model.findByPk(id);
    if (found === null) {
      return null;
    }
    try {
      await found.update(patch);
      return await this.findById(id);
    } catch (error) {
      throw translate(error);
    }
  }

  /** Sets `deleted_at`. The row stays, so order history keeps resolving. */
  async softDelete(id: string): Promise<boolean> {
    const removed = await this.model.destroy({ where: { id } });
    return removed > 0;
  }

  /** Used before soft-deleting a category — see CategoriesService.remove(). */
  async countByCategory(categoryId: string): Promise<number> {
    return this.model.count({ where: { categoryId } });
  }
}

/**
 * Builds the WHERE clause from validated query parameters.
 *
 * Every value here arrived through `QueryProductsDto`, so it is already
 * typed and range-checked. Sequelize then sends each one as a BIND
 * PARAMETER — `WHERE price >= $1` — never as interpolated text. That is what
 * makes SQL injection structurally impossible on this path, and it is why
 * the one thing that cannot be parameterised (ORDER BY) needed an enum
 * instead.
 */
function buildWhere(query: QueryProductsDto): WhereOptions<Product> {
  const where: Record<string, unknown> = {};

  if (query.categoryId !== undefined) {
    where['categoryId'] = query.categoryId;
  }

  if (query.status !== undefined) {
    where['status'] = query.status;
  }

  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    const range: Record<symbol, number> = {};
    if (query.minPrice !== undefined) {
      range[Op.gte] = query.minPrice;
    }
    if (query.maxPrice !== undefined) {
      range[Op.lte] = query.maxPrice;
    }
    where['price'] = range;
  }

  if (query.search !== undefined && query.search !== '') {
    // iLike is PostgreSQL's case-insensitive LIKE. The leading `%` is what
    // makes this a substring search — and also what prevents any b-tree
    // index from being used, so this is a sequential scan. Fine for
    // thousands of rows; the fix at scale is a pg_trgm GIN index, noted in
    // the products migration.
    const term = `%${escapeLike(query.search)}%`;
    where[Op.or as unknown as string] = [
      { name: { [Op.iLike]: term } },
      { sku: { [Op.iLike]: term } },
    ];
  }

  return where as WhereOptions<Product>;
}

/**
 * Escapes LIKE wildcards in user input.
 *
 * Not a SQL injection defence — bind parameters already handle that. This
 * stops a search for "50%" from matching everything, and a search for "_"
 * from matching every single-character position. A user typing a literal
 * percent sign should get literal results.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toRecord(model: Product): ProductRecord {
  const record: ProductRecord = {
    id: model.id,
    name: model.name,
    description: model.description,
    sku: model.sku,
    // Already a string from the pg driver. `String()` guards the case where
    // a future config change makes pg parse NUMERIC into a float — the value
    // would still serialise, and the bug would surface as a wrong decimal
    // rather than a type error.
    price: String(model.price),
    currency: model.currency,
    status: model.status,
    categoryId: model.categoryId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };

  if (model.category) {
    record.category = {
      id: model.category.id,
      name: model.category.name,
      slug: model.category.slug,
      description: model.category.description,
      isActive: model.category.isActive,
      createdAt: model.category.createdAt,
      updatedAt: model.category.updatedAt,
    };
  }

  return record;
}

/** Database constraint violations → domain errors the service can map. */
function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintError) {
    return new DuplicateFieldError(
      String(error.errors[0]?.path ?? 'sku'),
      String(error.errors[0]?.value ?? ''),
    );
  }
  if (error instanceof ForeignKeyConstraintError) {
    return new RelatedRecordNotFoundError('categoryId');
  }
  return error;
}
