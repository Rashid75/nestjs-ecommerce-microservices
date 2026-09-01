import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';
import type { CartEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<CartEnv, true>>(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  /**
   * A HYBRID APPLICATION — HTTP and RabbitMQ in the same process.
   *
   * `connectMicroservice` attaches a message listener to an app that is
   * already serving HTTP. The Cart Service therefore does two jobs at once:
   * answers `/cart` requests, and consumes catalogue events.
   *
   * That is the right shape here because both touch the same tables and the
   * same models — splitting them would mean two deployments sharing a
   * database, which is a worse boundary than the one we have.
   *
   * `queue` must match what the publishers send to. Both come from
   * `@ecommerce/contracts` so the two sides cannot drift.
   */
  // Pulled into typed locals first. ConfigService.get returns a wide union,
  // and passing it straight in produces a four-level type error deep inside
  // Nest's overloads that says almost nothing useful.
  const brokerUrl: string = config.get('RABBITMQ_URL', { infer: true });
  const queue: string = config.get('RABBITMQ_QUEUE', { infer: true });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [brokerUrl],
      queue,
      queueOptions: { durable: true },
    },
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Cart Service (internal)')
    .setDescription(
      'Cart lifecycle. Internal service — public traffic goes through the API Gateway.',
    )
    .setVersion('1.0')
    .build();

  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  // HTTP FIRST. The order of these two calls matters more than it looks.
  //
  // `startAllMicroservices()` waits for the broker connection, and
  // amqp-connection-manager retries indefinitely — so with RabbitMQ down,
  // awaiting it BEFORE `listen()` means the HTTP server never starts at
  // all. The cart API would be dead because an optional subsystem was.
  //
  // Serving HTTP first makes the dependency honest: carts work, and only
  // the event consumer is degraded.
  const port = config.get('CART_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `cart service listening on http://127.0.0.1:${port} (docs: /docs)`,
    'Bootstrap',
  );

  // Then the message listener, deliberately NOT awaited.
  //
  // Forget this call entirely and the HTTP side works perfectly while no
  // message is ever consumed — a silent failure that is hard to spot,
  // because nothing errors.
  void app
    .startAllMicroservices()
    .then(() => Logger.log(`consuming RabbitMQ queue "${queue}"`, 'Bootstrap'))
    .catch((error: Error) =>
      Logger.warn(
        `RabbitMQ consumer did not start (${error.message}) — catalogue flags will be stale until the broker returns`,
        'Bootstrap',
      ),
    );
}

void bootstrap();
