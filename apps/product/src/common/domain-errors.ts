/**
 * Errors the repository layer raises.
 *
 * These are DOMAIN errors, not HTTP errors. A repository knows that a unique
 * index was violated; it does not know — and must not decide — that this
 * means "409 Conflict". The same repository will one day be called from a
 * RabbitMQ consumer where status codes are meaningless.
 *
 * The service layer does the translation. That is the whole reason these
 * exist rather than throwing `ConflictException` two layers too early.
 */

/** A unique constraint rejected the write. */
export class DuplicateFieldError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`${field} already in use: ${value}`);
    this.name = 'DuplicateFieldError';
  }
}

/**
 * A foreign key pointed at a row that does not exist.
 *
 * We let the DATABASE discover this rather than doing a "does this category
 * exist?" SELECT first — the same reasoning as the duplicate-email case in
 * the Auth Service. A pre-check is a race: the category can be deleted
 * between the check and the insert, and only the constraint is atomic.
 */
export class RelatedRecordNotFoundError extends Error {
  constructor(readonly field: string) {
    super(`referenced record not found for ${field}`);
    this.name = 'RelatedRecordNotFoundError';
  }
}

/** The row exists but cannot be removed because something still points at it. */
export class RecordInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordInUseError';
  }
}
