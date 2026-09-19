import { UserProfileDto, UserRole } from '@ecommerce/contracts';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUTHENTICATED_USER } from './authenticated-user.guard';
import { ROLES_METADATA_KEY } from './roles.decorator';

/**
 * Enforces `@Roles(...)`.
 *
 * TWO STATUS CODES THAT ARE CONSTANTLY CONFUSED:
 *
 *   401 Unauthorized  "I do not know who you are." Sent by
 *                     AuthenticatedUserGuard. The fix is to authenticate.
 *   403 Forbidden     "I know exactly who you are, and the answer is no."
 *                     Sent here. Authenticating again will not help.
 *
 * Returning 401 for an authorisation failure sends clients into a login loop;
 * returning 403 for a missing token hides the fact that a credential was
 * never presented.
 *
 * WHICH ROLE IS AUTHORITATIVE — the interesting decision in this file.
 *
 * The access token carries a `role` claim, and reading it would be free. It
 * is deliberately NOT used. The claim was true when the token was minted and
 * the token lives 15 minutes, so an admin demoted a minute ago still carries
 * a token that says ADMIN. The introspected profile comes from the Auth
 * Service's database, cached at most 30 seconds.
 *
 * So: a privilege GRANT is at most 30 seconds late, and a privilege
 * REVOCATION takes effect within 30 seconds rather than 15 minutes. For the
 * endpoints this guard protects — creating products, inventing stock — that
 * difference is the whole reason to pay for the lookup.
 *
 * The general rule worth taking away: a token is an assertion about the past.
 * Use it to establish WHO is asking; check anything that can change against
 * the system of record.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_METADATA_KEY,
      // Handler first, then class: a method-level `@Roles` OVERRIDES the
      // controller's, so one endpoint can be stricter than its siblings
      // without splitting the controller.
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined || required.length === 0) {
      // No requirement declared. This guard is not the one that decides
      // whether a caller is authenticated — that already happened.
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as unknown as Record<symbol, unknown>)[
      AUTHENTICATED_USER
    ] as UserProfileDto | undefined;

    if (user === undefined) {
      // The guards were wired in the wrong order, or this one was used
      // alone. FAIL CLOSED and say so loudly in the log — the alternative
      // is an endpoint that looks protected in the source and is not.
      this.logger.error(
        'RolesGuard ran without an authenticated user — is AuthenticatedUserGuard listed before it?',
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    if (!required.includes(user.role)) {
      // WORTH LOGGING, unlike a routine 401. A customer account attempting
      // an admin endpoint is either a bug in a client or someone probing,
      // and both are things you want to be able to find later. The user id
      // goes in; the email does not.
      this.logger.warn(
        `forbidden: user ${user.id} (${user.role}) attempted ${request.method} ${request.originalUrl}`,
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
