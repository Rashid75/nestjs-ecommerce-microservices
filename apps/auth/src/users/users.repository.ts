import { UserRole } from '@ecommerce/contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { User } from './user.model';

/**
 * The shape the rest of the application sees. Deliberately a plain object and
 * NOT a Sequelize model instance.
 *
 * A model instance carries `save()`, `destroy()`, `reload()` and a live
 * connection. Handing one to AuthService would mean any service method could
 * write to the database, and the "no Sequelize above the repository" rule
 * would hold only by good manners. Returning data makes it structural.
 *
 * It also keeps AuthService trivially unit-testable: the test fake returns
 * object literals, with no ORM in sight.
 */
export interface UserRecord {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A UserRecord plus the credential. Only ever returned to the login path. */
export interface UserWithCredential extends UserRecord {
  passwordHash: string;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}

/**
 * Domain error, not an HTTP error.
 *
 * The repository knows a unique index was violated. It does not know, and
 * should not decide, that this means "409 Conflict" — that is a transport
 * concern, and the same repository will one day be called from a RabbitMQ
 * consumer where HTTP status codes are meaningless. AuthService does the
 * translation.
 */
export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`email already registered: ${email}`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * The ONLY place in the Auth Service that talks to Sequelize.
 *
 *   AuthController -> AuthService -> UsersRepository -> User model -> PostgreSQL
 *
 * Why the extra layer, when AuthService could inject the model directly?
 *
 *  - Persistence stays swappable and, more importantly, MOCKABLE. AuthService
 *    tests do not need a database.
 *  - Query knowledge stays in one file. Without it, `User.findOne({...})`
 *    appears in six services and the day you add a `deleted_at` filter you
 *    have to find all six.
 *  - The `withPasswordHash` scope has exactly one caller, so the credential
 *    read path is auditable.
 *
 * The cost is one more file per aggregate. At this size that is a fair trade;
 * a repository that only ever forwards to the model with no added meaning is
 * the anti-pattern to watch for.
 */
@Injectable()
export class UsersRepository {
  constructor(@InjectModel(User) private readonly userModel: typeof User) {}

  /**
   * Inserts a user, or throws EmailAlreadyRegisteredError.
   *
   * Note what is NOT here: a "does this email exist?" SELECT before the
   * INSERT. That check-then-act pattern is a race — two concurrent
   * registrations both find nothing and both insert. Whichever one loses the
   * race gets a unique-index violation from PostgreSQL anyway, so the check
   * buys nothing except a false sense of safety and an extra round trip.
   *
   * Let the database be the arbiter and translate its error. The constraint is
   * the only thing that is actually atomic.
   */
  async create(input: CreateUserInput): Promise<UserRecord> {
    try {
      const created = await this.userModel.create({
        email: input.email,
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: UserRole.Customer,
        isActive: true,
      } as User);

      return this.toRecord(created);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new EmailAlreadyRegisteredError(input.email);
      }
      throw error;
    }
  }

  /**
   * Login path only. `.scope('withPasswordHash')` is the single documented
   * exception to the model's defaultScope.
   *
   * The lookup is a plain equality match because the email column is
   * guaranteed lowercase by a CHECK constraint and the DTO lowercases on the
   * way in. Using `lower(email) = ?` instead would silently stop the unique
   * index from being used.
   */
  async findByEmailWithCredential(
    email: string,
  ): Promise<UserWithCredential | null> {
    const found = await this.userModel
      .scope('withPasswordHash')
      .findOne({ where: { email } });

    if (found === null) {
      return null;
    }

    return { ...this.toRecord(found), passwordHash: found.passwordHash };
  }

  /** Used by the JWT strategy to re-check the subject on every request. */
  async findById(id: string): Promise<UserRecord | null> {
    const found = await this.userModel.findByPk(id);
    return found === null ? null : this.toRecord(found);
  }

  /**
   * Model instance -> plain record.
   *
   * Explicit field-by-field rather than `found.get({ plain: true })`, so a new
   * column cannot start flowing outward just because someone added it to the
   * model. Adding a field to the API should be a decision, not a side effect.
   */
  private toRecord(model: User): UserRecord {
    return {
      id: model.id,
      email: model.email,
      firstName: model.firstName,
      lastName: model.lastName,
      role: model.role,
      isActive: model.isActive,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    };
  }
}
