import { Global, Module } from '@nestjs/common';
import { LoggerOptions, PinoLoggerService } from './pino-logger.service';

/**
 * Makes the logger injectable everywhere.
 *
 * `@Global()`, which this project otherwise avoids. The rule against global
 * modules is a good one — it keeps dependencies visible in each module's
 * `imports` — and logging is the standard exception: every provider in every
 * service may log, and threading an import through forty modules to say so
 * would obscure the dependencies that actually matter.
 */
@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(options: LoggerOptions) {
    const logger = new PinoLoggerService(options);

    return {
      module: ObservabilityModule,
      providers: [{ provide: PinoLoggerService, useValue: logger }],
      exports: [PinoLoggerService],
    };
  }
}
