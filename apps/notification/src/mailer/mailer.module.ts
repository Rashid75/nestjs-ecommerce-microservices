import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service';

/**
 * The mail transport, on its own so the seam is visible.
 *
 * Everything above it depends on `MailerService.send()` returning a result —
 * not on Nodemailer, not on SMTP, not on MailHog. Swapping in a provider's
 * HTTP API (SendGrid, SES) is a change to one file.
 */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
