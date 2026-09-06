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
    DatabaseModule,

    PaymentsModule,
  ],
})
export class AppModule {}
