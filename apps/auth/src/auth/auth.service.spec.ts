import { UserRole } from '@ecommerce/contracts';
import type { ClientProxy } from '@nestjs/microservices';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { AuthEnv } from '../config/env.validation';
import type {
  RefreshTokenRecord,
  RefreshTokensRepository,
} from '../tokens/refresh-tokens.repository';
import {
  EmailAlreadyRegisteredError,
  UserRecord,
  UsersRepository,
} from '../users/users.repository';
import { AuthService } from './auth.service';

/**
 * Unit tests for AuthService. No database, no HTTP, no Nest testing module.
 *
 * This is possible only because UsersRepository returns plain objects rather
 * than Sequelize model instances — the fake below is three functions. That is
 * the practical payoff of the repository layer, not just architectural
 * tidiness.
 *
 * bcrypt is NOT mocked. Hashing is the behaviour under test in half these
 * cases, and a mocked `compare` that always returns true would let a real
 * authentication bug through. Cost 4 keeps it fast.
 */
const BCRYPT_TEST_COST = 4;
const TTL_SECONDS = 900;
const REFRESH_TTL_SECONDS = 2_592_000;

function makeConfig(): ConfigService<AuthEnv, true> {
  const values: Partial<Record<keyof AuthEnv, unknown>> = {
    BCRYPT_COST: BCRYPT_TEST_COST,
    JWT_ACCESS_TTL_SECONDS: TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS: REFRESH_TTL_SECONDS,
  };
  return {
    get: (key: keyof AuthEnv) => values[key],
  } as unknown as ConfigService<AuthEnv, true>;
}

