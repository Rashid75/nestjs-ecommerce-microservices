import {
  AdjustStockDto,
  CreateInventoryDto,
  InventoryDto,
  StockMovementDto,
  StockOperationDto,
  UserRole,
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
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUserGuard } from '../common/authenticated-user.guard';
import { RateLimit } from '../common/rate-limit.decorator';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { InventoryProxyService } from './inventory-proxy.service';

/**
 * The PUBLIC stock API.
 *
 * EVERY WRITE IS ADMIN-ONLY as of Milestone 12. This was the worst of the
 * open endpoints: `receive` and `adjust` let a caller invent or destroy
 * stock outright, and `release` let one cancel someone else's reservation.
 *
 * Reads stay public — "how many are left" is shown on a product page.
 *
 * ONE THING THIS IS NOT. `reserve`, `release` and `fulfil` are really
 * SERVICE-TO-SERVICE operations: the Order Service should perform them, with
 * an identity of its own, not a human admin over the public API. Marking
 * them ADMIN is correct today (only an operator calls them) and is the wrong
 * shape tomorrow. Service identities — a client-credentials token, or mTLS
 * between services — are the proper answer and are deferred with that
 * trigger: the first time a service, rather than a person, needs to call
 * one of these.
 */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryProxyService) {}

  @Get(':productId')
  findOne(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<InventoryDto> {
    return this.inventory.get(productId);
  }

  @Get(':productId/movements')
  history(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<StockMovementDto[]> {
    return this.inventory.movements(productId);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post()
  create(@Body() dto: CreateInventoryDto): Promise<InventoryDto> {
    return this.inventory.create(dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post(':productId/receive')
  @HttpCode(HttpStatus.OK)
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
  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post(':productId/reserve')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, windowSeconds: 60, name: 'inventory:reserve' })
  reserve(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'reserve', dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post(':productId/release')
  @HttpCode(HttpStatus.OK)
  release(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'release', dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post(':productId/fulfil')
  @HttpCode(HttpStatus.OK)
  fulfil(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: StockOperationDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'fulfil', dto);
  }

  @UseGuards(AuthenticatedUserGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Post(':productId/adjust')
  @HttpCode(HttpStatus.OK)
  adjust(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<InventoryDto> {
    return this.inventory.operation(productId, 'adjust', dto);
  }
}
