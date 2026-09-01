import { UserRole } from '@ecommerce/contracts';
import type { ClientProxy } from '@nestjs/microservices';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { AuthEnv } from '../config/env.validation';
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

function makeConfig(): ConfigService<AuthEnv, true> {
  const values: Partial<Record<keyof AuthEnv, unknown>> = {
    BCRYPT_COST: BCRYPT_TEST_COST,
    JWT_ACCESS_TTL_SECONDS: TTL_SECONDS,
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

function makeService(
  repo: RepoFake,
  publisher: ClientProxy = makePublisher().fake,
): AuthService {
  return new AuthService(
    repo as unknown as UsersRepository,
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
});
