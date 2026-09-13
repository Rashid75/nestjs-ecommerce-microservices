import { QueryNotificationsDto, UserProfileDto } from '@ecommerce/contracts';
import {
  Controller,
  Get,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../common/authenticated-user.decorator';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import {
  NotificationListResponse,
  NotificationsProxyService,
} from './notifications-proxy.service';

/**
 * The public notification API — one route, read only.
 *
 * Guarded, because a notification carries an email address and a subject
 * line that says what somebody bought.
 */
@UseGuards(AuthenticatedUserGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsProxyService) {}

  @Get()
  list(
    @Query() query: QueryNotificationsDto,
    @AuthenticatedUser() user?: UserProfileDto,
  ): Promise<NotificationListResponse> {
    return this.notifications.list(requireUser(user).id, { ...query });
  }
}

/** Unreachable while the guard is in place — see the note in the cart's. */
function requireUser(user: UserProfileDto | undefined): UserProfileDto {
  if (user === undefined) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}
