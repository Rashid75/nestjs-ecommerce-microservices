import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '../common/authentication.module';
import type { GatewayEnv } from '../config/env.validation';
import { OrdersProxyService } from './orders-proxy.service';
import { OrdersController } from './orders.controller';

/**
 * This module's HttpService points at the Order Service; the guard's points
 * at Auth. See the note in cart.module.ts for why that separation exists.
 *
 * WORTH NOTICING: the timeout that applies here is the gateway's, and the
 * request it wraps runs a whole saga — a cart read plus one reservation per
 * line. On loopback that is a few milliseconds; across a real network with a
 * large basket it is the one gateway route where 5 seconds is a number worth
 * measuring rather than assuming.
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('ORDER_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
    AuthenticationModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersProxyService],
})
export class OrdersModule {}
