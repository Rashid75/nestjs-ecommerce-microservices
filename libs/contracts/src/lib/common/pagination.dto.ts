import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Offset pagination inputs, shared by every list endpoint.
 *
 * TWO STRATEGIES, AND WHY WE CHOSE THIS ONE
 *
 * OFFSET (this):  LIMIT 20 OFFSET 40
 *   + jump to any page, show "page 3 of 47", trivially combined with
 *     arbitrary sorting and filtering.
 *   - the database must still walk and discard every skipped row, so
 *     OFFSET 100000 reads 100,020 rows to return 20. Deep pages get slower
 *     and slower.
 *   - rows shift between requests. Insert a product while a user is on
 *     page 1 and one item slides onto page 2 unseen; delete one and an item
 *     is skipped entirely.
 *
 * KEYSET / CURSOR:  WHERE (created_at, id) < (:lastSeen) LIMIT 20
 *   + constant time at any depth, and stable under concurrent writes.
 *   - no page numbers, no jumping to page 47, and the cursor must encode
 *     every column you sort by.
 *
 * A product catalogue browsed by humans with a "page 3 of 47" control is
 * exactly where offset pagination belongs. Keyset is the right answer for
 * infinite scroll and for exports that walk the whole table — and that is
 * where we would introduce it, not before.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: '1-based page number.',
  })
  @IsOptional()
  // Query string values are always strings. Without this, `@IsInt()` sees
  // "2" and rejects it. `enableImplicitConversion` would do this globally,
  // but silently coercing "abc" to NaN is worse than an explicit annotation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Items per page. Capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // The cap is a real control, not decoration. Without it a client can ask
  // for limit=1000000 and turn a listing endpoint into a memory exhaustion
  // attack against your own database and process.
  @Max(100)
  limit = 20;
}

/**
 * The envelope every paginated response carries.
 *
 * Returning a bare array is the common shortcut and it is a mistake: the
 * client has no way to know whether more data exists, so it either guesses
 * from `length === limit` or paginates blindly. Adding the envelope later is
 * a breaking change for every consumer.
 */
export class PageMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 137, description: 'Total rows matching the filter.' })
  total!: number;
  @ApiProperty({ example: 7 }) totalPages!: number;
  @ApiProperty({ example: true }) hasNext!: boolean;
  @ApiProperty({ example: false }) hasPrevious!: boolean;
}

export function buildPageMeta(
  page: number,
  limit: number,
  total: number,
): PageMetaDto {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/** Sort direction, accepted case-insensitively and normalised to lowercase. */
export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}
