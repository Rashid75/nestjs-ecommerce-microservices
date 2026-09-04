import { OrderDto, PageMetaDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

export interface OrderListResponse {
  data: OrderDto[];
  meta: PageMetaDto;
}

/**
 * Forwards order calls to the Order Service.
 *
 * Every method takes a `userId` and sends it as `X-User-Id`. The Order
 * Service never sees the access token and verifies nothing — the gateway has
 * already established who the caller is, and the internal service trusts
 * that because it listens on loopback only.
 */
@Injectable()
export class OrdersProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Order service');
  }

  private headers(userId: string): Record<string, string> {
    return { 'x-user-id': userId };
  }

  create(userId: string, body: unknown): Promise<OrderDto> {
    return this.forward<OrderDto>({
      method: 'POST',
      url: '/orders',
      data: body,
      headers: this.headers(userId),
    });
  }

  list(
    userId: string,
    query: Record<string, unknown>,
  ): Promise<OrderListResponse> {
    return this.forward<OrderListResponse>({
      method: 'GET',
      url: '/orders',
      params: query,
      headers: this.headers(userId),
    });
  }

  findOne(userId: string, orderId: string): Promise<OrderDto> {
    return this.forward<OrderDto>({
      method: 'GET',
      url: `/orders/${orderId}`,
      headers: this.headers(userId),
    });
  }

  cancel(userId: string, orderId: string, body: unknown): Promise<OrderDto> {
    return this.forward<OrderDto>({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      data: body,
      headers: this.headers(userId),
    });
  }
}
