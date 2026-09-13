import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { NotificationEventsController } from '../events/notification-events.controller';
import { MailerModule } from '../mailer/mailer.module';
import { Contact } from './contact.model';
import { Notification } from './notification.model';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Notifications and the contacts they are sent to.
 *
 * NO `ClientsModule` here: this service publishes nothing. It is the first
 * in the system that is purely a consumer, which is what you would expect of
 * something at the edge — it reacts to what happened and tells a human, and
 * nothing downstream reacts to it.
 */
@Module({
  imports: [SequelizeModule.forFeature([Contact, Notification]), MailerModule],
  // One HTTP controller and one message controller. Same class shape; only
  // the decorator on the handlers differs.
  controllers: [NotificationsController, NotificationEventsController],
  providers: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
