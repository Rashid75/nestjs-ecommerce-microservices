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
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { UserRecord } from '../users/users.repository';
import { AuthService, toProfile } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * HTTP entry point for the Auth Service.
 *
 * The controller does exactly three things: accept a request, hand it to the
 * service, return the result. There is no business logic and — per the
 * project's architecture rule — no Sequelize anywhere near it.
 *
 *   AuthController -> AuthService -> UsersRepository -> User model -> PostgreSQL
 *
 * Note that this service is INTERNAL. It listens on 127.0.0.1 and the API
 * Gateway is the only thing that should ever call it. It is not exposed to the
 * internet, which is why there is no rate limiting here yet — that belongs at
 * the gateway, where the public traffic actually arrives.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.auth.register(dto);
  }

  @Post('login')
  // Without this, NestJS would return 201 for any POST. A login CREATES
  // nothing — it verifies a credential — so 200 is the honest status.
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.auth.login(dto);
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * NO ACCESS TOKEN IS REQUIRED, and that is the entire purpose: a client
   * calls this precisely because its access token has expired. Requiring a
   * valid access token to refresh one would be a circle.
   *
   * The refresh token is therefore the only credential presented, which is
   * why it is checked against the database rather than merely verified.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * Ends the session the token belongs to.
   *
   * 204, and it answers 204 even for a token that was never valid. A logout
   * endpoint that distinguished "revoked your session" from "no such token"
   * would be an oracle for testing stolen tokens, and there is nothing a
   * client can usefully do with the difference — either way, the session is
   * over as far as it is concerned.
   *
   * NOTE WHAT LOGOUT CANNOT DO: the access token issued minutes ago stays
   * valid until it expires. Nothing here can recall it. A client must also
   * discard it, and the residual window is the access-token lifetime — which
   * is the reason that lifetime is 15 minutes and not a day.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  /**
   * The endpoint that proves the whole chain works: a request with no token,
   * an expired token or a tampered token gets 401 before this method runs.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser() user: UserRecord | undefined): UserProfileDto {
    if (user === undefined) {
      // Unreachable while the guard is in place. It exists because the guard
      // is the only thing making it unreachable, and guards get removed by
      // accident during refactors.
      throw new UnauthorizedException('Invalid or expired token');
    }
    return toProfile(user);
  }
}
