import {
  AuthResponseDto,
  AuthTokensDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  UserProfileDto,
} from '@ecommerce/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.decorator';
import { AuthProxyService } from './auth-proxy.service';

/**
 * The PUBLIC authentication API.
 *
 * These routes are the ones a browser or mobile app calls. They mirror the
 * Auth Service's routes exactly today, which raises a fair question: why not
 * just expose the Auth Service?
 *
 * Because "identical today" is not "identical forever". The gateway is where
 * rate limiting, correlation IDs, request logging and — later — response
 * aggregation live. It is also what lets the Auth Service be split, renamed or
 * moved behind RabbitMQ without any client noticing.
 *
 * Note the DTOs are validated HERE TOO, by the gateway's global
 * ValidationPipe, using the same classes from `@ecommerce/contracts`. That is
 * not redundant work:
 *
 *   - a malformed body is rejected without a network hop;
 *   - and the Auth Service still validates independently, because a service
 *     that trusts its caller is only as safe as its least careful caller.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly proxy: AuthProxyService) {}

  @Post('register')
  // 5 accounts per IP per 15 minutes. Registration writes a row and runs
  // bcrypt at cost 12 (~250ms of CPU), so it is both expensive and a
  // spam-signup target.
  @RateLimit({ limit: 5, windowSeconds: 900, name: 'auth:register' })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.proxy.register(dto);
  }

  @Post('login')
  // 5 attempts per IP per minute.
  //
  // THIS IS THE MOST IMPORTANT LIMIT IN THE SYSTEM. Until now the only thing
  // slowing a credential-stuffing attack was bcrypt's cost — about 250ms per
  // guess, so roughly 4 guesses a second per connection, and nothing stopped
  // an attacker opening a thousand connections. Against a leaked
  // email/password list that is entirely sufficient to succeed.
  //
  // 5/minute makes an online guessing attack useless while remaining
  // invisible to a human who mistypes a password twice.
  //
  // What it does NOT solve: an attacker with a botnet gets 5 attempts per IP,
  // and a distributed attack has many IPs. The next layers are per-ACCOUNT
  // lockout, credential-breach checks, and MFA — none of which are in this
  // milestone. Rate limiting raises the cost; it does not close the door.
  @RateLimit({ limit: 5, windowSeconds: 60, name: 'auth:login' })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.proxy.login(dto);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * RATE LIMITED, and more tightly than it looks like it needs to be. A
   * healthy client calls this roughly once every fifteen minutes; anything
   * calling it repeatedly is either a broken retry loop or someone working
   * through a list of stolen tokens. 20 per 15 minutes leaves enormous room
   * for the first and none for the second.
   *
   * It is also the one public endpoint where a single successful guess is
   * worth thirty days of access, which is why it gets its own budget rather
   * than sharing the default.
   */
  @Post('refresh')
  @RateLimit({ limit: 20, windowSeconds: 900, name: 'auth:refresh' })
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.proxy.refresh(dto);
  }

  /**
   * End the session.
   *
   * No authentication required beyond the refresh token itself — the token
   * IS the thing being revoked, and demanding a valid access token to log
   * out would mean an expired session cannot be ended. Nothing is at risk:
   * the worst an attacker can do with this endpoint is log someone out using
   * a token they already possess.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.proxy.logout(dto);
  }

  /**
   * `@Headers('authorization')` rather than a guard.
   *
   * This endpoint is the gateway's own INTROSPECTION target — the guard
   * calls it — so guarding it with the guard would be a loop. It forwards
   * the header and reports whatever the Auth Service decides, which is the
   * one verdict that counts.
   */
  @Get('me')
  me(
    @Headers('authorization') authorization?: string,
  ): Promise<UserProfileDto> {
    return this.proxy.me(authorization);
  }
}
