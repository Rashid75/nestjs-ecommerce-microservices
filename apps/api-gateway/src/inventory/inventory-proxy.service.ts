import { InventoryDto, StockMovementDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

/**
 * Forwards stock calls to the Inventory Service.
 *
 * Nothing here knows about row locks, ledgers or isolation levels — which is
 * the point. The gateway routes; the service owns the hard part.
 */
@Injectable()
export class InventoryProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Inventory service');
  }

  get(productId: string): Promise<InventoryDto> {
    return this.forward<InventoryDto>({
      method: 'GET',
      url: `/inventory/${productId}`,
    });
  }

  movements(productId: string): Promise<StockMovementDto[]> {
    return this.forward<StockMovementDto[]>({
      method: 'GET',
      url: `/inventory/${productId}/movements`,
    });
  }

  create(body: unknown): Promise<InventoryDto> {
    return this.forward<InventoryDto>({
      method: 'POST',
      url: '/inventory',
      data: body,
    });
  }

  /** receive | reserve | release | fulfil | adjust */
  operation(
    productId: string,
    action: string,
    body: unknown,
  ): Promise<InventoryDto> {
    return this.forward<InventoryDto>({
      method: 'POST',
      url: `/inventory/${productId}/${action}`,
      data: body,
    });
  }
}
