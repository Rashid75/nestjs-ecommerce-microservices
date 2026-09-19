import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '../common/authentication.module';
import type { GatewayEnv } from '../config/env.validation';
import { CatalogProxyService } from './catalog-proxy.service';
import { CategoriesController } from './categories.controller';
import { ProductsController } from './products.controller';

/**
 * A SECOND HttpModule instance, with its own baseURL.
 *
 * HttpModule is not global, so each feature module that imports it gets its
 * own configured axios instance. That is exactly what we want: the auth
 * proxy must be unable to accidentally call the product service, and each
 * upstream can carry its own timeout as their latency profiles diverge.
 */
@Module({
  imports: [
    // Brings in the guards AND the things they inject. Nest builds a guard
    // instance in the context of the module that declares the CONTROLLER, so
    // importing this is what makes `@UseGuards(AuthenticatedUserGuard)`
    // resolvable here at all — without it the failure is at startup, which
    // is the right time for it.
    AuthenticationModule,
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('PRODUCT_SERVICE_URL', { infer: true }),
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
      }),
    }),
  ],
  controllers: [ProductsController, CategoriesController],
  providers: [CatalogProxyService],
})
export class CatalogModule {}
