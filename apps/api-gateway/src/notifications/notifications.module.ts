import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '../common/authentication.module';
import type { GatewayEnv } from '../config/env.validation';
import { NotificationsProxyService } from './notifications-proxy.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('NOTIFICATION_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
    AuthenticationModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsProxyService],
})
export class NotificationsModule {}
