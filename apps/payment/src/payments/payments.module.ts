import { EVENTS_CLIENT } from '@ecommerce/contracts';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  type RmqOptions,
  Transport,
} from '@nestjs/microservices';
import { SequelizeModule } from '@nestjs/sequelize';
import type { PaymentEnv } from '../config/env.validation';
import { OrderClientModule } from '../orders/order-client.module';
import { MockProviderService } from '../provider/mock-provider.service';
import { Payment } from './payment.model';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

/**
 * Payments, the mock provider, and the client that reads the order.
 *
 * `MockProviderService` is provided here rather than exported from its own
 * module because nothing outside this feature should be able to charge a
 * card. When it is replaced by a real provider, the seam is this one
 * provider token — the service above depends on the shape of `charge()`, not
 * on who implements it.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([Payment]),
    OrderClientModule,
    ClientsModule.registerAsync([
      {
        name: EVENTS_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<PaymentEnv, true>): RmqOptions => {
          const url: string = config.get('RABBITMQ_URL', { infer: true });
          const queue: string = config.get('RABBITMQ_QUEUE', { infer: true });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue,
              queueOptions: { durable: true },
            },
          };
        },
      },
    ]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, MockProviderService],
})
export class PaymentsModule {}
