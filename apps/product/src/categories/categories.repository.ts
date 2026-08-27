import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { DuplicateFieldError } from '../common/domain-errors';
import { Category } from './category.model';

/** Plain projection. See the note in users.repository.ts for why not a model. */
export interface CategoryRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCategoryInput {
  name: string;
  slug: string;
  description?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
}

/**
 * The only place that queries `categories`.
 *
 *   CategoriesController → CategoriesService → CategoriesRepository
 *                        → Category model → PostgreSQL
 */
@Injectable()
export class CategoriesRepository {
  constructor(@InjectModel(Category) private readonly model: typeof Category) {}

  async create(input: CreateCategoryInput): Promise<CategoryRecord> {
    try {
      const created = await this.model.create({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        isActive: true,
      } as Category);
      return toRecord(created);
    } catch (error) {
      throw translateUniqueError(error);
    }
  }

  /**
   * Categories are a small, bounded set — tens, not thousands — so this
   * returns all of them unpaginated on purpose.
   *
   * That is a decision with a shelf life. The moment a deployment has
   * hundreds of categories, or nesting arrives, this needs the same
   * pagination treatment as products. Unbounded list endpoints are fine
   * exactly while the bound is real and understood.
   */
  async findAll(includeInactive: boolean): Promise<CategoryRecord[]> {
    const rows = await this.model.findAll({
      where: includeInactive ? {} : { isActive: true },
      order: [['name', 'ASC']],
    });
    return rows.map(toRecord);
  }

  /** `paranoid: true` means this will not find a soft-deleted category. */
  async findById(id: string): Promise<CategoryRecord | null> {
    const found = await this.model.findByPk(id);
    return found === null ? null : toRecord(found);
  }

  async findBySlug(slug: string): Promise<CategoryRecord | null> {
    const found = await this.model.findOne({ where: { slug } });
    return found === null ? null : toRecord(found);
  }

  /**
   * Returns null when the row does not exist, so the service can turn that
   * into a 404 without a separate existence query.
   */
  async update(
    id: string,
    patch: UpdateCategoryInput,
  ): Promise<CategoryRecord | null> {
    const found = await this.model.findByPk(id);
    if (found === null) {
      return null;
    }

    try {
      // Assigning only the keys present in `patch` is what makes this a
      // PATCH. Spreading the DTO wholesale would write `undefined` over
      // columns the caller never mentioned.
      await found.update(patch);
      return toRecord(found);
    } catch (error) {
      throw translateUniqueError(error);
    }
  }

  /**
   * Soft delete — sets `deleted_at`, keeps the row.
   *
   * `destroy()` issues an UPDATE rather than a DELETE because the model is
   * paranoid. Note what that means for referential integrity: the products
   * table's `ON DELETE RESTRICT` protects against HARD deletes and does
   * nothing here, because no row is being removed. Checking that no product
   * still references the category is therefore the SERVICE's job — see
   * CategoriesService.remove().
   */
  async softDelete(id: string): Promise<boolean> {
    const removed = await this.model.destroy({ where: { id } });
    return removed > 0;
  }
}

function toRecord(model: Category): CategoryRecord {
  return {
    id: model.id,
    name: model.name,
    slug: model.slug,
    description: model.description,
    isActive: model.isActive,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

/**
 * Turns Sequelize's unique-violation error into a domain error that names
 * WHICH field collided.
 *
 * Two unique indexes exist on this table, so "duplicate" alone is not a
 * useful message — the client needs to know whether to change the name or
 * the slug.
 */
function translateUniqueError(error: unknown): unknown {
  if (error instanceof UniqueConstraintError) {
    const field = String(error.errors[0]?.path ?? 'field');
    const value = String(error.errors[0]?.value ?? '');
    return new DuplicateFieldError(field, value);
  }
  return error;
}
