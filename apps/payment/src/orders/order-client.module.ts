import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv } from '../config/env.validation';
import { OrderClientService } from './order-client.service';

/** The Payment Service's only downstream dependency. */
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<PaymentEnv, true>) => ({
        baseURL: config.get('ORDER_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
  ],
  providers: [OrderClientService],
  exports: [OrderClientService],
})
export class OrderClientModule {}
