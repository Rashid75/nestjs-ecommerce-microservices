import {
  AuthResponseDto,
  LoginDto,
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
   * `@Headers('authorization')` rather than a guard: the gateway holds no
   * signing key in this milestone, so it has nothing to verify with. It
   * forwards the header and reports whatever the Auth Service decides.
   */
  @Get('me')
  me(
    @Headers('authorization') authorization?: string,
  ): Promise<UserProfileDto> {
    return this.proxy.me(authorization);
  }
}
