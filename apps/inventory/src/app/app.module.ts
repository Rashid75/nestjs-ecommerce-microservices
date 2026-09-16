import { ObservabilityModule } from '@ecommerce/observability';
import { HealthModule } from '@ecommerce/observability/health';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { inventoryEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { InventoryModule } from '../inventory/inventory.module';

/**
 * The Inventory Service root module.
 *
 * No RedisModule. See the note at the top of config/env.validation.ts —
 * stock figures are the one thing in this system that must never be served
 * from a cache.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: inventoryEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),

    // Registered right after the config, and before anything that logs:
    // every other module in this app resolves the logger from here.
    ObservabilityModule.forRoot({
      service: 'inventory',
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    }),
    DatabaseModule,

    InventoryModule,

    HealthModule,
  ],
})
export class AppModule {}
