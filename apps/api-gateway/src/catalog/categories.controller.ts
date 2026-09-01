import {
  CategoryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogProxyService } from './catalog-proxy.service';

/**
 * The PUBLIC categories API.
 *
 * Same authentication gap as products — see the note on
 * apps/api-gateway/src/catalog/products.controller.ts.
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly catalog: CatalogProxyService) {}

  @Get()
  findAll(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ): Promise<CategoryDto[]> {
    return this.catalog.listCategories(includeInactive === true);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CategoryDto> {
    return this.catalog.getCategory(id);
  }

  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    return this.catalog.createCategory(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    return this.catalog.updateCategory(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.catalog.deleteCategory(id);
  }
}
