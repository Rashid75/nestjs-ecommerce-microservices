import { ServiceQueue } from '@ecommerce/contracts';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app/app.module';
import type { OrderEnv } from './config/env.validation';

/**
 * A HYBRID application, as of Milestone 9 — HTTP and RabbitMQ in one
 * process, the same shape the Cart Service has had since Milestone 7.
 *
 * The Order Service publishes `order.confirmed` and now also CONSUMES
 * `payment.succeeded`, because the fact that money arrived belongs to the
 * Payment Service and the decision about what it means for an order belongs
 * here.
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

  // The exchange is shared by every service; the queue belongs to this one.
  // Pulled into typed locals first: ConfigService.get returns a wide union,
  // and passing it straight in produces a four-level type error deep inside
  // Nest's overloads that says almost nothing useful.
  const brokerUrl: string = config.get('RABBITMQ_URL', { infer: true });
  const exchange: string = config.get('RABBITMQ_EXCHANGE', { infer: true });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [brokerUrl],
      // THIS SERVICE'S OWN QUEUE, bound to the shared exchange. Nest reads
      // the `@EventPattern()` strings in this app and binds one routing key
      // per handler, so this queue receives a COPY of exactly the events
      // this service asked for — and none of the others.
      queue: ServiceQueue.Order,
      exchange,
      exchangeType: 'topic',
      wildcards: true,
      // Durable, so a broker restart does not discard the queue and the
      // bindings with it. Messages published while this service is down
      // wait here for it.
      queueOptions: { durable: true },
    },
  });

  // HTTP FIRST. The order of these two calls matters more than it looks.
  //
  // `startAllMicroservices()` waits for the broker, and
  // amqp-connection-manager retries indefinitely — so with RabbitMQ down,
  // awaiting it BEFORE `listen()` means the HTTP server never starts at all.
  // Orders would be unplaceable because an optional subsystem was.
  //
  // 127.0.0.1, like every internal service: this one trusts the `X-User-Id`
  // header the gateway sets, and the loopback binding is the only thing
  // making that safe — see orders/current-user.decorator.ts.
  const port = config.get('ORDER_SERVICE_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `order service listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );

  // Then the listener, deliberately NOT awaited. Forget this call entirely
  // and the HTTP side works perfectly while no message is ever consumed — a
  // silent failure, because nothing errors.
  void app
    .startAllMicroservices()
    .then(() =>
      Logger.log(
        `consuming queue "${ServiceQueue.Order}" bound to exchange "${exchange}"`,
        'Bootstrap',
      ),
    )
    .catch((error: Error) =>
      Logger.warn(
        `RabbitMQ consumer did not start (${error.message}) — orders will not be marked PAID until the broker returns`,
        'Bootstrap',
      ),
    );
}

void bootstrap();
