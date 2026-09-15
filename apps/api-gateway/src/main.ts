/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import '@ecommerce/observability/tracing';
import {
  correlationMiddleware,
  PinoLoggerService,
} from '@ecommerce/observability';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { GatewayEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<GatewayEnv, true>>(ConfigService);

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

  const globalPrefix = config.get('API_GLOBAL_PREFIX', { infer: true });
  app.setGlobalPrefix(globalPrefix);

  // See the long note in apps/auth/src/main.ts for what each option does.
  // Both services validate independently: the gateway rejects malformed input
  // one hop early, and the Auth Service never trusts its caller.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.get('API_GATEWAY_PORT', { infer: true });
  await app.listen(port);

  Logger.log(
    `api gateway listening on http://localhost:${port}/${globalPrefix}`,
    'Bootstrap',
  );
}

void bootstrap();
