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

  Logger.log(`auth service listening on http://${host}:${port}`, 'Bootstrap');
}

void bootstrap();
