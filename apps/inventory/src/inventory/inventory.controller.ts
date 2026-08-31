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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get(':productId')
  @ApiOperation({ summary: 'Current stock position for a product' })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 404, description: 'No inventory for this product' })
  findOne(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<InventoryDto> {
    return this.inventory.findOne(productId);
  }

  @Get(':productId/movements')
  @ApiOperation({
    summary: 'Recent ledger entries for a product',
    description:
      'The append-only history behind the balance. A balance with no history cannot be audited or reconciled against a physical count.',
  })
  @ApiResponse({ status: 200, type: [StockMovementDto] })
  @ApiResponse({ status: 404, description: 'No inventory for this product' })
  history(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<StockMovementDto[]> {
    return this.inventory.history(productId);
  }

  @Post()
  @ApiOperation({ summary: 'Register a product with the inventory system' })
  @ApiResponse({ status: 201, type: InventoryDto })
  @ApiResponse({ status: 409, description: 'Inventory already exists' })
  create(@Body() dto: CreateInventoryDto): Promise<InventoryDto> {
    return this.inventory.create(dto);
  }

  @Post(':productId/receive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Goods arrived — increase on-hand stock',
    description: 'Cannot fail on availability; receiving only ever adds.',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 404, description: 'No inventory for this product' })
  receive(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.receive(productId, dto);
  }

  @Post(':productId/reserve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promise stock to an order',
    description:
      'Concurrency-safe: the availability check and the write are ONE atomic statement, so two simultaneous requests for the last unit cannot both succeed. The loser gets 409.',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 404, description: 'No inventory for this product' })
  @ApiResponse({
    status: 409,
    description:
      'Insufficient stock. The body reports requested and available — a retry may succeed once other reservations are released.',
  })
  reserve(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.reserve(productId, dto);
  }

  @Post(':productId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a reservation — abandoned cart, cancelled order',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 409, description: 'More requested than is reserved' })
  release(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.release(productId, dto);
  }

  @Post(':productId/fulfil')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The goods shipped — reduce BOTH on-hand and reserved',
    description:
      'The only operation that reduces on-hand in the normal flow. Reserving does not, because until an item ships it is still physically on the shelf.',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 409, description: 'Not enough reserved or on hand' })
  fulfil(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.fulfil(productId, dto);
  }

  @Post(':productId/adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manual signed correction with a mandatory reason',
    description:
      'Refused if it would leave more reserved than on hand — writing off damage must not invalidate promises already made to customers.',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({
    status: 409,
    description: 'Adjustment would break the invariant',
  })
  adjust(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<InventoryDto> {
    return this.inventory.adjust(productId, dto);
  }
}
