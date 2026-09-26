/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import './otel-service-name';
import '@ecommerce/observability/tracing';
import {
  AllExceptionsFilter,
  correlationMiddleware,
  PinoLoggerService,
} from '@ecommerce/observability';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { PaymentEnv } from './config/env.validation';

/**
 * HTTP only. The Payment Service publishes events and consumes none.
 *
 * `whitelist` and `forbidNonWhitelisted` matter more here than on any other
 * endpoint in this system. They are what turns a request carrying a
 * `cardNumber` field into a 400 instead of a silently ignored property — and
 * a field that is silently ignored is a field somebody will eventually
 * assume is being used.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<PaymentEnv, true>>(ConfigService);

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

  const port = config.get('PAYMENT_SERVICE_PORT', { infer: true });
  /**
   * WHERE AN INTERNAL SERVICE LISTENS, and why it is now configurable.
   *
   * `127.0.0.1` has been the right answer since Milestone 2: this service is
   * internal, only the gateway may call it, and binding to loopback means the
   * operating system itself refuses a connection from anywhere else. No
   * firewall rule to forget, no "we assumed it was on a private network".
   *
   * A CONTAINER CHANGES THE ARITHMETIC, not the principle. Inside a container
   * `127.0.0.1` is that container's own loopback, so a service bound to it is
   * unreachable even from the gateway container next to it — the symptom is
   * ECONNREFUSED from a service that is demonstrably running, which is a
   * genuinely confusing hour.
   *
   * What replaces loopback as the boundary is the NETWORK NAMESPACE: in
   * docker-compose.yml only the gateway publishes a port, so the other seven
   * are reachable from inside the compose network and from nowhere else. The
   * protection is the same shape, enforced one layer out.
   *
   * Default 127.0.0.1, so running on the host keeps the stricter behaviour and
   * nobody has to remember to set anything.
   */
  const host = process.env.BIND_HOST ?? '127.0.0.1';

  await app.listen(port, host);

  Logger.log(
    `payment service listening on http://${host}:${port}`,
    'Bootstrap',
  );
}

void bootstrap();
