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
import type { ProductEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<ProductEnv, true>>(ConfigService);

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
      // Needed by every query DTO in this service.
      //
      // A query string is all strings: `?page=2&limit=50` arrives as
      // { page: "2", limit: "50" }. Without transformer options, the
      // `@Type(() => Number)` decorators on PaginationQueryDto never run and
      // `@IsInt()` rejects "2" as not an integer.
      //
      // `enableImplicitConversion` stays OFF: it would coerce ANY field
      // toward its declared type, so `?page=abc` becomes NaN rather than a
      // 400. Explicit @Type is the safer half of that feature.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const port = config.get('PRODUCT_SERVICE_PORT', { infer: true });

  // Loopback only, like the Auth Service. Internal services are reachable
  // from the gateway and from nothing else.
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `product service listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );
}

void bootstrap();
