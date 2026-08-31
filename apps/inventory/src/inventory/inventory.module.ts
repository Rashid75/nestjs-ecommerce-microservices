import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { InventoryController } from './inventory.controller';
import { InventoryItem } from './inventory-item.model';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { StockMovement } from './stock-movement.model';

/**
 * Owns both tables, because they are one aggregate: a balance and the ledger
 * that explains it. Splitting them across modules would let one be written
 * without the other, which is precisely the state the repository's
 * transactions exist to prevent.
 */
@Module({
  imports: [SequelizeModule.forFeature([InventoryItem, StockMovement])],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
