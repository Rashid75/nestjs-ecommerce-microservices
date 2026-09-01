import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * A product category.
 *
 * Deliberately FLAT — no `parentId`, no tree.
 *
 * Nested categories are the obvious "real e-commerce" instinct and they are
 * genuinely expensive: recursive CTEs or a materialised path to query a
 * subtree, cycle prevention on every write, and "does this filter include
 * descendants?" appearing in every single product query. None of that earns
 * its place until there is a requirement for it.
 *
 * When that requirement arrives, the migration is additive — one nullable
 * `parent_id` column — which is exactly the shape of change we want to leave
 * available rather than pre-build.
 */
export class CategoryDto {
  id!: string;

  name!: string;

  slug!: string;

  description!: string | null;

  isActive!: boolean;

  createdAt!: Date;

  updatedAt!: Date;
}

export class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(140)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  // Anchored, and the character class excludes everything that would need
  // escaping in a URL. A slug is user-supplied text that ends up in a path
  // segment, so it gets the narrowest possible alphabet.
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

/**
 * Every field optional, because PATCH is a PARTIAL update.
 *
 * This is what separates PATCH from PUT and it is routinely got wrong. PUT
 * replaces the whole resource: fields you omit are cleared. PATCH changes
 * only what you send. Reusing a Create DTO for PATCH — or worse, applying
 * `{ ...existing, ...body }` where `body` came straight off the wire — is
 * how "I updated the price" quietly wipes the description.
 *
 * NestJS offers `PartialType(CreateCategoryDto)` to generate this. Written
 * out here so the contract is readable as plain TypeScript rather than as a
 * mapped type you have to compile in your head.
 */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain only lowercase letters, digits and single hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
