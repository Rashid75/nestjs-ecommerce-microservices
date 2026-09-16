/**
 * FIRST IMPORT, DELIBERATELY. OpenTelemetry patches modules as they are
 * required, so anything imported above this line is the unpatched version
 * and never appears in a trace. Nest included.
 */
import '@ecommerce/observability/tracing';
import {
  AllExceptionsFilter,
  correlationMiddleware,
  PinoLoggerService,
} from '@ecommerce/observability';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
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
   * SECURITY HEADERS, and ONLY on the gateway.
   *
   * The internal services are bound to 127.0.0.1 and are never spoken to by
   * a browser, so `X-Frame-Options` on the Cart Service protects nothing and
   * costs a header on every internal call. Defence in depth is a real
   * principle and it is not an argument for putting every control everywhere
   * — a control in a place it cannot apply is noise that makes the ones that
   * matter harder to find.
   *
   * What Helmet actually does, briefly: removes `X-Powered-By` (free
   * reconnaissance), sets `X-Content-Type-Options: nosniff` (stops a browser
   * deciding your JSON is HTML and executing it), `X-Frame-Options: DENY`
   * (clickjacking), `Strict-Transport-Security` (no downgrade to HTTP), and
   * a restrictive `Content-Security-Policy`.
   */
  app.use(
    helmet({
      /**
       * The CSP is left ON with its default, which is very strict —
       * `default-src 'self'`. That is correct for an API that returns JSON
       * and serves no pages.
       *
       * It would need loosening the moment this gateway served a Swagger UI
       * or any HTML, and the right move then is to loosen it for THAT route,
       * not to turn it off globally.
       */
      contentSecurityPolicy: true,

      /**
       * HSTS tells a browser never to speak HTTP to this host again — for a
       * year, cached. Enabled, and worth knowing that it is close to
       * irreversible: set it on a host that later cannot serve HTTPS and
       * that host is unreachable for every browser that saw the header.
       *
       * It does nothing over plain HTTP, so it is harmless locally.
       */
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );

  /**
   * CORS: an ALLOW-LIST, never a reflection.
   *
   * `origin: true` reflects whatever Origin the request carried, which
   * combined with `credentials: true` means any website can make
   * authenticated requests as your logged-in user. It is the single most
   * common CORS mistake and it reads as the permissive-but-fine option.
   *
   * The list comes from configuration because it differs per environment,
   * and an empty list means "no browser origin is allowed" — which is the
   * correct default for a system with no browser client yet.
   */
  const allowedOrigins = config
    .get('CORS_ALLOWED_ORIGINS', { infer: true })
    .split(',')
    .map((origin: string) => origin.trim())
    .filter((origin: string) => origin !== '');

  app.enableCors({
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
    // Only what is used. A wildcard here would let a future header carry
    // something across an origin boundary that nobody thought about.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Correlation-Id',
    ],
    // So a browser client can read the id back and quote it in a bug report.
    exposedHeaders: ['X-Correlation-Id', 'Idempotent-Replay'],
    credentials: true,
    maxAge: 600,
  });

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
