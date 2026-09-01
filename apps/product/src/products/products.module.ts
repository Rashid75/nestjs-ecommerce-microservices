import { EVENTS_CLIENT } from '@ecommerce/contracts';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  type RmqOptions,
  Transport,
} from '@nestjs/microservices';
import type { ProductEnv } from '../config/env.validation';
import { SequelizeModule } from '@nestjs/sequelize';
import { Category } from '../categories/category.model';
import { Product } from './product.model';
import { ProductsCacheService } from './products-cache.service';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * Owns the `products` table.
 *
 * `forFeature` registers Category as well as Product because the repository
 * JOINs to it. Registering a model does NOT grant write access to another
 * module's data — nothing here mutates categories — it only makes the
 * association resolvable so `include: [Category]` works.
 *
 * Only the repository is exported. CategoriesService needs `countByCategory`
 * before it soft-deletes; it does not need the model.
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
        useFactory: (config: ConfigService<ProductEnv, true>): RmqOptions => {
          const url: string = config.get('RABBITMQ_URL', { infer: true });
          const queue: string = config.get('RABBITMQ_QUEUE', { infer: true });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue,
              // Survives a broker restart. Nest publishes persistent
              // messages by default, which is the other half of that.
              queueOptions: { durable: true },
            },
          };
        },
      },
    ]),
    SequelizeModule.forFeature([Product, Category]),
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository, ProductsCacheService],
  exports: [ProductsRepository],
})
export class ProductsModule {}
