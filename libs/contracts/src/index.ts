/**
 * The public surface of `@ecommerce/contracts`.
 *
 * Everything a service is allowed to import from this library is listed here.
 * Anything not re-exported is private to the library, which means we can move
 * files around without breaking consumers.
 */
export * from './lib/auth/user-role.enum';
export * from './lib/auth/register.dto';
export * from './lib/auth/login.dto';
export * from './lib/auth/auth-response.dto';
