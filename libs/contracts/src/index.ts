/**
 * The public surface of `@ecommerce/contracts`.
 *
 * Everything a service may import from this library is listed here. Anything
 * not re-exported is private, so files can be moved without breaking
 * consumers.
 *
 * What belongs in here: the shape of messages that cross a service boundary —
 * request DTOs, response DTOs, event payloads, shared enums.
 *
 * What must never be in here: Sequelize models. A model is a service's
 * private persistence detail. Sharing one is how a microservice monorepo
 * quietly becomes a distributed monolith.
 */

// --- common ---
export * from './lib/common/pagination.dto';

// --- auth ---
export * from './lib/auth/user-role.enum';
export * from './lib/auth/register.dto';
export * from './lib/auth/login.dto';
export * from './lib/auth/auth-response.dto';

// --- catalog ---
export * from './lib/catalog/product-status.enum';
export * from './lib/catalog/category.dto';
export * from './lib/catalog/product.dto';
export * from './lib/catalog/query-products.dto';

// --- inventory ---
export * from './lib/inventory/inventory.dto';

// --- cart ---
export * from './lib/cart/cart.dto';

// --- events ---
export * from './lib/events/events';
