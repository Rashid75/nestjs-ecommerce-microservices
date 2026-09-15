import {
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
