import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRecord } from '../users/users.repository';

/**
 * Injects the authenticated user into a handler parameter.
 *
 *   getProfile(@CurrentUser() user: UserRecord) { ... }
 *
 * This reads exactly what JwtStrategy.validate() returned, which Passport
 * attached to `request.user`.
 *
 * Why bother instead of `@Req() req` and `req.user`?
 *
 *   - `req.user` is typed `Express.User`, an empty interface, so every handler
 *     would need a cast and the casts would drift out of sync.
 *   - The handler stops depending on Express. When a controller method is
 *     later reused behind a RabbitMQ consumer there is no `request` object,
 *     and a handler that only asked for a user keeps working.
 *
 * It is ONLY safe on routes behind JwtAuthGuard. Without the guard nothing
 * populates `request.user` and this returns undefined — which is why the
 * return type is honest about that.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserRecord | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return request.user as UserRecord | undefined;
  },
);
