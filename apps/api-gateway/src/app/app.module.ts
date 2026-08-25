import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
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
    AuthModule,
  ],
})
export class AppModule {}
