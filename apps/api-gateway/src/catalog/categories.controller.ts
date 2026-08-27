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
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogProxyService } from './catalog-proxy.service';

/**
 * The PUBLIC categories API.
 *
 * Same authentication gap as products — see the note on
 * apps/api-gateway/src/catalog/products.controller.ts.
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly catalog: CatalogProxyService) {}

  @Get()
  @ApiOperation({ summary: 'List categories' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @ApiResponse({ status: 200, type: [CategoryDto] })
  findAll(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ): Promise<CategoryDto[]> {
    return this.catalog.listCategories(includeInactive === true);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one category' })
  @ApiResponse({ status: 200, type: CategoryDto })
  @ApiResponse({ status: 404, description: 'Category not found' })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CategoryDto> {
    return this.catalog.getCategory(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, type: CategoryDto })
  @ApiResponse({ status: 409, description: 'name or slug already in use' })
  create(@Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    return this.catalog.createCategory(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update a category' })
  @ApiResponse({ status: 200, type: CategoryDto })
  @ApiResponse({ status: 404, description: 'Category not found' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    return this.catalog.updateCategory(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a category' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 409, description: 'Category still has products' })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.catalog.deleteCategory(id);
  }
}
