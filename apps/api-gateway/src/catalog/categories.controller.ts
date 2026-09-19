import {
  CategoryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  UserRole,
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
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CatalogProxyService } from './catalog-proxy.service';

/**
 * The categories API. Reads public, writes admin-only — the same split as
 * products, and for the same reasons; see that controller.
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

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    return this.catalog.createCategory(dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    return this.catalog.updateCategory(id, dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.catalog.deleteCategory(id);
  }
}
