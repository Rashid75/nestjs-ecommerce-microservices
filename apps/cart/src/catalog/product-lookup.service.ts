import { correlationHeaders } from '@ecommerce/observability';
import { ProductDto, ProductStatus } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

export interface ProductSnapshot {
  productId: string;
  sku: string;
  name: string;
  unitPrice: string;
  currency: string;
}

/**
 * Reads a product from the Product Service so the cart can snapshot it.
 *
 * THE FIRST SERVICE-TO-SERVICE CALL IN THIS SYSTEM that does not go through
 * the gateway. Everything until now was Gateway → Service. This is
 * Service → Service, and it introduces problems the gateway hop did not:
 *
 *   COUPLING. Adding to a cart now fails if the Product Service is down.
 *   That is a genuine availability cost, accepted because the alternative is
 *   worse: trusting a client-supplied price. The blast radius is contained —
 *   READING a cart never calls Product, because everything needed is already
 *   snapshotted. Only ADD does.
 *
 *   LATENCY ADDS UP. Every synchronous hop is added to the customer's wait
 *   and multiplies the failure probability. Two services at 99.9% chained
 *   synchronously give 99.8%.
 *
 *   NO DISTRIBUTED TRANSACTION. If the cart write fails after this read
 *   succeeded, nothing needs undoing — a read has no side effect. That is
 *   why this is safe to do synchronously and why reserving stock (which does
 *   have a side effect) will need a Saga in Milestone 8.
 *
 * WHY NOT AN EVENT INSTEAD? The Cart Service could subscribe to
 * ProductPriceChanged and keep a local replica, removing the synchronous
 * call entirely. That is the right answer at scale, and it costs a
 * projection to maintain, a backfill, and eventual-consistency bugs when the
 * replica lags. It arrives when RabbitMQ does — not before there is a
 * reason.
 */
@Injectable()
export class ProductLookupService {
  private readonly logger = new Logger(ProductLookupService.name);

  constructor(private readonly http: HttpService) {}

  /**
   * Fetches a product and returns the fields worth snapshotting.
   *
   * Throws BadRequestException for "no such product" and
   * ServiceUnavailableException when the Product Service cannot be reached.
   * Distinguishing those matters: the first is the client's fault and will
   * never succeed on retry; the second is ours and probably will.
   */
  async fetchSnapshot(productId: string): Promise<ProductSnapshot> {
    let product: ProductDto;

    try {
      const response = await firstValueFrom(
        this.http.get<ProductDto>(`/products/${productId}`, {
          headers: correlationHeaders(),
        }),
      );
      product = response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response?.status === 404) {
        throw new BadRequestException(`Product ${productId} does not exist`);
      }

      this.logger.error(
        `product lookup failed for ${productId}: ${axiosError.code ?? axiosError.message}`,
      );
      throw new ServiceUnavailableException(
        'Cannot add to cart right now — the catalogue is unavailable',
      );
    }

    // A DRAFT or ARCHIVED product is not purchasable. Checking here rather
    // than trusting the caller means an out-of-catalogue item cannot enter a
    // cart through a stale link or a scripted request.
    //
    // Note this is a point-in-time check: a product archived AFTER it is in
    // a cart stays there. That is deliberate — silently removing a line
    // would be worse than showing it and refusing at checkout — and it is
    // another thing the order workflow re-validates.
    if (product.status !== ProductStatus.Active) {
      throw new BadRequestException(
        `Product ${product.sku} is not available for purchase`,
      );
    }

    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      // Already an exact decimal string from the Product Service. It stays a
      // string the whole way into the database — it never round-trips
      // through a float.
      unitPrice: product.price,
      currency: product.currency,
    };
  }
}
