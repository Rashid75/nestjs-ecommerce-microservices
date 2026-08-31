import {
  AdjustStockDto,
  CreateInventoryDto,
  InventoryDto,
  StockMovementDto,
  StockOperationDto,
} from '@ecommerce/contracts';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  InsufficientStockError,
  InventoryNotFoundError,
  InventoryRecord,
  InventoryRepository,
  MovementRecord,
} from './inventory.repository';

/** How many ledger entries a history request returns. */
const MOVEMENT_PAGE_SIZE = 50;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly inventory: InventoryRepository) {}

  async create(dto: CreateInventoryDto): Promise<InventoryDto> {
    try {
      const created = await this.inventory.create(
        dto.productId,
        dto.sku,
        dto.onHand ?? 0,
      );
      this.logger.log(`registered inventory for product ${created.productId}`);
      return toDto(created);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        throw new ConflictException(
          `Inventory already exists for product ${dto.productId}`,
        );
      }
      throw error;
    }
  }

  async findOne(productId: string): Promise<InventoryDto> {
    const found = await this.inventory.findByProductId(productId);
    if (found === null) {
      throw new NotFoundException(`No inventory for product ${productId}`);
    }
    return toDto(found);
  }

  async history(productId: string): Promise<StockMovementDto[]> {
    const item = await this.inventory.findByProductId(productId);
    if (item === null) {
      throw new NotFoundException(`No inventory for product ${productId}`);
    }
    const movements = await this.inventory.findMovements(
      item.id,
      MOVEMENT_PAGE_SIZE,
    );
    return movements.map(toMovementDto);
  }

  receive(productId: string, dto: StockOperationDto): Promise<InventoryDto> {
    return this.run(() =>
      this.inventory.receive(productId, dto.quantity, dto.reference ?? null),
    );
  }

  /**
   * The operation everything else exists to protect.
   *
   * All the concurrency work lives one layer down, in a single atomic
   * statement — which is exactly where it belongs. A service method that
   * looked like "check availability, then reserve" would be reintroducing
   * the race the repository was written to close.
   */
  reserve(productId: string, dto: StockOperationDto): Promise<InventoryDto> {
    return this.run(() =>
      this.inventory.reserve(productId, dto.quantity, dto.reference ?? null),
    );
  }

  release(productId: string, dto: StockOperationDto): Promise<InventoryDto> {
    return this.run(() =>
      this.inventory.release(productId, dto.quantity, dto.reference ?? null),
    );
  }

  fulfil(productId: string, dto: StockOperationDto): Promise<InventoryDto> {
    return this.run(() =>
      this.inventory.fulfil(productId, dto.quantity, dto.reference ?? null),
    );
  }

  adjust(productId: string, dto: AdjustStockDto): Promise<InventoryDto> {
    return this.run(() =>
      this.inventory.adjust(productId, dto.delta, dto.reason),
    );
  }

  /**
   * One place that turns domain errors into HTTP errors.
   *
   *   InventoryNotFoundError  → 404. We have never heard of this product.
   *   InsufficientStockError  → 409. We have heard of it and the answer is
   *                             no, because the current state conflicts with
   *                             what you asked for.
   *
   * 409 rather than 400 matters: 400 says "your request was malformed", and
   * this request was perfectly well formed. It failed because of a race the
   * client lost, and a client that reads 409 knows retrying may work — while
   * retrying a 400 never will.
   */
  private async run(
    operation: () => Promise<InventoryRecord>,
  ): Promise<InventoryDto> {
    try {
      return toDto(await operation());
    } catch (error) {
      if (error instanceof InventoryNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof InsufficientStockError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'Insufficient stock',
          requested: error.requested,
          available: error.available,
        });
      }
      throw error;
    }
  }
}

function toDto(record: InventoryRecord): InventoryDto {
  return {
    id: record.id,
    productId: record.productId,
    sku: record.sku,
    onHand: record.onHand,
    reserved: record.reserved,
    available: record.available,
    updatedAt: record.updatedAt,
  };
}

function toMovementDto(record: MovementRecord): StockMovementDto {
  return {
    id: record.id,
    type: record.type,
    quantity: record.quantity,
    reference: record.reference,
    onHandAfter: record.onHandAfter,
    reservedAfter: record.reservedAfter,
    createdAt: record.createdAt,
  };
}
