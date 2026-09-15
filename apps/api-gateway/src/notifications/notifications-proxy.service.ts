import { correlationHeaders } from '@ecommerce/observability';
import { NotificationDto, PageMetaDto } from '@ecommerce/contracts';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { UpstreamProxy } from '../common/upstream-proxy';

export interface NotificationListResponse {
  data: NotificationDto[];
  meta: PageMetaDto;
}

/** Forwards the one read endpoint the Notification Service exposes. */
@Injectable()
export class NotificationsProxyService extends UpstreamProxy {
  constructor(http: HttpService) {
    super(http, 'Notification service');
  }

  list(
    userId: string,
    query: Record<string, unknown>,
  ): Promise<NotificationListResponse> {
    return this.forward<NotificationListResponse>({
      method: 'GET',
      url: '/notifications',
      params: query,
      headers: { 'x-user-id': userId, ...correlationHeaders() },
    });
  }
}
