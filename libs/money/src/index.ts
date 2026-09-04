/**
 * The public surface of `@ecommerce/money`.
 *
 * Exact decimal arithmetic in integer minor units. It started as a file
 * inside the Cart Service in Milestone 6, and moved here in Milestone 8 when
 * the Order Service became the SECOND consumer — the same trigger rule that
 * created `libs/contracts` and `libs/redis`. One consumer is a guess at an
 * interface; two is evidence.
 *
 * Copying the four functions into the Order Service instead would have been
 * quicker and would have been the worst possible outcome: two implementations
 * of money arithmetic that can disagree about what a cart costs and what the
 * customer is charged.
 */
export * from './lib/money';
