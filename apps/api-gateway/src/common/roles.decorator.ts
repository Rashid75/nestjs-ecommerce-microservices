import { UserRole } from '@ecommerce/contracts';
import { SetMetadata } from '@nestjs/common';

export const ROLES_METADATA_KEY = 'ecommerce:roles';

/**
 * Says which roles may reach a handler.
 *
 * ```ts
 * @UseGuards(AuthenticatedUserGuard, RolesGuard)
 * @Roles(UserRole.Admin)
 * @Post()
 * create() {}
 * ```
 *
 * ORDER OF GUARDS MATTERS AND IS NOT ALPHABETICAL. Nest runs them left to
 * right, and `RolesGuard` reads the user that `AuthenticatedUserGuard` put on
 * the request. Reversed, the roles guard sees no user on every request and
 * either crashes or — far worse, if it is written defensively — decides
 * "no user, no role requirement violated" and lets everyone through.
 *
 * WHY A DECORATOR AND NOT AN `if` IN THE HANDLER. Authorisation written
 * inside a method is invisible from the outside: you cannot audit it without
 * reading every method body, and a new endpoint is unprotected by DEFAULT —
 * the developer has to remember to add the check. As metadata it is legible
 * at a glance, greppable, and testable without invoking the handler.
 */
export const Roles = (...roles: UserRole[]) =>
  SetMetadata(ROLES_METADATA_KEY, roles);
