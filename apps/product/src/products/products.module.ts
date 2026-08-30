import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Category } from '../categories/category.model';
import { Product } from './product.model';
import { ProductsCacheService } from './products-cache.service';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * Owns the `products` table.
 *
 * `forFeature` registers Category as well as Product because the repository
 * JOINs to it. Registering a model does NOT grant write access to another
 * module's data — nothing here mutates categories — it only makes the
 * association resolvable so `include: [Category]` works.
 *
 * Only the repository is exported. CategoriesService needs `countByCategory`
 * before it soft-deletes; it does not need the model.
 */
@Module({
  imports: [SequelizeModule.forFeature([Product, Category])],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository, ProductsCacheService],
  exports: [ProductsRepository],
})
export class ProductsModule {}
