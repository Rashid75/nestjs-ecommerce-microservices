import { EVENTS_CLIENT } from '@ecommerce/contracts';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  type RmqOptions,
  Transport,
} from '@nestjs/microservices';
import type { InventoryEnv } from '../config/env.validation';
import { SequelizeModule } from '@nestjs/sequelize';
import { InventoryController } from './inventory.controller';
import { InventoryItem } from './inventory-item.model';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { StockMovement } from './stock-movement.model';

/**
 * Owns both tables, because they are one aggregate: a balance and the ledger
 * that explains it. Splitting them across modules would let one be written
 * without the other, which is precisely the state the repository's
 * transactions exist to prevent.
 */
@Module({
  imports: [
    // The RabbitMQ publisher, registered in the module whose service uses it.
    //
    // `ClientsModule` is NOT global, so the provider has to live where it is
    // injected. Putting it in AppModule looks tidier and fails with
    // "Nest can't resolve dependencies ... EVENTS_CLIENT" — the client
    // belongs next to its consumer.
    ClientsModule.registerAsync([
      {
        name: EVENTS_CLIENT,
        inject: [ConfigService],
        // The return type is annotated so TypeScript checks the shape here
        // rather than deep inside Nest's overloads, where the error is four
        // levels of union mismatch and says almost nothing.
        useFactory: (config: ConfigService<InventoryEnv, true>): RmqOptions => {
          const url: string = config.get('RABBITMQ_URL', { infer: true });
          const exchange: string = config.get('RABBITMQ_EXCHANGE', {
            infer: true,
          });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              // Published to the EXCHANGE, not to a queue. The publisher does
              // not know or care which services have bound a queue to it.
              exchange,
              exchangeType: 'topic',
              // Tells Nest to use the event pattern as the ROUTING KEY, so
              // "order.confirmed" is routed by the broker rather than being
              // the name of a queue.
              wildcards: true,
            },
          };
        },
      },
    ]),
    SequelizeModule.forFeature([InventoryItem, StockMovement]),
  ],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
