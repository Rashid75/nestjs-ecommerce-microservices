/**
 * The lifecycle of a product listing.
 *
 *   DRAFT     being prepared. Never shown to shoppers.
 *   ACTIVE    purchasable and listed.
 *   ARCHIVED  withdrawn from sale but kept, because orders, invoices and
 *             analytics still reference it. Archiving is what you actually
 *             want almost every time someone says "delete this product".
 *
 * Stored as VARCHAR with a CHECK constraint rather than a native PostgreSQL
 * ENUM — same reasoning as `users.role`. Adding a value to a native enum
 * means ALTER TYPE; renaming one means rebuilding every dependent column.
 * A CHECK constraint is dropped and recreated in one statement, and this
 * list will grow (OUT_OF_STOCK, DISCONTINUED).
 */
export enum ProductStatus {
  Draft = 'DRAFT',
  Active = 'ACTIVE',
  Archived = 'ARCHIVED',
}

/**
 * Columns a client is permitted to sort by.
 *
 * THIS IS A SECURITY CONTROL, not a convenience. A sort parameter is
 * interpolated into an ORDER BY clause, and ORDER BY cannot be
 * parameterised — you cannot write `ORDER BY $1`. So a naive
 * `order: [[req.query.sortBy, 'ASC']]` hands the caller a string that lands
 * directly in SQL.
 *
 * An allow-list of literal values is the only reliable defence. Everything
 * outside it is rejected by class-validator before the service ever sees it.
 */
export enum ProductSortField {
  Name = 'name',
  Price = 'price',
  CreatedAt = 'createdAt',
  UpdatedAt = 'updatedAt',
}
