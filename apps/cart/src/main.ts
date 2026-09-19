/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import './otel-service-name';
import '@ecommerce/observability/tracing';
import { ServiceQueue } from '@ecommerce/contracts';
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
import type { CartEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<CartEnv, true>>(ConfigService);

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

  /**
   * A HYBRID APPLICATION — HTTP and RabbitMQ in the same process.
   *
   * `connectMicroservice` attaches a message listener to an app that is
   * already serving HTTP. The Cart Service therefore does two jobs at once:
   * answers `/cart` requests, and consumes catalogue events.
   *
   * That is the right shape here because both touch the same tables and the
   * same models — splitting them would mean two deployments sharing a
   * database, which is a worse boundary than the one we have.
   *
   * The queue is this service's OWN, and it is bound to the shared topic
   * exchange. Both names come from one contract and one env var, so
   * publisher and consumer cannot drift on the spelling.
   */
  // The exchange is shared by every service; the queue belongs to this one.
  //
  // Pulled into typed locals first: ConfigService.get returns a wide union,
  // and passing it straight in produces a four-level type error deep inside
  // Nest's overloads that says almost nothing useful.
  const brokerUrl: string = config.get('RABBITMQ_URL', { infer: true });
  const exchange: string = config.get('RABBITMQ_EXCHANGE', { infer: true });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [brokerUrl],
      // THIS SERVICE'S OWN QUEUE, bound to the shared exchange. Nest reads
      // the `@EventPattern()` strings in this app and binds one routing key
      // per handler, so this queue receives a COPY of exactly the events
      // this service asked for — and none of the others.
      queue: ServiceQueue.Cart,
      exchange,
      exchangeType: 'topic',
      wildcards: true,
      // Durable, so a broker restart does not discard the queue and the
      // bindings with it. Messages published while this service is down
      // wait here for it.
      queueOptions: { durable: true },
    },
  });

  // HTTP FIRST. The order of these two calls matters more than it looks.
  //
  // `startAllMicroservices()` waits for the broker connection, and
  // amqp-connection-manager retries indefinitely — so with RabbitMQ down,
  // awaiting it BEFORE `listen()` means the HTTP server never starts at
  // all. The cart API would be dead because an optional subsystem was.
  //
  // Serving HTTP first makes the dependency honest: carts work, and only
  // the event consumer is degraded.
  const port = config.get('CART_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(`cart service listening on http://127.0.0.1:${port}`, 'Bootstrap');

  // Then the message listener, deliberately NOT awaited.
  //
  // Forget this call entirely and the HTTP side works perfectly while no
  // message is ever consumed — a silent failure that is hard to spot,
  // because nothing errors.
  void app
    .startAllMicroservices()
    .then(() =>
      Logger.log(
        `consuming queue "${ServiceQueue.Cart}" bound to exchange "${exchange}"`,
        'Bootstrap',
      ),
    )
    .catch((error: Error) =>
      Logger.warn(
        `RabbitMQ consumer did not start (${error.message}) — catalogue flags will be stale until the broker returns`,
        'Bootstrap',
      ),
    );
}

void bootstrap();
