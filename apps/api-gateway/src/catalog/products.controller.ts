import {
  CreateProductDto,
  PaginatedProductsDto,
  ProductDto,
  QueryProductsDto,
  UpdateProductDto,
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
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CatalogProxyService } from './catalog-proxy.service';

/**
 * The products API. READS ARE PUBLIC; WRITES ARE ADMIN-ONLY.
 *
 * That split is the point, and it is why the guards are per-method rather
 * than on the class. A storefront's catalogue is meant to be browsed by
 * anyone, including a crawler with no account — putting a guard on the
 * controller would break the shop to protect the four endpoints that
 * actually need it.
 *
 * CLOSED IN MILESTONE 12, after standing open since M3. It was open because
 * of a genuine dependency rather than neglect: under HS256 the gateway could
 * not check a token without holding a key that could also MINT one. RS256
 * removed that obstacle, and this is the change it unblocked.
 *
 * Note what is NOT here: a product-level ownership check. There are no
 * per-seller catalogues in this system, so "is this your product" is not a
 * question that exists. When it does, it belongs in the Product Service —
 * the gateway knows who is asking, not what they own.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogProxyService) {}

  @Get()
  async findAll(
    @Query() query: QueryProductsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedProductsDto> {
    const result = await this.catalog.listProducts(query);
    relayCacheHeader(res, result.headers);
    return result.data;
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const result = await this.catalog.getProduct(id);
    relayCacheHeader(res, result.headers);
    return result.data;
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post()
  create(@Body() dto: CreateProductDto): Promise<ProductDto> {
    return this.catalog.createProduct(dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.catalog.updateProduct(id, dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.catalog.deleteProduct(id);
  }
}

/**
 * Passes the Product Service's X-Cache verdict through to the client.
 *
 * The gateway does not cache anything itself in this milestone, so it has no
 * opinion of its own — it reports what the upstream said. When gateway-level
 * caching arrives the two would need combining (a CDN would show
 * `X-Cache: HIT, MISS` for a chain), which is exactly why the header is a
 * chain of hops rather than a single boolean.
 */
function relayCacheHeader(
  res: Response,
  headers: Record<string, string>,
): void {
  const value = headers['x-cache'];
  if (value !== undefined) {
    res.setHeader('X-Cache', value);
  }
}
