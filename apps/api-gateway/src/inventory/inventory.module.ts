import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GatewayEnv } from '../config/env.validation';
import { InventoryProxyService } from './inventory-proxy.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('INVENTORY_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
  ],
  controllers: [InventoryController],
  providers: [InventoryProxyService],
})
export class InventoryModule {}
