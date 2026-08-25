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
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account and receive an access token' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.auth.register(dto);
  }

  @Post('login')
  // Without this, NestJS would return 201 for any POST. A login CREATES
  // nothing — it verifies a credential — so 200 is the honest status.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange email and password for an access token' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.auth.login(dto);
  }

  /**
   * The endpoint that proves the whole chain works: a request with no token,
   * an expired token or a tampered token gets 401 before this method runs.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  // Tells Swagger this route needs the bearer token, which makes the
  // "Authorize" button in the UI apply to it.
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired or invalid token',
  })
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
