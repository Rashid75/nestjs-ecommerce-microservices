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
import { CategoriesService } from './categories.service';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /**
   * Unpaginated on purpose — categories are a small, bounded set, and a
   * navigation menu wants all of them at once.
   *
   * That decision has a trigger for revisiting: if this deployment ever has
   * hundreds of categories, or nesting arrives, it needs the same pagination
   * treatment products got.
   */
  @Get()
  @ApiOperation({ summary: 'List categories' })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'Admin views pass true. Storefronts should not.',
  })
  @ApiResponse({ status: 200, type: [CategoryDto] })
  findAll(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ): Promise<CategoryDto[]> {
    return this.categories.findAll(includeInactive === true);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one category' })
  @ApiResponse({ status: 200, type: CategoryDto })
  @ApiResponse({ status: 404, description: 'Category not found' })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CategoryDto> {
    return this.categories.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, type: CategoryDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'name or slug already in use' })
  create(@Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update a category' })
  @ApiResponse({ status: 200, type: CategoryDto })
  @ApiResponse({ status: 404, description: 'Category not found' })
  @ApiResponse({ status: 409, description: 'name or slug already in use' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete a category',
    description:
      'Refused with 409 while any product still references it. ON DELETE RESTRICT does not cover a soft delete, so the check is explicit.',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  @ApiResponse({ status: 409, description: 'Category still has products' })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.categories.remove(id);
  }
}