function makeJwt(): JwtService {
  return {
    signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
  } as unknown as JwtService;
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: UserRole.Customer,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

type RepoFake = {
  create: jest.Mock;
  findByEmailWithCredential: jest.Mock;
  findById: jest.Mock;
};

function makeRepo(): RepoFake {
  return {
    create: jest.fn(),
    findByEmailWithCredential: jest.fn(),
    findById: jest.fn(),
  };
}

/**
 * A ClientProxy that records what would have been emitted.
 *
 * `emit` returns an Observable in real life; the service does not subscribe
 * to it (fire and forget), so returning a plain object is faithful enough
 * for these tests. What matters is WHICH pattern was emitted and WHEN.
 */
function makePublisher(): { fake: ClientProxy; published: string[] } {
  const published: string[] = [];
  const fake = {
    emit: (pattern: string) => {
      published.push(pattern);
      return { subscribe: () => undefined };
    },
  } as unknown as ClientProxy;
  return { fake, published };
}

/**
 * An in-memory stand-in for the refresh-token table.
 *
 * It implements the ONE behaviour the service depends on for correctness:
 * `revokeIfLive` is a compare-and-set that succeeds exactly once. Faking it
 * as an unconditional update would make the concurrency test pass while the
 * real race stayed open, which is the classic way a fake lies.
 */
type TokenRepoFake = {
  rows: Map<string, RefreshTokenRecord & { tokenHash: string }>;
  create: jest.Mock;
  findByHash: jest.Mock;
  revokeIfLive: jest.Mock;
  revokeFamily: jest.Mock;
  revokeAllForUser: jest.Mock;
};

function makeTokenRepo(): TokenRepoFake {
  const rows = new Map<string, RefreshTokenRecord & { tokenHash: string }>();
  let nextId = 0;

  const fake: TokenRepoFake = {
    rows,
    create: jest.fn((input) => {
      const row = {
        id: `token-${(nextId += 1)}`,
        userId: input.userId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        replacedBy: null,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    }),
    findByHash: jest.fn((hash: string) =>
      Promise.resolve(
        [...rows.values()].find((r) => r.tokenHash === hash) ?? null,
      ),
    ),
    revokeIfLive: jest.fn((id: string, replacedBy: string | null) => {
      const row = rows.get(id);
      if (row === undefined || row.revokedAt !== null) {
        return Promise.resolve(false);
      }
      row.revokedAt = new Date();
      row.replacedBy = replacedBy;
      return Promise.resolve(true);
    }),
    revokeFamily: jest.fn((familyId: string) => {
      let count = 0;
      for (const row of rows.values()) {
        if (row.familyId === familyId && row.revokedAt === null) {
          row.revokedAt = new Date();
          count += 1;
        }
      }
      return Promise.resolve(count);
    }),
    revokeAllForUser: jest.fn(() => Promise.resolve(0)),
  };

  return fake;
}

function makeService(
  repo: RepoFake,
  publisher: ClientProxy = makePublisher().fake,
  tokenRepo: TokenRepoFake = makeTokenRepo(),
): AuthService {
  return new AuthService(
    repo as unknown as UsersRepository,
    tokenRepo as unknown as RefreshTokensRepository,
    makeJwt(),
    publisher,
    makeConfig(),
  );
}

describe('AuthService', () => {
  describe('register', () => {
    it('stores a bcrypt hash, never the plaintext password', async () => {
      const repo = makeRepo();
      repo.create.mockImplementation((input) =>
        Promise.resolve(makeUser({ email: input.email })),
      );

      await makeService(repo).register({
        email: 'ada@example.com',
        password: 'correct-horse-Battery9',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      const stored = repo.create.mock.calls[0][0];
      expect(stored.passwordHash).not.toBe('correct-horse-Battery9');
      expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
      // The hash must actually verify — a hash that does not is worse than no
      // hash, because it locks the user out silently.
      expect(
        await bcrypt.compare('correct-horse-Battery9', stored.passwordHash),
      ).toBe(true);
    });

    it('never returns the password hash in the response', async () => {
      const repo = makeRepo();
      repo.create.mockResolvedValue(makeUser());

      const result = await makeService(repo).register({
        email: 'ada@example.com',
        password: 'correct-horse-Battery9',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      expect(JSON.stringify(result)).not.toContain('$2b$');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.expiresIn).toBe(TTL_SECONDS);
    });

    it('publishes user.registered as a past-tense FACT, not a command', async () => {
      const repo = makeRepo();
      repo.create.mockResolvedValue(makeUser());
      const { fake, published } = makePublisher();

      await makeService(repo, fake).register({
        email: 'ada@example.com',
        password: 'correct-horse-Battery9',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      // NOT 'send.welcome.email'. Auth does not know an email system exists,
      // so Notification can appear or disappear without Auth changing.
      expect(published).toEqual(['user.registered']);
    });

    it('does not publish when registration failed', async () => {
      const repo = makeRepo();
      repo.create.mockRejectedValue(
        new EmailAlreadyRegisteredError('ada@example.com'),
      );
      const { fake, published } = makePublisher();

      await expect(
        makeService(repo, fake).register({
          email: 'ada@example.com',
          password: 'correct-horse-Battery9',
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(published).toEqual([]);
    });

    it('translates a duplicate email into 409 Conflict', async () => {
      const repo = makeRepo();
      repo.create.mockRejectedValue(
        new EmailAlreadyRegisteredError('ada@example.com'),
      );

      await expect(
        makeService(repo).register({
          email: 'ada@example.com',
          password: 'correct-horse-Battery9',
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('issues a token when the password matches', async () => {
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...makeUser(),
        passwordHash: await bcrypt.hash('right-Password1', BCRYPT_TEST_COST),
      });

      const result = await makeService(repo).login({
        email: 'ada@example.com',
        password: 'right-Password1',
      });

      expect(result.tokens.accessToken).toBe('signed.jwt.token');
    });

    it('rejects a wrong password', async () => {
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...makeUser(),
        passwordHash: await bcrypt.hash('right-Password1', BCRYPT_TEST_COST),
      });

      await expect(
        makeService(repo).login({
          email: 'ada@example.com',
          password: 'wrong-Password1',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a disabled account even with the correct password', async () => {
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...makeUser({ isActive: false }),
        passwordHash: await bcrypt.hash('right-Password1', BCRYPT_TEST_COST),
      });

      await expect(
        makeService(repo).login({
          email: 'ada@example.com',
          password: 'right-Password1',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('gives an unknown email the same error as a wrong password', async () => {
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue(null);

      const failure = await makeService(repo)
        .login({ email: 'nobody@example.com', password: 'right-Password1' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(UnauthorizedException);
      // Identical wording is the whole point: the response must not reveal
      // whether the account exists.
      expect((failure as UnauthorizedException).message).toBe(
        'Invalid email or password',
      );
    });
  });

  /**
   * The refresh-token lifecycle.
   *
   * The two that matter are ROTATION (a used token stops working) and REUSE
   * DETECTION (presenting a used token kills the whole session). Together
   * they are what makes a stolen refresh token a bounded loss rather than
   * thirty days of quiet access.
   */
  describe('refresh', () => {
    async function login(): Promise<{
      service: AuthService;
      tokens: TokenRepoFake;
      refreshToken: string;
      user: UserRecord;
    }> {
      const user = makeUser();
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...user,
        passwordHash: await bcrypt.hash('correct-horse-Battery9', BCRYPT_TEST_COST),
      });
      repo.findById.mockResolvedValue(user);

      const tokens = makeTokenRepo();
      const service = makeService(repo, makePublisher().fake, tokens);

      const result = await service.login({
        email: user.email,
        password: 'correct-horse-Battery9',
      });

      return { service, tokens, refreshToken: result.tokens.refreshToken, user };
    }

    it('never stores the refresh token itself, only a hash of it', async () => {
      const { tokens, refreshToken } = await login();

      const stored = [...tokens.rows.values()][0];
      expect(stored.tokenHash).not.toBe(refreshToken);
      // This table is a list of live credentials. Anyone who reads it — a
      // leaked backup, a support query — must not be able to use what they
      // find.
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rotates: the old token stops working and a new one is issued', async () => {
      const { service, refreshToken } = await login();

      const rotated = await service.refresh(refreshToken);
      expect(rotated.refreshToken).not.toBe(refreshToken);
      expect(rotated.accessToken).toBeDefined();

      // The old one is now dead. Without this, a stolen copy would keep
      // working for the full thirty days and nothing would ever notice.
      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('detects reuse and revokes the ENTIRE family', async () => {
      const { service, tokens, refreshToken } = await login();

      const second = await service.refresh(refreshToken);
      const third = await service.refresh(second.refreshToken);

      // Now replay the FIRST token — the shape of a theft: someone captured
      // it, the real user has since rotated twice.
      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );

      // Everything descended from that login is dead, including the token
      // the legitimate user is holding. Deliberately blunt: we cannot tell
      // which party is the customer, so both go back to the password.
      await expect(service.refresh(third.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(
        [...tokens.rows.values()].every((r) => r.revokedAt !== null),
      ).toBe(true);
    });

    it('treats a concurrent refresh as reuse', async () => {
      const { service, refreshToken } = await login();

      // Two requests with the SAME token at the same moment — a client
      // retrying a timed-out call, or a thief racing the victim. Exactly one
      // may win; a read-then-write implementation would let both through and
      // silently fork the session.
      const results = await Promise.allSettled([
        service.refresh(refreshToken),
        service.refresh(refreshToken),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
    });

    it('refuses a refresh for an account that has been disabled', async () => {
      const user = makeUser();
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...user,
        passwordHash: await bcrypt.hash('correct-horse-Battery9', BCRYPT_TEST_COST),
      });
      repo.findById.mockResolvedValue(user);

      const service = makeService(repo);
      const { tokens } = await service.login({
        email: user.email,
        password: 'correct-horse-Battery9',
      });

      // The account is disabled AFTER the session began. This is the moment
      // the check pays for itself: the access token cannot be recalled, but
      // the session cannot be extended.
      repo.findById.mockResolvedValue({ ...user, isActive: false });

      await expect(service.refresh(tokens.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('says the same thing for an unknown token as for a revoked one', async () => {
      const { service, refreshToken } = await login();
      await service.refresh(refreshToken);

      const unknown = service.refresh('a'.repeat(43));
      const revoked = service.refresh(refreshToken);

      // Distinguishing them would tell someone working through a stolen list
      // which tokens were ever real.
      await expect(unknown).rejects.toThrow('Invalid or expired refresh token');
      await expect(revoked).rejects.toThrow('Invalid or expired refresh token');
    });
  });

  describe('logout', () => {
    it('ends the session, not just the token presented', async () => {
      const user = makeUser();
      const repo = makeRepo();
      repo.findByEmailWithCredential.mockResolvedValue({
        ...user,
        passwordHash: await bcrypt.hash('correct-horse-Battery9', BCRYPT_TEST_COST),
      });
      repo.findById.mockResolvedValue(user);

      const service = makeService(repo);
      const first = await service.login({
        email: user.email,
        password: 'correct-horse-Battery9',
      });
      const rotated = await service.refresh(first.tokens.refreshToken);

      await service.logout(rotated.refreshToken);

      await expect(service.refresh(rotated.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('is silent about a token it has never seen', async () => {
      const service = makeService(makeRepo());

      // No throw, no information. A logout that distinguished "revoked" from
      // "no such token" would be an oracle for testing stolen tokens.
      await expect(service.logout('b'.repeat(43))).resolves.toBeUndefined();
    });
  });
});
