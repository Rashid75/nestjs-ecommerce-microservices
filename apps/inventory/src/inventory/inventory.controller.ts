import {
  AdjustStockDto,
  CreateInventoryDto,
  InventoryDto,
  StockMovementDto,
  StockOperationDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';

/**
 * REST for stock.
 *
 * Note these are COMMANDS, not CRUD, and the routes say so:
 *
 *   POST /inventory/:productId/reserve
 *   POST /inventory/:productId/release
 *
 * That looks RPC-ish next to `PATCH /products/:id`, and it is the right
 * shape here. "Reserve three units" is not a partial update of a resource —
 * it is a request to perform a domain operation whose outcome depends on the
 * current state and may legitimately be refused. Expressing it as
 * `PATCH { reserved: 4 }` would be strictly worse: the client would have to
 * read the current value, add to it, and send an absolute number, which
 * reintroduces the read-modify-write race at the HTTP layer.
 *
 * The same reasoning is why the project plan lists `POST /orders/:id/cancel`.
 * State transitions get verbs.
 *
 * Every route returns the resulting stock position, so a client never has to
 * follow up with a GET to learn what happened.
 */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get(':productId')
  findOne(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<InventoryDto> {
    return this.inventory.findOne(productId);
  }

  @Get(':productId/movements')
  history(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<StockMovementDto[]> {
    return this.inventory.history(productId);
  }

  @Post()
  create(@Body() dto: CreateInventoryDto): Promise<InventoryDto> {
    return this.inventory.create(dto);
  }

  @Post(':productId/receive')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.receive(productId, dto);
  }

  @Post(':productId/reserve')
  @HttpCode(HttpStatus.OK)
  reserve(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.reserve(productId, dto);
  }

  @Post(':productId/release')
  @HttpCode(HttpStatus.OK)
  release(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.release(productId, dto);
  }

  @Post(':productId/fulfil')
  @HttpCode(HttpStatus.OK)
  fulfil(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.fulfil(productId, dto);
  }

  @Post(':productId/adjust')
  @HttpCode(HttpStatus.OK)
  adjust(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<InventoryDto> {
    return this.inventory.adjust(productId, dto);
  }
}
