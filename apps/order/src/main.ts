import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { OrderEnv } from './config/env.validation';

/**
 * Plain HTTP, nothing else.
 *
 * Contrast with the Cart Service, which is a HYBRID application — HTTP plus
 * a RabbitMQ listener in one process. The Order Service neither publishes
 * nor consumes messages in step 1, so there is nothing to connect. That
 * changes in step 2, and `connectMicroservice` appears here then.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<OrderEnv, true>>(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // 127.0.0.1, like every internal service. This one trusts the `X-User-Id`
  // header the gateway sets, and the loopback binding is the only thing
  // making that safe — see orders/current-user.decorator.ts.
  const port = config.get('ORDER_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `order service listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );
}

void bootstrap();
