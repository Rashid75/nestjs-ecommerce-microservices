import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'ThinkPad X1 Carbon' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    example: 'LAP-X1C-14-2026',
    description: 'Stock Keeping Unit. Unique across live products.',
  })
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
  @ApiProperty({
    type: String,
    example: '1899.00',
    description: 'Exact decimal string. Do not parse as a float for money.',
  })
  price!: string;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code.' })
  currency!: string;

  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' })
  status!: ProductStatus;

  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiPropertyOptional({
    type: CategoryDto,
    description: 'Included only on single-product reads.',
  })
  category?: CategoryDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/** The paginated listing envelope, spelled out concretely for Swagger. */
export class PaginatedProductsDto {
  @ApiProperty({ type: [ProductDto] })
  items!: ProductDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}

export class CreateProductDto {
  @ApiProperty({ example: 'ThinkPad X1 Carbon', maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({
    example: 'LAP-X1C-14-2026',
    maxLength: 64,
    description: 'Uppercase letters, digits, hyphens and underscores.',
  })
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

  @ApiProperty({
    example: 1899.0,
    minimum: 0,
    maximum: MAX_PRICE,
    description: 'At most 2 decimal places. Stored as an exact decimal.',
  })
  @Type(() => Number)
  // maxDecimalPlaces is enforced here rather than left to the database,
  // which would silently ROUND 19.999 to 20.00. Silently changing a price
  // is worse than refusing it.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  price!: number;

  @ApiPropertyOptional({
    example: 'USD',
    default: 'USD',
    description: 'ISO 4217 code, three uppercase letters.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency?: string;

  @ApiPropertyOptional({
    enum: ProductStatus,
    enumName: 'ProductStatus',
    default: ProductStatus.Draft,
    description:
      'New products default to DRAFT so nothing goes live by accident.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  categoryId!: string;
}

/** Partial update. See the note on UpdateCategoryDto for why every field is optional. */
export class UpdateProductDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 64 })
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

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_PRICE })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  price?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency?: string;

  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;
}
