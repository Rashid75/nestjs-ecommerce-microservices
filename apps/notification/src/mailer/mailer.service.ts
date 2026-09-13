import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { NotificationEnv } from '../config/env.validation';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What the transport says. Never throws — see the note below. */
export type SendResult =
  | { sent: true; detail: string }
  | { sent: false; reason: string };

/**
 * Sends the mail.
 *
 * TWO TRANSPORTS, chosen by configuration:
 *
 *   log   writes the email to the console and claims success. The default,
 *         so the whole system runs with nothing extra installed.
 *   smtp  Nodemailer to a real SMTP server — MailHog locally, which accepts
 *         everything and shows it in a web UI at :8025.
 *
 * WHY MAILHOG AND NOT A REAL PROVIDER. Because the alternative is sending
 * real email from a development machine, and the first time a test fixture
 * has a colleague's address in it, you have emailed them. MailHog accepts
 * every message and delivers none, which is exactly the behaviour you want
 * from a development mail server.
 *
 * IT NEVER THROWS. A failed send returns a value, because a notification
 * that could not be delivered is a normal outcome that must be RECORDED, not
 * an exception that unwinds the handler and makes RabbitMQ redeliver the
 * message — which would try the same broken address again, and again.
 */
@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: 'log' | 'smtp';
  private readonly from: string;
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<NotificationEnv, true>) {
    this.transport = config.get('MAIL_TRANSPORT', { infer: true });
    this.from = config.get('MAIL_FROM', { infer: true });
  }

  async onModuleDestroy(): Promise<void> {
    // Nodemailer keeps a connection pool open; without this, a Ctrl-C leaves
    // the process hanging on a socket to MailHog.
    this.transporter?.close();
    await Promise.resolve();
  }

  async send(email: Email): Promise<SendResult> {
    if (this.transport === 'log') {
      // Subject and recipient only. The BODY is not logged: an order
      // confirmation contains what somebody bought and what they paid, and
      // application logs are read by more people, and kept longer, than
      // anyone thinks about when they add a log line.
      this.logger.log(`[mail:log] to=${email.to} subject="${email.subject}"`);
      return { sent: true, detail: 'logged (MAIL_TRANSPORT=log)' };
    }

    try {
      const info = await this.smtp().sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      this.logger.log(`[mail:smtp] to=${email.to} messageId=${info.messageId}`);
      return { sent: true, detail: String(info.messageId) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      // Logged as a warning, not an error: a mail server being down is
      // expected operational weather, and the row records it either way.
      this.logger.warn(`[mail:smtp] to=${email.to} failed: ${reason}`);
      return { sent: false, reason };
    }
  }

  /**
   * The transporter, built on first use.
   *
   * Lazily, so a service configured for SMTP still starts when the mail
   * server is not running. Nodemailer would not fail at construction anyway,
   * but building it on demand keeps the "log" transport from opening a pool
   * it never uses.
   */
  private smtp(): Transporter {
    if (this.transporter === null) {
      this.transporter = createTransport({
        host: this.config.get('MAIL_HOST', { infer: true }),
        port: this.config.get('MAIL_PORT', { infer: true }),
        // MailHog speaks plain SMTP with no authentication and no TLS. Any
        // real provider needs both, and the credentials belong in a secret
        // manager rather than in `.env` — deferred, with a trigger.
        secure: false,
        ignoreTLS: true,
      });
    }
    return this.transporter;
  }
}
