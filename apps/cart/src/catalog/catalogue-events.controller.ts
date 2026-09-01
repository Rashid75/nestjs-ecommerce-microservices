import {
  EventPattern as Events,
  ProductArchivedPayload,
  ProductPriceChangedPayload,
} from '@ecommerce/contracts';
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectModel } from '@nestjs/sequelize';
import { CartItem } from '../cart/cart-item.model';

/**
 * Reacts to catalogue events.
 *
 * A CONTROLLER, not a service — and that is the idea worth taking away.
 *
 * In NestJS a controller is "the thing requests arrive at". An HTTP
 * controller uses `@Get`/`@Post`; a message controller uses
 * `@EventPattern`/`@MessagePattern`. Same class, same dependency injection,
 * same pipes and guards — only the transport differs. Nest deliberately
 * makes a queue look like another kind of inbound request.
 *
 * `@EventPattern` vs `@MessagePattern`:
 *
 *   @EventPattern    fire and forget. The publisher used `emit()` and is not
 *                    waiting. Return nothing. THIS is what an event needs.
 *   @MessagePattern  request/response. The publisher used `send()` and is
 *                    waiting for what you return. That is a COMMAND, and we
 *                    will use it when we specifically learn RPC.
 *
 * The string passed to `@EventPattern` must match the one passed to `emit()`
 * exactly — which is why both come from `@ecommerce/contracts` rather than
 * being typed out twice.
 *
 * (The contracts export is aliased to `Events` here because
 * `@nestjs/microservices` also exports something called `EventPattern` — the
 * decorator. Two different things, same name.)
 */
@Controller()
export class CatalogueEventsController {
  private readonly logger = new Logger(CatalogueEventsController.name);

  constructor(@InjectModel(CartItem) private readonly items: typeof CartItem) {}

  /**
   * Flags every cart line holding this product.
   *
   * Note what it does NOT do: overwrite `unitPrice`. The snapshot is what
   * the customer was shown, and quietly changing it would make a basket
   * total move while they are looking at it — exactly what snapshotting
   * exists to prevent. The flag lets the UI explain, and lets checkout ask
   * the customer to re-confirm.
   *
   * One bulk UPDATE rather than a read-then-write loop: a single statement
   * touches every affected line across every cart.
   */
  @EventPattern(Events.ProductPriceChanged)
  async onPriceChanged(
    @Payload() payload: ProductPriceChangedPayload,
  ): Promise<void> {
    const [affected] = await this.items.update(
      { cataloguePrice: payload.newPrice },
      { where: { productId: payload.productId } },
    );

    if (affected > 0) {
      this.logger.log(
        `${payload.sku}: ${payload.previousPrice} → ${payload.newPrice}, flagged ${affected} cart line(s)`,
      );
    }
  }

  /**
   * Marks lines unavailable when a product is archived.
   *
   * The line STAYS in the cart. Silently removing an item is more alarming
   * to a customer than showing it greyed out with a reason.
   */
  @EventPattern(Events.ProductArchived)
  async onArchived(@Payload() payload: ProductArchivedPayload): Promise<void> {
    const [affected] = await this.items.update(
      { unavailableAt: new Date() },
      { where: { productId: payload.productId } },
    );

    if (affected > 0) {
      this.logger.log(
        `${payload.sku}: archived, flagged ${affected} cart line(s) unavailable`,
      );
    }
  }
}
