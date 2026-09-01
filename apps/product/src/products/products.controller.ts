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
import { ProductsService } from './products.service';

/**
 * REST for products.
 *
 * The route shapes follow REST conventions rather than RPC habits:
 *
 *   GET    /products         list        NOT /getAllProducts
 *   GET    /products/:id     read one    NOT /getProduct?id=
 *   POST   /products         create      201 + the created resource
 *   PATCH  /products/:id     partial     NOT PUT — see below
 *   DELETE /products/:id     remove      204, empty body
 *
 * PATCH rather than PUT is a real decision, not a style preference. PUT
 * REPLACES a resource: fields you omit are cleared. A price update sent as
 * PUT with only `{ price }` would wipe the name and description. PATCH means
 * "change exactly what I sent", which is what an admin form almost always
 * wants.
 *
 * No business logic lives here, and no Sequelize. The controller accepts,
 * delegates, returns.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async findAll(
    @Query() query: QueryProductsDto,
    // `passthrough: true` lets us touch the response object while STILL
    // returning a value normally. Without it, Nest hands full control of the
    // response to the handler and the returned object is silently ignored —
    // the request just hangs. It is an easy hour to lose.
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedProductsDto> {
    const result = await this.products.findAll(query);
    res.setHeader('X-Cache', result.cacheHit ? 'HIT' : 'MISS');
    return result.data;
  }

  @Get(':id')
  async findOne(
    // ParseUUIDPipe rejects a malformed id with 400 BEFORE any query runs.
    // Without it, `/products/nonsense` reaches PostgreSQL and comes back as
    // a 500 from `invalid input syntax for type uuid` — an internal error
    // for what is plainly a client mistake.
    //
    // It now also protects the CACHE: an unvalidated id would become a Redis
    // key, so a scripted probe could fill the keyspace with junk.
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const result = await this.products.findOne(id);
    // The same header a CDN sets. It is what makes the cache observable —
    // and therefore verifiable — from the outside.
    res.setHeader('X-Cache', result.cacheHit ? 'HIT' : 'MISS');
    return result.data;
  }

  @Post()
  create(@Body() dto: CreateProductDto): Promise<ProductDto> {
    return this.products.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  // 204 No Content, with an empty body. Returning 200 with
  // `{ "deleted": true }` is a common habit and it is noise: the status code
  // already says what happened, and inventing a body means every client has
  // to parse one.
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.products.remove(id);
  }
}
