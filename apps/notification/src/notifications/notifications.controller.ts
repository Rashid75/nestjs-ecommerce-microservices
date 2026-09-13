import {
  NotificationDto,
  PageMetaDto,
  QueryNotificationsDto,
} from '@ecommerce/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUserId } from './current-user.decorator';
import { NotificationsService } from './notifications.service';

/**
 * REST for notifications — READ ONLY.
 *
 * There is no `POST /notifications`, and that is the milestone's whole
 * argument. Nobody asks this service to send an email; it decides for itself
 * what an event implies. An endpoint here would be an invitation for a
 * business service to go back to issuing instructions, which is exactly the
 * coupling this service exists to remove.
 *
 * What the read is FOR: a customer's own "message history", and — far more
 * often — answering "did they actually get the receipt?" without reading
 * application logs.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUserId() userId: string,
    @Query() query: QueryNotificationsDto,
  ): Promise<{ data: NotificationDto[]; meta: PageMetaDto }> {
    return this.notifications.list(userId, query);
  }
}
