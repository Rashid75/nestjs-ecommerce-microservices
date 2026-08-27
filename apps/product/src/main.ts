import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';
import type { ProductEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<ProductEnv, true>>(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Needed by every query DTO in this service.
      //
      // A query string is all strings: `?page=2&limit=50` arrives as
      // { page: "2", limit: "50" }. Without transformer options, the
      // `@Type(() => Number)` decorators on PaginationQueryDto never run and
      // `@IsInt()` rejects "2" as not an integer.
      //
      // `enableImplicitConversion` stays OFF: it would coerce ANY field
      // toward its declared type, so `?page=abc` becomes NaN rather than a
      // 400. Explicit @Type is the safer half of that feature.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Product Service (internal)')
    .setDescription(
      'Internal service. Public traffic goes through the API Gateway.',
    )
    .setVersion('1.0')
    .build();

  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = config.get('PRODUCT_SERVICE_PORT', { infer: true });

  // Loopback only, like the Auth Service. Internal services are reachable
  // from the gateway and from nothing else.
  await app.listen(port, '127.0.0.1');

  Logger.log(
    `product service listening on http://127.0.0.1:${port} (docs: /docs)`,
    'Bootstrap',
  );
}

void bootstrap();
