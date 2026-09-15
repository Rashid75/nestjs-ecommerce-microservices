import { ObservabilityModule } from '@ecommerce/observability';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CartModule } from '../cart/cart.module';
import { cartEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: cartEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),

    // Registered right after the config, and before anything that logs:
    // every other module in this app resolves the logger from here.
    ObservabilityModule.forRoot({
      service: 'cart',
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    }),
    DatabaseModule,

    CartModule,
  ],
})
export class AppModule {}
