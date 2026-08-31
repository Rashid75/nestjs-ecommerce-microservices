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
import { RateLimit } from '../common/rate-limit.decorator';
import { InventoryProxyService } from './inventory-proxy.service';

/**
 * The PUBLIC stock API.
 *
 * ⚠️ UNAUTHENTICATED, like the catalogue — and the exposure here is worse.
 *
 * `receive` and `adjust` let a caller invent or destroy stock outright.
 * `release` lets a caller cancel someone else's reservation. Until the RS256
 * / RBAC work lands, this must not be reachable from anywhere but localhost.
 *
 * Reads are public in a real storefront; writes belong to warehouse staff and
 * internal services. That split is exactly what `@Roles()` will express.
 */
@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryProxyService) {}

  @Get(':productId')
  @ApiOperation({ summary: 'Current stock position for a product' })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 404, description: 'No inventory for this product' })
  findOne(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<InventoryDto> {
    return this.inventory.get(productId);
  }

  @Get(':productId/movements')
  @ApiOperation({ summary: 'Recent ledger entries for a product' })
  @ApiResponse({ status: 200, type: [StockMovementDto] })
  history(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<StockMovementDto[]> {
    return this.inventory.movements(productId);
  }

  @Post()
  @ApiOperation({ summary: 'Register a product with the inventory system' })
  @ApiResponse({ status: 201, type: InventoryDto })
  create(@Body() dto: CreateInventoryDto): Promise<InventoryDto> {
    return this.inventory.create(dto);
  }

  @Post(':productId/receive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Goods arrived — increase on-hand stock' })
  @ApiResponse({ status: 200, type: InventoryDto })
  receive(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'receive', dto);
  }

  /**
   * A tighter budget than the global default, and for an unusual reason.
   *
   * This is not about protecting the server — the operation is one indexed
   * UPDATE. It is about INVENTORY EXHAUSTION as an attack: a script that
   * reserves stock it never intends to buy can make a product show as
   * out-of-stock to real customers, with no purchase and no payment. The
   * denial of service is against the BUSINESS, not the infrastructure.
   *
   * 30/minute lets a genuine shopper add items freely while making a
   * scripted sweep of the catalogue slow enough to notice. The real fix is
   * reservations with a short expiry plus per-user limits, which arrives
   * with the order workflow.
   */
  @Post(':productId/reserve')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, windowSeconds: 60, name: 'inventory:reserve' })
  @ApiOperation({
    summary: 'Promise stock to an order',
    description:
      'Concurrency-safe. Two simultaneous requests for the last unit cannot both succeed — the loser gets 409.',
  })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 409, description: 'Insufficient stock' })
  @ApiResponse({ status: 429, description: 'Too many reservation attempts' })
  reserve(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'reserve', dto);
  }

  @Post(':productId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a reservation' })
  @ApiResponse({ status: 200, type: InventoryDto })
  @ApiResponse({ status: 409, description: 'More requested than is reserved' })
  release(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'release', dto);
  }

  @Post(':productId/fulfil')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Shipped — reduce both on-hand and reserved' })
  @ApiResponse({ status: 200, type: InventoryDto })
  fulfil(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'fulfil', dto);
  }

  @Post(':productId/adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manual signed correction with a mandatory reason' })
  @ApiResponse({ status: 200, type: InventoryDto })
  adjust(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'adjust', dto);
  }
}
