import { ObservabilityModule } from '@ecommerce/observability';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { authEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';

/**
 * The Auth Service root module.
 *
 * Order matters conceptually even though Nest resolves the graph for you:
 * configuration must be valid before a database connection is attempted, and
 * the database must be reachable before AuthModule can serve a request.
 * Validation failure kills the process at the first step, which is exactly
 * where you want to find out.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Resolved from the process working directory, which is the WORKSPACE
      // ROOT when started by Nx. One .env for the whole monorepo in local
      // development; in production each service gets its own environment from
      // the orchestrator and this file simply is not there.
      envFilePath: ['.env.local', '.env'],
      validationSchema: authEnvSchema,
      validationOptions: {
        // Report every bad variable at once instead of one restart per typo.
        abortEarly: false,
        // Required: process.env holds hundreds of OS variables we do not own.
        // Unknown keys are ignored; the keys we DO declare are still strict.
        allowUnknown: true,
      },
      cache: true,
    }),

    // Registered right after the config, and before anything that logs:
    // every other module in this app resolves the logger from here.
    ObservabilityModule.forRoot({
      service: 'auth',
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    }),
    DatabaseModule,

    AuthModule,
  ],
})
export class AppModule {}
