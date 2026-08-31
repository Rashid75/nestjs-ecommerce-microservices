import { UserProfileDto } from '@ecommerce/contracts';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AUTHENTICATED_USER } from './authenticated-user.guard';

/**
 * The user resolved by AuthenticatedUserGuard.
 *
 * Only meaningful on routes carrying `@UseGuards(AuthenticatedUserGuard)`.
 * Without the guard nothing populates it, which is why the return type is
 * honest about `undefined` rather than asserting a value that may not exist.
 */
export const AuthenticatedUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserProfileDto | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return (request as unknown as Record<symbol, UserProfileDto>)[
      AUTHENTICATED_USER
    ];
  },
);
