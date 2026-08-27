import {
  CategoryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from '@ecommerce/contracts';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DuplicateFieldError } from '../common/domain-errors';
import { ProductsRepository } from '../products/products.repository';
import { CategoriesRepository, CategoryRecord } from './categories.repository';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    private readonly categories: CategoriesRepository,
    // Injected purely for the reference check in remove(). The dependency
    // points one way — categories knows about products, products does not
    // know about categories' service — so there is no cycle.
    private readonly products: ProductsRepository,
  ) {}

  async create(dto: CreateCategoryDto): Promise<CategoryDto> {
    try {
      const created = await this.categories.create(dto);
      this.logger.log(`created category ${created.id}`);
      return toDto(created);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async findAll(includeInactive: boolean): Promise<CategoryDto[]> {
    const rows = await this.categories.findAll(includeInactive);
    return rows.map(toDto);
  }

  async findOne(id: string): Promise<CategoryDto> {
    const found = await this.categories.findById(id);
    if (found === null) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    return toDto(found);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryDto> {
    try {
      const updated = await this.categories.update(id, dto);
      if (updated === null) {
        throw new NotFoundException(`Category ${id} not found`);
      }
      return toDto(updated);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Soft-deletes a category, but only if nothing points at it.
   *
   * The products table declares `ON DELETE RESTRICT`, which would make
   * PostgreSQL refuse a hard delete. It does NOT protect us here, because a
   * soft delete is an UPDATE — no row is removed, so no foreign key is
   * violated, and the category would quietly vanish from listings while its
   * products still referenced it.
   *
   * So the check is explicit. This is the general shape of the trade-off:
   * soft deletes buy you recoverable history and cost you the database's
   * referential guarantees, which you then have to re-implement in the
   * application.
   */
  async remove(id: string): Promise<void> {
    const found = await this.categories.findById(id);
    if (found === null) {
      throw new NotFoundException(`Category ${id} not found`);
    }

    const productCount = await this.products.countByCategory(id);
    if (productCount > 0) {
      throw new ConflictException(
        `Category still has ${productCount} product(s). Move or archive them first.`,
      );
    }

    await this.categories.softDelete(id);
    this.logger.log(`soft-deleted category ${id}`);
  }

  /** Domain error → HTTP error. The only layer that knows about status codes. */
  private translate(error: unknown): unknown {
    if (error instanceof DuplicateFieldError) {
      return new ConflictException(
        `A category with this ${error.field} already exists`,
      );
    }
    return error;
  }
}

function toDto(record: CategoryRecord): CategoryDto {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
