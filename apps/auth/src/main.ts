import {
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
