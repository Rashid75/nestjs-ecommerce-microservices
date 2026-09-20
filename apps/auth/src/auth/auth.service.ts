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
import { correlationIdForEvent } from '@ecommerce/observability';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { RefreshTokensRepository } from '../tokens/refresh-tokens.repository';
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
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly jwt: JwtService,
    @Inject(EVENTS_CLIENT) private readonly events: ClientProxy,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.bcryptCost = config.get('BCRYPT_COST', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', {
      infer: true,
    });
    this.refreshTtlSeconds = config.get('REFRESH_TOKEN_TTL_SECONDS', {
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
        correlationId: correlationIdForEvent(),
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
   * Exchanges a refresh token for a fresh pair, and rotates it.
   *
   * ROTATION: every use of a refresh token retires it and issues a new one.
   * The alternative — a long-lived token used over and over — means a stolen
   * copy works for the full thirty days and nothing ever notices. With
   * rotation, the thief's use and the victim's use COLLIDE, and a collision
   * is a signal.
   *
   * REUSE DETECTION is what turns that signal into a defence. Presenting a
   * token that has already been rotated means two parties hold it, and there
   * is no way to tell which one is the customer. So the whole FAMILY is
   * revoked — every descendant of that original login — and both parties are
   * forced back to the password. Refusing only the replayed token would leave
   * whichever of them rotated last in possession of a live session, and in
   * the bad case that is the attacker.
   *
   * It is deliberately blunt. Logging a legitimate customer out because their
   * phone retried a request on a flaky connection is a bad afternoon;
   * leaving an attacker with a thirty-day session is a bad year.
   *
   * Every failure below answers the SAME 401 with the same message. "Expired"
   * versus "revoked" versus "never existed" is exactly the feedback an
   * attacker testing a stolen list wants.
   */
  async refresh(presentedToken: string): Promise<AuthTokensDto> {
    const record = await this.refreshTokens.findByHash(hashToken(presentedToken));

    if (record === null) {
      this.logger.warn('refresh presented an unknown token');
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (record.revokedAt !== null) {
      // THE REUSE CASE. Either a thief is replaying a token the customer
      // already rotated, or the customer is replaying one the thief rotated.
      // Both readings end the same way.
      const revoked = await this.refreshTokens.revokeFamily(record.familyId);
      this.logger.error(
        `refresh token REUSE detected for user ${record.userId}: family ${record.familyId} revoked (${revoked} live token(s))`,
      );
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      this.logger.warn(`refresh token expired for user ${record.userId}`);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // The account, re-read. A token issued thirty days ago says nothing about
    // whether the account still exists or is still enabled, and a refresh is
    // exactly the moment to ask — it is the cheap, infrequent call, unlike
    // the access token's per-request path.
    const user = await this.users.findById(record.userId);

    if (user === null || !user.isActive) {
      await this.refreshTokens.revokeFamily(record.familyId);
      this.logger.warn(
        `refresh refused for inactive or missing user ${record.userId}`,
      );
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Retire the presented token FIRST, and only continue if this call is the
    // one that retired it. Two concurrent refreshes with the same token both
    // reach here; the compare-and-set inside the repository lets exactly one
    // through. The loser is treated as reuse, because from here it is
    // indistinguishable from it.
    const retired = await this.refreshTokens.revokeIfLive(record.id, null);

    if (!retired) {
      await this.refreshTokens.revokeFamily(record.familyId);
      this.logger.error(
        `concurrent refresh for user ${record.userId}: family ${record.familyId} revoked`,
      );
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Same family: this is the same session, one step further along.
    return this.issueTokens(user, record.familyId, record.id);
  }

  /**
   * Ends a session.
   *
   * Revokes the whole FAMILY rather than the presented row, because "log me
   * out" means the session, not the one token the client happens to be
   * holding. Silent on an unknown token — see the controller for why.
   */
  async logout(presentedToken: string): Promise<void> {
    const record = await this.refreshTokens.findByHash(hashToken(presentedToken));

    if (record === null) {
      return;
    }

    const revoked = await this.refreshTokens.revokeFamily(record.familyId);
    this.logger.log(
      `logout for user ${record.userId}: ${revoked} token(s) revoked`,
    );
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
  private async issueTokens(
    user: UserRecord,
    // Annotated `string` rather than inferred: `randomUUID()` returns a
    // template-literal type, and inferring it here would make every caller
    // holding a plain string from the database a type error.
    familyId: string = randomUUID(),
    replacing: string | null = null,
  ): Promise<AuthTokensDto> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: this.accessTtlSeconds,
    });

    /**
     * The refresh token is OPAQUE — 256 bits from a CSPRNG, not a JWT.
     *
     * A JWT would be the reflex, and it would be wrong here. Every property
     * a JWT gives you is worthless for this token: the claims are read from
     * the database anyway, the signature proves nothing the row does not,
     * and the self-contained format means a longer string that leaks
     * whatever is inside it to anyone who base64-decodes it. What it costs
     * is real, though — people see a JWT and assume it can be trusted
     * standalone.
     *
     * `randomBytes`, never `Math.random()`. The latter is a predictable
     * PRNG, and a predictable session token is not a session token.
     */
    const refreshToken = randomBytes(32).toString('base64url');

    const created = await this.refreshTokens.create({
      userId: user.id,
      // Only the HASH is stored. The token above is the only copy, and it
      // leaves in the response.
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1_000),
    });

    if (replacing !== null) {
      // Records the chain: this new row superseded that old one. Not needed
      // to make anything work — it is there so an incident can be read.
      await this.refreshTokens.revokeIfLive(replacing, created.id);
    }

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      refreshToken,
      refreshExpiresIn: this.refreshTtlSeconds,
    };
  }
}

/**
 * SHA-256, hex. The lookup key for a token we deliberately did not store.
 *
 * Not bcrypt: this input is 256 bits of CSPRNG output, so there is no
 * dictionary to slow down, and a salted hash could not be looked up at all
 * without scanning the table.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
