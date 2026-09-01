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
    DatabaseModule,

    CartModule,
  ],
})
export class AppModule {}
