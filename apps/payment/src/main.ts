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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const port = config.get('PAYMENT_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `payment service listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );
}

void bootstrap();
