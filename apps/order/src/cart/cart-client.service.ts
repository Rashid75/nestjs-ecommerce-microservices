import { correlationHeaders } from '@ecommerce/observability';
import { CartDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

/**
 * Reads the customer's cart, as the Cart Service sees it.
 *
 * A READ, and that is what makes this version of checkout simple. It changes
 * nothing in the other service, so if writing the order fails afterwards
 * there is nothing over there to undo. Every step of a workflow that has no
 * side effect is a compensation you never have to write.
 *
 * Note the direction: Order → Cart. The Cart Service does not know the Order
 * Service exists, and it stays that way. A cart that called into orders
 * would make the dependency cyclic, and a cycle between services is a
 * distributed monolith with extra network hops.
 *
 * THE COUPLING IS REAL AND ACCEPTED. Placing an order now fails if the Cart
 * Service is down. The alternative is trusting a client-supplied list of
 * lines and prices, which is worse in a way no amount of uptime fixes.
 */
@Injectable()
export class CartClientService {
  private readonly logger = new Logger(CartClientService.name);

  constructor(private readonly http: HttpService) {}

  /**
   * `GET /cart` on behalf of a user.
   *
   * The user id travels as `X-User-Id`, the same internal convention the
   * gateway uses. The Cart Service trusts that header because it listens on
   * loopback only — see the long note in
   * apps/cart/src/cart/current-user.decorator.ts. That trust boundary now
   * has a second caller, which raises its price rather than changing its
   * nature.
   */
  async fetchActiveCart(userId: string): Promise<CartDto> {
    try {
      const response = await firstValueFrom(
        this.http.get<CartDto>('/cart', {
          headers: { 'x-user-id': userId, ...correlationHeaders() },
        }),
      );
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      this.logger.error(
        `cart lookup failed for user ${userId}: ${axiosError.code ?? axiosError.message}`,
      );

      // No 404 branch: `GET /cart` creates an empty cart when there is none,
      // so "no cart" arrives as an empty item list rather than an error. The
      // service treats an empty cart as a client mistake — a 400 — which is
      // a very different thing from the Cart Service being unreachable.
      throw new ServiceUnavailableException(
        'Cannot place an order right now — the cart service is unavailable',
      );
    }
  }
}
