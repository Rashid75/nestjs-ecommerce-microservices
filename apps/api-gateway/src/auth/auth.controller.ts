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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
 *   - the gateway's Swagger document is accurate, because it is generated from
 *     the real DTO rather than hand-written;
 *   - and the Auth Service still validates independently, because a service
 *     that trusts its caller is only as safe as its least careful caller.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly proxy: AuthProxyService) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account and receive an access token' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  @ApiResponse({ status: 503, description: 'Auth service unavailable' })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.proxy.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange email and password for an access token' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.proxy.login(dto);
  }

  /**
   * `@Headers('authorization')` rather than a guard: the gateway holds no
   * signing key in this milestone, so it has nothing to verify with. It
   * forwards the header and reports whatever the Auth Service decides.
   */
  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired or invalid token',
  })
  me(
    @Headers('authorization') authorization?: string,
  ): Promise<UserProfileDto> {
    return this.proxy.me(authorization);
  }
}
