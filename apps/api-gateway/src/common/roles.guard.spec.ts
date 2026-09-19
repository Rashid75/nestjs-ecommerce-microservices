import { UserProfileDto, UserRole } from '@ecommerce/contracts';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_USER } from './authenticated-user.guard';
import { RolesGuard } from './roles.guard';

/**
 * Tests for the authorisation decision.
 *
 * The two that matter are the last two: a customer must be refused, and a
 * guard that was wired up in the wrong order must FAIL CLOSED. The second is
 * the one that would otherwise ship — everything looks protected in the
 * source, and every request is allowed.
 */
function makeContext(
  user: UserProfileDto | undefined,
): ExecutionContext {
  const request: Record<string | symbol, unknown> = {
    method: 'POST',
    originalUrl: '/api/products',
  };
  if (user !== undefined) {
    request[AUTHENTICATED_USER] = user;
  }

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeReflector(roles: UserRole[] | undefined): Reflector {
  return {
    getAllAndOverride: () => roles,
  } as unknown as Reflector;
}

const admin: UserProfileDto = {
  id: 'a1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: UserRole.Admin,
  createdAt: new Date().toISOString(),
} as unknown as UserProfileDto;

const customer: UserProfileDto = {
  ...admin,
  id: 'c1',
  role: UserRole.Customer,
};

describe('RolesGuard', () => {
  it('allows a handler that declares no roles', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(makeContext(customer))).toBe(true);
  });

  it('allows a role that is listed', () => {
    const guard = new RolesGuard(makeReflector([UserRole.Admin]));
    expect(guard.canActivate(makeContext(admin))).toBe(true);
  });

  it('refuses a role that is not listed, with 403 and not 401', () => {
    const guard = new RolesGuard(makeReflector([UserRole.Admin]));

    // 403, because we know exactly who this is and the answer is still no.
    // A 401 here would send the client into a login loop it can never win.
    expect(() => guard.canActivate(makeContext(customer))).toThrow(
      ForbiddenException,
    );
  });

  it('fails CLOSED when no authenticated user is present', () => {
    const guard = new RolesGuard(makeReflector([UserRole.Admin]));

    // The wrong guard order, or this guard used alone. A defensive "no user,
    // so no role requirement was violated" would leave every endpoint that
    // LOOKS protected wide open.
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
