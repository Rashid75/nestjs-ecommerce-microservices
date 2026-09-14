import {
  AccessTokenClaims,
  AuthResponseDto,
  AuthTokensDto,
  LoginDto,
  RegisterDto,
  UserProfileDto,
  EventPattern,
  EVENTS_CLIENT,
  newEventId,
} from '@ecommerce/contracts';
import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { AuthEnv } from '../config/env.validation';
import {
  EmailAlreadyRegisteredError,
  UserRecord,
  UsersRepository,
} from '../users/users.repository';

/**
 * A pre-computed bcrypt hash of a value no user can supply.
 *
 * Used to defend against USER ENUMERATION BY TIMING on login. If we returned
 * early when an email is unknown, that response would come back in ~1ms while
 * a known email takes ~250ms (the cost of bcrypt). An attacker measuring
 * response times could therefore harvest which addresses have accounts,
 * without ever guessing a password.
 *
 * Comparing against this dummy hash makes both paths do the same work.
 *
 * The literal is a real bcrypt hash at cost 12 of a random string. It is not a
 * secret — it hashes nothing anyone will ever type, and it is here so the
 * defence is visible rather than hidden behind a startup computation.
 */
const DUMMY_PASSWORD_HASH =
  '$2b$12$MqSEDuMbyPXAcipnvMk7duD8YqTk3qcFTADoC3DXomBUST9c3VRjK';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptCost: number;
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    @Inject(EVENTS_CLIENT) private readonly events: ClientProxy,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.bcryptCost = config.get('BCRYPT_COST', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', {
      infer: true,
    });
  }

  /**
   * Creates an account and immediately returns an access token, so the client
   * does not have to make a second call to log in.
   *
   * Note the DELIBERATE information disclosure: a duplicate email produces a
   * 409 that says so. That is user enumeration — an attacker can discover
   * which addresses have accounts by attempting to register them.
   *
   * We accept it here because the alternative (always return 202 and send a
   * "you already have an account" email) is a materially worse experience for
   * a shopper who simply forgot they had signed up, and because the same
   * information usually leaks from a password-reset form anyway. For a system
   * where account existence is itself sensitive — a health or finance
   * product — make the opposite choice.
   */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    // Hash BEFORE the insert so the plaintext lives in memory for as short a
    // time as possible, and so the plaintext never reaches the repository
    // layer at all.
    const passwordHash = await bcrypt.hash(dto.password, this.bcryptCost);

    try {
      const user = await this.users.create({
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
      });

      // Log the id, never the email — an application log is not an access-
      // controlled store of personal data.
      this.logger.log(`registered user ${user.id}`);

      // `emit`, not `send`.
      //
      //   emit()  fire and forget — publish an EVENT and move on. Returns an
      //           Observable that completes once the message is handed to
      //           the broker; nobody replies.
      //   send()  request/response — publish a COMMAND and wait for a reply.
      //           That is `@MessagePattern` on the other end.
      //
      // "A user registered" is a fact, so nothing replies to it.
      //
      // Not awaited: registration must not fail because a broker is down.
      // The cost is that a lost event is genuinely lost — acceptable for a
      // welcome email, and something we will have to solve properly when an
      // event means an order.
      //
      // Note WHAT is published: `user.registered`, a past-tense fact, not
      // `send.welcome.email`. Auth does not know an email system exists.
      this.events.emit(EventPattern.UserRegistered, {
        eventId: newEventId(),
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
      });

      return { user: toProfile(user), tokens: await this.issueTokens(user) };
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
      throw error;
    }
  }

  /**
   * Verifies a credential and issues an access token.
   *
   * Every failure path returns the SAME message and the SAME status. "Unknown
   * email", "wrong password" and "account disabled" are indistinguishable to
   * the caller. Distinguishing them is a small UX win and a large enumeration
   * gift.
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.users.findByEmailWithCredential(dto.email);

    // Always run a comparison, even when there is no user, so both paths cost
    // the same wall-clock time. See DUMMY_PASSWORD_HASH above.
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (user === null || !passwordMatches || !user.isActive) {
      // One log line, one generic response. The reason stays in our logs and
      // out of the response body.
      this.logger.warn(
        `failed login attempt (userFound=${user !== null}, active=${user?.isActive ?? false})`,
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    this.logger.log(`login succeeded for user ${user.id}`);
    return { user: toProfile(user), tokens: await this.issueTokens(user) };
  }

  /**
   * Signs the access token.
   *
   * A JWT is SIGNED, NOT ENCRYPTED. Anyone holding this token can base64-decode
   * the payload and read every claim, so nothing secret goes in it. What the
   * signature buys is integrity: a client cannot change `role` to ADMIN
   * without invalidating the signature, because they do not have the key.
   *
   * It also cannot be revoked. Once issued, this token is valid until it
   * expires — deleting the user does not stop it. That is the price of
   * stateless authentication, and the reason the TTL is 15 minutes rather than
   * 30 days. Refresh tokens (revocable, stored server-side) are how you get
   * long sessions back; they arrive in a later milestone.
   */
  private async issueTokens(user: UserRecord): Promise<AuthTokensDto> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: this.accessTtlSeconds,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }
}

/**
 * Internal record -> public projection.
 *
 * Written out field by field rather than spread, so adding an internal field
 * to UserRecord can never publish it by accident.
 */
export function toProfile(user: UserRecord): UserProfileDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    createdAt: user.createdAt,
  };
}
