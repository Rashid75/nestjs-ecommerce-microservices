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
import type { AuthEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<AuthEnv, true>>(ConfigService);

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

  /**
   * The global ValidationPipe. Three options, none of which should be enabled
   * without understanding what it does:
   *
   * whitelist: true
   *   Strips any property that has no validation decorator on the DTO. Send
   *   `{ email, password, role: "ADMIN" }` to /auth/register and `role` is
   *   removed before the DTO reaches the controller. This is MASS ASSIGNMENT
   *   protection, and it is the single most valuable option here.
   *
   * forbidNonWhitelisted: true
   *   Escalates from "strip it silently" to "reject the request with 400".
   *   Better for an API with real clients: a typo'd field name fails loudly
   *   instead of being quietly ignored, and the client learns immediately.
   *   The trade-off is brittleness — an older server rejects a newer client's
   *   extra field, so relax this if you ever need forward compatibility.
   *
   * transform: true
   *   Runs class-transformer, so the handler receives a real DTO INSTANCE
   *   rather than a plain object. Without it, `@Transform` never runs (our
   *   email lowercasing would be silently skipped) and `instanceof` checks
   *   fail. `enableImplicitConversion` is left OFF: coercing "abc" to NaN
   *   silently is worse than a clear type error.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.get('AUTH_SERVICE_PORT', { infer: true });

  // Bound to the LOOPBACK interface, not 0.0.0.0.
  //
  // This service issues credentials and must never be reachable from outside
  // the machine. Binding to 0.0.0.0 during local development is how an
  // internal service ends up exposed on a laptop's Wi-Fi interface. In
  // Milestone 14 the equivalent control is a Docker network with no published
  // port.
  await app.listen(port, '127.0.0.1');

  Logger.log(`auth service listening on http://127.0.0.1:${port}`, 'Bootstrap');
}

void bootstrap();
