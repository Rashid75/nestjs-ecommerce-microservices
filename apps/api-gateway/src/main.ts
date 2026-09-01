import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { GatewayEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<GatewayEnv, true>>(ConfigService);

  const globalPrefix = config.get('API_GLOBAL_PREFIX', { infer: true });
  app.setGlobalPrefix(globalPrefix);

  // See the long note in apps/auth/src/main.ts for what each option does.
  // Both services validate independently: the gateway rejects malformed input
  // one hop early, and the Auth Service never trusts its caller.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.get('API_GATEWAY_PORT', { infer: true });
  await app.listen(port);

  Logger.log(
    `api gateway listening on http://localhost:${port}/${globalPrefix}`,
    'Bootstrap',
  );
}

void bootstrap();
