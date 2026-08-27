import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProductsModule } from '../products/products.module';
import { CategoriesController } from './categories.controller';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';
import { Category } from './category.model';

/**
 * Owns the `categories` table.
 *
 * Imports ProductsModule for the reference count in
 * CategoriesService.remove(). The dependency runs one way only —
 * ProductsModule imports nothing from here — so there is no circular
 * module reference and no need for forwardRef().
 */
@Module({
  imports: [SequelizeModule.forFeature([Category]), ProductsModule],
  controllers: [CategoriesController],
  providers: [CategoriesService, CategoriesRepository],
  exports: [CategoriesRepository],
})
export class CategoriesModule {}
