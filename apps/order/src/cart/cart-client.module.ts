import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OrderEnv } from '../config/env.validation';
import { CartClientService } from './cart-client.service';

/**
 * One module per downstream service, each carrying its own HttpService.
 *
 * A module can import `HttpModule` only ONCE, and the provider it creates
 * carries a single `baseURL`. One module per upstream keeps that URL, the
 * timeout and any header defaults in one place per upstream — which is
 * where they belong, and which matters as soon as there are two. Step 2 of
 * this milestone adds an `InventoryClientModule` alongside this one for
 * exactly that reason.
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<OrderEnv, true>) => ({
        baseURL: config.get('CART_SERVICE_URL', { infer: true }),
        // Every outbound call needs a deadline. Without one, a hung Cart
        // Service holds this request open indefinitely, and enough of those
        // exhaust the Order Service too — that is how one slow service takes
        // down a system.
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
  ],
  providers: [CartClientService],
  exports: [CartClientService],
})
export class CartClientModule {}
