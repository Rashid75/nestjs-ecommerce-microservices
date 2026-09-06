import { EVENTS_CLIENT } from '@ecommerce/contracts';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  type RmqOptions,
  Transport,
} from '@nestjs/microservices';
import { SequelizeModule } from '@nestjs/sequelize';
import { CartClientModule } from '../cart/cart-client.module';
import { PaymentEventsController } from '../payments/payment-events.controller';
import type { OrderEnv } from '../config/env.validation';
import { OrderItem } from './order-item.model';
import { Order } from './order.model';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Orders, their lines, and the RabbitMQ client that announces them.
 *
 * `ClientsModule` is NOT global, so the provider has to live in the module
 * where it is injected. Putting it in AppModule looks tidier and fails with
 * "Nest can't resolve dependencies ... EVENTS_CLIENT" — the client belongs
 * next to its consumer. Same shape as the Inventory Service.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([Order, OrderItem]),
    CartClientModule,
    ClientsModule.registerAsync([
      {
        name: EVENTS_CLIENT,
        inject: [ConfigService],
        // The return type is annotated so TypeScript checks the shape here
        // rather than deep inside Nest's overloads, where the error is four
        // levels of union mismatch and says almost nothing.
        useFactory: (config: ConfigService<OrderEnv, true>): RmqOptions => {
          const url: string = config.get('RABBITMQ_URL', { infer: true });
          const queue: string = config.get('RABBITMQ_QUEUE', { infer: true });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue,
              // Survives a broker restart. Nest publishes persistent messages
              // by default, which is the other half of that.
              queueOptions: { durable: true },
            },
          };
        },
      },
    ]),
  ],
  // TWO controllers: HTTP, and the payment events that move an order to
  // PAID. Same class shape, different decorator on the handlers.
  controllers: [OrdersController, PaymentEventsController],
  providers: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
