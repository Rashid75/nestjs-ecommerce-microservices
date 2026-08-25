import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GatewayEnv } from '../config/env.validation';
import { AuthProxyService } from './auth-proxy.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    // registerAsync so baseURL and timeout come from validated configuration
    // rather than being hardcoded. Hardcoding `http://localhost:3001` works
    // until the day it runs in a container, where localhost is the container
    // itself and the call fails with a connection refused that looks like the
    // Auth Service crashed.
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) => ({
        baseURL: config.get('AUTH_SERVICE_URL', { infer: true }),

        // Applies to every request made through this HttpService. An outbound
        // call with no deadline is how one slow dependency exhausts the
        // gateway's own capacity and takes healthy routes down with it.
        timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),

        // `validateStatus` is deliberately left at the axios default, which
        // throws on 4xx and 5xx. Setting `validateStatus: () => true` — a
        // common suggestion — would turn a 500 from Auth into a *successful*
        // gateway response carrying an error body, and clients would see 200.
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthProxyService],
})
export class AuthModule {}
