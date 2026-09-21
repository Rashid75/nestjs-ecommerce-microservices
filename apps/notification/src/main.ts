/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import './otel-service-name';
import '@ecommerce/observability/tracing';
import { deadLetterArgs, ServiceQueue } from '@ecommerce/contracts';
import {
  AllExceptionsFilter,
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

  /**
   * The last line of defence. Every error leaves in the same shape, and an
   * error nobody anticipated becomes a 500 carrying nothing but the
   * correlation id — while the real cause goes to the log.
   */
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  /**
   * GRACEFUL SHUTDOWN. Without this, Nest never runs `onModuleDestroy` /
   * `onApplicationShutdown` and the process simply dies on SIGTERM: requests
   * in flight are cut off mid-response, and the database and broker
   * connections are dropped rather than closed.
   *
   * With it, `app.close()` stops the HTTP server accepting new connections,
   * lets the in-flight ones finish, then tears the modules down in reverse
   * dependency order — so the RabbitMQ consumer stops before the database it
   * writes to closes.
   *
   * This matters in exactly one place and it is not development: a container
   * orchestrator sends SIGTERM and then waits a grace period before SIGKILL.
   * Everything you want to finish has to finish inside it.
   */
  app.enableShutdownHooks();

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
      queueOptions: {
        durable: true,
        // DEAD-LETTERING, since Milestone 12 pass 4. A message this service
        // cannot process is moved by the BROKER to its parking queue rather
        // than being dropped — see libs/contracts/src/lib/events/dead-letter.ts
        // for why parking beats requeueing.
        //
        // These arguments are fixed at declaration. If this service refuses
        // to start with PRECONDITION_FAILED, the queue already exists WITHOUT
        // them and has to be deleted: node tools/setup-broker.mjs --recreate
        arguments: deadLetterArgs(ServiceQueue.Notification),
      },

      /**
       * MANUAL ACKNOWLEDGEMENT. Nest's default is `noAck: true`, where the
       * broker considers a message delivered the moment it is handed over —
       * so a handler that throws loses it silently.
       *
       * With this false, nothing is acknowledged until a handler says so,
       * which is what makes parking possible. It also means every handler
       * MUST settle its message: see `ackOrPark`, which is why no handler
       * calls `channel.ack` directly.
       */
      noAck: false,

      /**
       * At most this many unacknowledged messages at once.
       *
       * It matters far more with manual acks than without. Unlimited
       * prefetch plus manual acks means one slow handler can accumulate
       * thousands of in-flight messages in memory, and a crash loses all of
       * them from this process's point of view (the broker redelivers, which
       * is the good news). A small window also spreads work across replicas
       * instead of letting the first consumer to connect grab everything.
       */
      prefetchCount: 10,
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
