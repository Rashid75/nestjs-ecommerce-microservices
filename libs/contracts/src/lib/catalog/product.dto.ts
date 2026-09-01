import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CategoryDto } from './category.dto';
import { ProductStatus } from './product-status.enum';
import { PageMetaDto } from '../common/pagination.dto';

/**
 * Largest price the API accepts. Matches DECIMAL(12,2) in the database:
 * 10 digits before the decimal point, 2 after.
 */
export const MAX_PRICE = 9_999_999_999.99;

export class ProductDto {
  id!: string;

  name!: string;

  description!: string | null;

  sku!: string;

  /**
   * Returned as a STRING, not a number, and that is deliberate.
   *
   * The column is DECIMAL(12,2) — exact base-10 arithmetic. JavaScript
   * numbers are IEEE-754 binary doubles, where 19.99 is not representable
   * and 0.1 + 0.2 === 0.30000000000000004. Serialising money through a JSON
   * number invites the client to do arithmetic in a type that cannot hold
   * the value exactly, and rounding errors in a cart total are the kind of
   * bug that reaches an accountant before it reaches an engineer.
   *
   * The stricter alternative, used by Stripe and most payment providers, is
   * INTEGER MINOR UNITS — store and transmit 1999, never 19.99, so every
   * value is exact in any language. It also forces the client to know the
   * currency's scale (JPY has none, KWD has three), which is a real cost.
   *
   * We revisit this at the Payment Service, where the arithmetic actually
   * matters. For a catalogue that displays a price, an exact decimal string
   * is honest and enough.
   */
  price!: string;

  currency!: string;

  status!: ProductStatus;

  categoryId!: string;

  category?: CategoryDto;

  createdAt!: Date;

  updatedAt!: Date;
}

/** The paginated listing envelope returned by `GET /products`. */
export class PaginatedProductsDto {
  items!: ProductDto[];

  meta!: PageMetaDto;
}

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  // Normalised to uppercase on the way in, and a CHECK constraint enforces
  // the same in the database. Without both, 'lap-1' and 'LAP-1' become two
  // products that a warehouse would treat as one item.
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message:
      'sku must contain only uppercase letters, digits, hyphens and underscores',
  })
  sku!: string;

  @Type(() => Number)
  // maxDecimalPlaces is enforced here rather than left to the database,
  // which would silently ROUND 19.999 to 20.00. Silently changing a price
  // is worse than refusing it.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  price!: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsUUID('4')
  categoryId!: string;
}

/** Partial update. See the note on UpdateCategoryDto for why every field is optional. */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message:
      'sku must contain only uppercase letters, digits, hyphens and underscores',
  })
  sku?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  price?: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;
}
