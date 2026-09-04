import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { orderEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: orderEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),
    DatabaseModule,

    OrdersModule,
  ],
})
export class AppModule {}
