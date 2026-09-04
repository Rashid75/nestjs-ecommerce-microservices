import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { CatalogueEventsController } from '../catalog/catalogue-events.controller';
import { ProductLookupService } from '../catalog/product-lookup.service';
import type { CartEnv } from '../config/env.validation';
import { OrderEventsController } from '../orders/order-events.controller';
import { CartItem } from './cart-item.model';
import { CartController } from './cart.controller';
import { Cart } from './cart.model';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Cart, CartItem]),
    // The Cart Service calls the Product Service directly — the first
    // service-to-service hop in this system that does not go through the
    // gateway. A short timeout keeps a slow catalogue from holding cart
    // requests open.
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<CartEnv, true>) => ({
        baseURL: config.get('PRODUCT_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
  ],
  // THREE controllers: one for HTTP, two for messages. Nest treats them the
  // same way — the only difference is which decorator the handlers carry.
  //
  // The message controllers are split by the SOURCE of the events rather
  // than merged into one "events controller". Catalogue events and order
  // events come from different services and mean different things.
  controllers: [
    CartController,
    CatalogueEventsController,
    OrderEventsController,
  ],
  providers: [CartService, CartRepository, ProductLookupService],
})
export class CartModule {}
