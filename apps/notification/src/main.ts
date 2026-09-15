/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import '@ecommerce/observability/tracing';
import { ServiceQueue } from '@ecommerce/contracts';
import {
  correlationMiddleware,
  PinoLoggerService,
} from '@ecommerce/observability';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app/app.module';
import type { NotificationEnv } from './config/env.validation';

/**
 * A HYBRID application whose real work is on the message side.
 *
 * The HTTP server exists for one read endpoint. Everything this service
 * actually does arrives over RabbitMQ — which is why the listener failing to
 * start is a much bigger deal here than in the Cart or Order services, and
 * why the warning below says so.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<NotificationEnv, true>>(ConfigService);

  /**
   * Nest's OWN logs go through Pino too — route mapping, shutdown, an
   * unhandled exception. A system where half the lines are JSON and half are
   * not cannot be shipped anywhere useful.
   */
  const logger = app.get(PinoLoggerService);
  app.useLogger(logger);

  /**
   * Before every route: adopt the inbound correlation id (or mint one), put
   * it in the async context for the rest of the request, and log how the
   * request went.
   */
  app.use(correlationMiddleware(logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const brokerUrl: string = config.get('RABBITMQ_URL', { infer: true });
  const exchange: string = config.get('RABBITMQ_EXCHANGE', { infer: true });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [brokerUrl],
      // This service's own queue, bound to the shared exchange with one
      // routing key per `@EventPattern()` in the app. The Cart Service binds
      // `order.confirmed` too, and both get a copy — which is the entire
      // reason the exchange exists.
      queue: ServiceQueue.Notification,
      exchange,
      exchangeType: 'topic',
      wildcards: true,
      // Durable, so events published while this service is down wait in the
      // queue instead of being lost. A welcome email that arrives late is
      // fine; one that never arrives is not.
      queueOptions: { durable: true },
    },
  });

  // HTTP first, for the same reason as everywhere else: awaiting the broker
  // before `listen()` means a down RabbitMQ takes the HTTP API with it.
  const port = config.get('NOTIFICATION_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `notification service listening on http://127.0.0.1:${port} (mail transport: ${config.get('MAIL_TRANSPORT', { infer: true })})`,
    'Bootstrap',
  );

  void app
    .startAllMicroservices()
    .then(() =>
      Logger.log(
        `consuming queue "${ServiceQueue.Notification}" bound to exchange "${exchange}"`,
        'Bootstrap',
      ),
    )
    .catch((error: Error) =>
      Logger.error(
        `RabbitMQ consumer did not start (${error.message}) — NO EMAIL WILL BE SENT until the broker returns`,
        'Bootstrap',
      ),
    );
}

void bootstrap();
