/**
 * The roles the system understands.
 *
 * Deliberately tiny. Roles are a public part of the contract — the token
 * carries one, the gateway will eventually route on one, and every service
 * has to agree on the spelling. A typo here is an authorisation bug, so the
 * string literals live in exactly one place.
 *
 * Role-based access control (RBAC) itself arrives later. For now the column
 * and the claim exist, and everything defaults to CUSTOMER.
 */
export enum UserRole {
  Customer = 'CUSTOMER',
  Admin = 'ADMIN',
}
