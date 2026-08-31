import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProductLookupService } from '../catalog/product-lookup.service';
import type { CartEnv } from '../config/env.validation';
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
  controllers: [CartController],
  providers: [CartService, CartRepository, ProductLookupService],
})
export class CartModule {}
