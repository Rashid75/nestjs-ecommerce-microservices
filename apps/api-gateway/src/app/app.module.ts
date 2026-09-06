import { RedisModule } from '@ecommerce/redis';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { RateLimitGuard } from '../common/rate-limit.guard';
import type { GatewayEnv } from '../config/env.validation';
import { gatewayEnvSchema } from '../config/env.validation';

/**
 * The API Gateway root module.
 *
 * Note what changed since Milestone 1: the separate `configuration.ts` factory
 * is gone. With a Joi `validationSchema`, ConfigService already serves
 * validated, defaulted values, and `ConfigService<GatewayEnv, true>` already
 * gives `get()` full type inference. The nested config object was a second
 * mapping to keep in sync for no additional safety — so it went. Deleting an
 * abstraction that stopped paying for itself is part of the job.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: gatewayEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        url: config.get('REDIS_URL', { infer: true }),
        keyPrefix: 'ecom:gateway:',
      }),
    }),

    AuthModule,
    CatalogModule,
    InventoryModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
  ],
  providers: [
    // GLOBAL, not per-controller, and that direction matters.
    //
    // A guard applied route by route fails OPEN when someone forgets it: the
    // new endpoint is simply unlimited, and nothing tells you. Applied
    // globally it fails CLOSED — a new endpoint inherits the default budget,
    // and anything needing an exception has to say so out loud with
    // @RateLimit() or @SkipRateLimit().
    //
    // Same argument as making JwtAuthGuard global later: default to
    // protected, opt out deliberately.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
