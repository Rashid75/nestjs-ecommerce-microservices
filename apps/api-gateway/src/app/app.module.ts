import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { configuration } from '../config/configuration';
import { envValidationSchema } from '../config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Available everywhere without re-importing ConfigModule in each module.
      isGlobal: true,
      // Loaded left to right; the first file that defines a key wins.
      // `.env.local` is for personal overrides and is never committed.
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        // Report every invalid variable at once, not just the first.
        abortEarly: false,
        // process.env contains hundreds of OS variables we do not own,
        // so unknown keys must be tolerated (they are simply ignored).
        allowUnknown: true,
      },
      // Env vars cannot change while the process runs, so cache the lookups.
      cache: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
