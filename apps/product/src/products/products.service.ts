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
import {
  ProductRecord,
  ProductsRepository,
  UpdateProductInput,
} from './products.repository';

const DEFAULT_CURRENCY = 'USD';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly products: ProductsRepository) {}

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
      this.logger.log(`created product ${created.id} (${created.sku})`);
      return toDto(created);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async findAll(query: QueryProductsDto): Promise<PaginatedProductsDto> {
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

    const { rows, total } = await this.products.findMany(query);

    return {
      items: rows.map(toDto),
      meta: buildPageMeta(query.page, query.limit, total),
    };
  }

  async findOne(id: string): Promise<ProductDto> {
    const found = await this.products.findById(id);
    if (found === null) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return toDto(found);
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
