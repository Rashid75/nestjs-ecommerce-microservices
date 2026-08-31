import { CartDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

/**
 * Forwards cart calls to the Cart Service.
 *
 * Every method takes a `userId` and sends it as `X-User-Id`. The Cart
 * Service never sees the access token and never verifies anything — the
 * gateway has already established who the caller is, and the internal
 * service trusts that because it listens on loopback only.
 *
 * That trust is the weak point, and it is documented at both ends: see
 * apps/cart/src/cart/current-user.decorator.ts for how production closes it
 * (shared secret, mTLS, service mesh, or RS256 internal tokens).
 */
@Injectable()
export class CartProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Cart service');
  }

  private headers(userId: string): Record<string, string> {
    return { 'x-user-id': userId };
  }

  getCart(userId: string): Promise<CartDto> {
    return this.forward<CartDto>({
      method: 'GET',
      url: '/cart',
      headers: this.headers(userId),
    });
  }

  addItem(userId: string, body: unknown): Promise<CartDto> {
    return this.forward<CartDto>({
      method: 'POST',
      url: '/cart/items',
      data: body,
      headers: this.headers(userId),
    });
  }

  updateItem(
    userId: string,
    productId: string,
    body: unknown,
  ): Promise<CartDto> {
    return this.forward<CartDto>({
      method: 'PATCH',
      url: `/cart/items/${productId}`,
      data: body,
      headers: this.headers(userId),
    });
  }

  removeItem(userId: string, productId: string): Promise<CartDto> {
    return this.forward<CartDto>({
      method: 'DELETE',
      url: `/cart/items/${productId}`,
      headers: this.headers(userId),
    });
  }

  clear(userId: string): Promise<CartDto> {
    return this.forward<CartDto>({
      method: 'DELETE',
      url: '/cart',
      headers: this.headers(userId),
    });
  }
}
