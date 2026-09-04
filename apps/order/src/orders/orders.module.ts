import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { CartClientModule } from '../cart/cart-client.module';
import { OrderItem } from './order-item.model';
import { Order } from './order.model';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Orders and their lines.
 *
 * Both tables are one aggregate: a sale and what was in it. Nothing outside
 * this module writes either of them.
 */
@Module({
  imports: [SequelizeModule.forFeature([Order, OrderItem]), CartClientModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
