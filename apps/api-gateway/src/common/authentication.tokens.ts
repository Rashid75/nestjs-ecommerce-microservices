/**
 * Injection token for the axios instance pointed at the Auth Service.
 *
 * In its own file so the guard and the module that configures it can both
 * import it without a cycle.
 */
export const AUTH_HTTP_CLIENT = Symbol('AUTH_HTTP_CLIENT');
