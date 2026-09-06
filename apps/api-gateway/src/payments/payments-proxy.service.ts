import { PageMetaDto, PaymentDto } from '@ecommerce/contracts';
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

  private headers(userId: string): Record<string, string> {
    return { 'x-user-id': userId };
  }

  pay(userId: string, body: unknown): Promise<PaymentDto> {
    return this.forward<PaymentDto>({
      method: 'POST',
      url: '/payments',
      data: body,
      headers: this.headers(userId),
    });
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
