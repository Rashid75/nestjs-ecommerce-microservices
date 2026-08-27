import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CategoriesModule } from '../categories/categories.module';
import { productEnvSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { ProductsModule } from '../products/products.module';

/**
 * The Product Service root module.
 *
 * Same shape as the Auth Service: validated configuration first, then a
 * proven database connection, then the feature modules. A bad environment
 * variable kills the process at step one.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: productEnvSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      cache: true,
    }),
    DatabaseModule,
    ProductsModule,
    CategoriesModule,
  ],
})
export class AppModule {}
