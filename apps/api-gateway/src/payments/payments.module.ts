import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '../common/authentication.module';
import type { GatewayEnv } from '../config/env.validation';
import { PaymentsProxyService } from './payments-proxy.service';
import { PaymentsController } from './payments.controller';

/**
 * Note the timeout: PAYMENT_GATEWAY_TIMEOUT_MS, not the shared one.
 *
 * A charge legitimately takes seconds, and the gateway's 5-second default
 * would abandon a request that is still working — leaving the customer with
 * a 504 and a payment whose outcome nobody knows. The gateway's deadline has
 * to be LONGER than the Payment Service's provider deadline, or the outer
 * timeout fires first and makes the inner one pointless.
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('PAYMENT_SERVICE_URL', { infer: true }),
        timeout: config.get('PAYMENT_GATEWAY_TIMEOUT_MS', { infer: true }),
      }),
    }),
    AuthenticationModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsProxyService],
})
export class PaymentsModule {}
