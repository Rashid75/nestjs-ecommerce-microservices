import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto, SortOrder } from '../common/pagination.dto';
import { MAX_PRICE } from './product.dto';
import { ProductSortField, ProductStatus } from './product-status.enum';

/**
 * Everything `GET /products` accepts: pagination, filtering and sorting.
 *
 * The whole query surface lives in ONE validated class. The alternative —
 * reading `req.query.whatever` inside the service — means unvalidated,
 * untyped, undocumented strings reaching your query builder, which is how
 * both bad data and ORDER BY injection get in.
 *
 * Because `whitelist` and `forbidNonWhitelisted` are on, a client that sends
 * `?sortBy=password` or `?limit=99999999` or a misspelled `?catagoryId=`
 * gets a 400 naming the problem, rather than silently being ignored.
 */
export class QueryProductsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  maxPrice?: number;

  /**
   * An allow-list, and the reason it is an enum rather than a string.
   *
   * ORDER BY cannot be parameterised — there is no `ORDER BY $1` in SQL, so
   * whatever ends up here is concatenated into the statement. `@IsEnum`
   * guarantees the value is one of four literals we wrote ourselves, which
   * is the only defence that actually holds.
   */
  @IsOptional()
  @IsEnum(ProductSortField)
  sortBy: ProductSortField = ProductSortField.CreatedAt;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsEnum(SortOrder)
  sortOrder: SortOrder = SortOrder.Desc;
}
