import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AuthenticatedUserGuard } from './authenticated-user.guard';
import { AUTH_HTTP_CLIENT } from './authentication.tokens';
import type { GatewayEnv } from '../config/env.validation';

/**
 * Provides AuthenticatedUserGuard and the axios instance it talks to Auth
 * with.
 *
 * WHY A NAMED TOKEN RATHER THAN HttpModule — learned the hard way.
 *
 * `@UseGuards(SomeGuard)` does NOT reuse the instance exported by the module
 * that provides it. Nest builds the guard in the context of the module that
 * declares the CONTROLLER — here, CartModule.
 *
 * The first attempt imported HttpModule in this module with the Auth base URL
 * and had the guard inject a bare `HttpService`. CartModule also imports
 * HttpModule, with the CART base URL, so the guard resolved THAT one and sent
 * every introspection to the wrong service. The symptom was a 503 for every
 * token, valid or not, with ECONNREFUSED in the log — nothing about it
 * pointed at dependency-injection scoping.
 *
 * A named token fixes it because there is exactly one thing
 * `AUTH_HTTP_CLIENT` can resolve to. But note it must be EXPORTED as well as
 * provided: CartModule builds its own guard instance, so the token has to be
 * resolvable from there. Providing without exporting simply moves the failure
 * from "wrong client" to "cannot resolve dependency" at startup — which is at
 * least a loud failure rather than a silent one.
 *
 * The general lesson: when a dependency must be a SPECIFIC configured
 * instance rather than "whatever is in scope", give it a name — and export
 * the name.
 *
 * Any future module needing authentication imports this one. That is the
 * point at which applying the guard to the catalogue and inventory writes
 * becomes a two-line change.
 */
@Module({
  providers: [
    {
      provide: AUTH_HTTP_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayEnv, true>) =>
        axios.create({
          baseURL: config.get('AUTH_SERVICE_URL', { infer: true }),
          timeout: config.get('HTTP_CLIENT_TIMEOUT_MS', { infer: true }),
        }),
    },
    AuthenticatedUserGuard,
  ],
  // Both the guard AND the token it needs. See above: the consuming module
  // constructs its own guard instance, so the token must be resolvable there.
  exports: [AuthenticatedUserGuard, AUTH_HTTP_CLIENT],
})
export class AuthenticationModule {}
