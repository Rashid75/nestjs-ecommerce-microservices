import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Protects a route with the 'jwt' strategy.
 *
 * The string 'jwt' is the name JwtStrategy registered itself under. Wrapping
 * `AuthGuard('jwt')` in a named class rather than using it inline everywhere
 * buys two things: the magic string appears once instead of in every
 * controller, and there is now a place to add behaviour later (optional auth,
 * public-route bypass, richer error mapping) without touching call sites.
 *
 * Applied per-handler here. In a later milestone this becomes a GLOBAL guard
 * with an `@Public()` escape hatch, which is the safer default: with a global
 * guard, forgetting the decorator leaves an endpoint locked; with per-handler
 * guards, forgetting it leaves an endpoint wide open. Fail closed.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
