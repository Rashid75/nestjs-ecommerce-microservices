import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ConfigService is populated from the validated environment, so by the time
  // we reach this line the configuration is known to be well formed.
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const port = config.get('http.port', { infer: true });
  const globalPrefix = config.get('http.globalPrefix', { infer: true });

  app.setGlobalPrefix(globalPrefix);
  await app.listen(port);

  Logger.log(
    `api-gateway is running on http://localhost:${port}/${globalPrefix}`,
    'Bootstrap',
  );
}

void bootstrap();
