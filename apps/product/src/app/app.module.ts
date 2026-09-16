import { RedisModule } from '@ecommerce/redis';
import { ObservabilityModule } from '@ecommerce/observability';
import { HealthModule } from '@ecommerce/observability/health';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CategoriesModule } from '../categories/categories.module';
import { productEnvSchema } from '../config/env.validation';
import type { ProductEnv } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { ProductsModule } from '../products/products.module';

/**
 * The Product Service root module.
 *
 * Same shape as the Auth Service: validated configuration first, then a
 * proven database connection, then the feature modules. A bad environment
 * variable kills the process at step one.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: productEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),

    // Registered right after the config, and before anything that logs:
    // every other module in this app resolves the logger from here.
    ObservabilityModule.forRoot({
      service: 'product',
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    }),
    DatabaseModule,

    // Redis is imported AFTER the database on purpose, and the ordering is
    // a statement of dependency strength: PostgreSQL is required to boot,
    // Redis is not. RedisModule connects lazily and the service runs
    // perfectly well — just slower — when Redis is unreachable.
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ProductEnv, true>) => ({
        url: config.get('REDIS_URL', { infer: true }),
        // Every key this service writes lives under this prefix. Redis has
        // no equivalent of a per-service database, so the prefix is what
        // stops the gateway's rate-limit counters and these cache entries
        // from ever colliding.
        keyPrefix: 'ecom:product:',
      }),
    }),

    ProductsModule,
    CategoriesModule,

    HealthModule,
  ],
})
export class AppModule {}
