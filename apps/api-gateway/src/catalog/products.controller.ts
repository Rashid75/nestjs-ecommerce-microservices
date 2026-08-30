import {
  CreateProductDto,
  PaginatedProductsDto,
  ProductDto,
  QueryProductsDto,
  UpdateProductDto,
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
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogProxyService } from './catalog-proxy.service';

/**
 * The PUBLIC products API.
 *
 * ⚠️ WRITE ENDPOINTS ARE CURRENTLY UNAUTHENTICATED.
 *
 * Anyone who can reach this gateway can create, edit and delete products.
 * That is a real gap, and it is deliberate rather than overlooked — closing
 * it properly needs a decision this milestone does not own:
 *
 *   - Verifying tokens AT THE GATEWAY means giving the gateway the HS256
 *     signing key. A key that can verify an HS256 token can also mint one,
 *     so every service holding it becomes able to issue admin tokens. The
 *     clean version needs RS256: Auth keeps the private key, everyone else
 *     gets the public one.
 *   - Verifying tokens IN THE PRODUCT SERVICE has the same problem.
 *   - Asking the Auth Service to introspect each token avoids key sharing
 *     but adds a round trip to every request.
 *
 * Role-based access control and the RS256 switch are scheduled together.
 * Until then this service must not be exposed beyond localhost.
 */
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogProxyService) {}

  @Get()
  @ApiOperation({
    summary: 'List products with pagination, filtering and sorting',
    description:
      'Example: `/api/products?search=thinkpad&status=ACTIVE&minPrice=500&sortBy=price&sortOrder=asc&page=1&limit=20`',
  })
  @ApiResponse({ status: 200, type: PaginatedProductsDto })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  @ApiResponse({ status: 503, description: 'Product service unavailable' })
  async findAll(
    @Query() query: QueryProductsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedProductsDto> {
    const result = await this.catalog.listProducts(query);
    relayCacheHeader(res, result.headers);
    return result.data;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one product, with its category' })
  @ApiResponse({ status: 200, type: ProductDto })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const result = await this.catalog.getProduct(id);
    relayCacheHeader(res, result.headers);
    return result.data;
  }

  @Post()
  @ApiOperation({ summary: 'Create a product' })
  @ApiResponse({ status: 201, type: ProductDto })
  @ApiResponse({ status: 409, description: 'SKU already in use' })
  create(@Body() dto: CreateProductDto): Promise<ProductDto> {
    return this.catalog.createProduct(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update a product' })
  @ApiResponse({ status: 200, type: ProductDto })
  @ApiResponse({ status: 404, description: 'Product not found' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.catalog.updateProduct(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a product' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
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
