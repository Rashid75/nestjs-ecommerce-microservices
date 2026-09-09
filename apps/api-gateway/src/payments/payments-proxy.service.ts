import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PageMetaDto,
  PaymentDto,
} from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

export interface PaymentListResponse {
  data: PaymentDto[];
  meta: PageMetaDto;
}

/**
 * Forwards payment calls to the Payment Service.
 *
 * Nothing here inspects the body, and that is deliberate: the gateway should
 * not become a second place that knows what a payment looks like. It
 * authenticates, adds `X-User-Id`, forwards, and relays the answer —
 * including a 402, which `UpstreamProxy` passes through unchanged because a
 * declined card must reach the client as a decline.
 */
@Injectable()
export class PaymentsProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Payment service');
  }

  private headers(
    userId: string,
    idempotencyKey?: string,
  ): Record<string, string> {
    return {
      'x-user-id': userId,
      ...(idempotencyKey === undefined
        ? {}
        : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
    };
  }

  /**
   * Passes the `Idempotency-Key` straight through.
   *
   * A gateway that dropped it would silently disable the protection: the
   * charge still works, and a retry charges the customer again — the exact
   * failure the header exists to prevent, made invisible by the one
   * component sitting between the client and the service.
   */
  async pay(
    userId: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ data: PaymentDto; status: number; replayed: boolean }> {
    const response = await this.forwardWithHeaders<PaymentDto>({
      method: 'POST',
      url: '/payments',
      data: body,
      headers: this.headers(userId, idempotencyKey),
    });

    return {
      data: response.data,
      status: response.status,
      replayed: response.headers[IDEMPOTENT_REPLAY_HEADER] === 'true',
    };
  }

  list(
    userId: string,
    query: Record<string, unknown>,
  ): Promise<PaymentListResponse> {
    return this.forward<PaymentListResponse>({
      method: 'GET',
      url: '/payments',
      params: query,
      headers: this.headers(userId),
    });
  }

  findOne(userId: string, paymentId: string): Promise<PaymentDto> {
    return this.forward<PaymentDto>({
      method: 'GET',
      url: `/payments/${paymentId}`,
      headers: this.headers(userId),
    });
  }
}
