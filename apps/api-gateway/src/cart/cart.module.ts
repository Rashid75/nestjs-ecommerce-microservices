import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '../common/authentication.module';
import type { GatewayEnv } from '../config/env.validation';
import { CartProxyService } from './cart-proxy.service';
import { CartController } from './cart.controller';

/**
 * This module's own HttpService points at the Cart Service.
 *
 * The guard needs one pointed at AUTH instead, and a module can import
 * HttpModule only once — so the guard comes from AuthenticationModule, which
 * carries its own client. See the note there for why that separation is
 * worth the ceremony.
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('CART_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
    AuthenticationModule,
  ],
  controllers: [CartController],
  providers: [CartProxyService],
})
export class CartModule {}
