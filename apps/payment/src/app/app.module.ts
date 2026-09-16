import { ObservabilityModule } from '@ecommerce/observability';
import { HealthModule } from '@ecommerce/observability/health';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { paymentEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: paymentEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),

    // Registered right after the config, and before anything that logs:
    // every other module in this app resolves the logger from here.
    ObservabilityModule.forRoot({
      service: 'payment',
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    }),
    DatabaseModule,

    PaymentsModule,

    HealthModule,
  ],
})
export class AppModule {}
