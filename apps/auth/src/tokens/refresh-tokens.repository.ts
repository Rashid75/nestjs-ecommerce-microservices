import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { RefreshToken } from './refresh-token.model';

/** The plain-object view. No model instances escape this file — see UsersRepository. */
export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export interface CreateRefreshTokenInput {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

/**
 * The only place that talks to Sequelize about refresh tokens.
 *
 *   AuthService -> RefreshTokensRepository -> RefreshToken model -> PostgreSQL
 */
@Injectable()
export class RefreshTokensRepository {
  constructor(
    @InjectModel(RefreshToken)
    private readonly tokens: typeof RefreshToken,
  ) {}

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const row = await this.tokens.create({
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      replacedBy: null,
    } as RefreshToken);

    return toRecord(row);
  }

  /** Looked up by HASH, because the token itself was never stored. */
  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.tokens.findOne({ where: { tokenHash } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Retires a token, and reports whether THIS call is the one that did it.
   *
   * COMPARE-AND-SET, the same pattern as every status transition in this
   * project: the condition `revoked_at IS NULL` is part of the UPDATE, not a
   * SELECT before it.
   *
   * The race it closes is real and is the whole reason rotation is dangerous
   * to implement naively. Two requests arrive with the same valid refresh
   * token at the same moment — a client retrying a timed-out call, or a
   * thief racing the victim. Read-then-write lets both see "not revoked" and
   * both issue a new token, which silently forks the session into two live
   * branches. With the condition in the UPDATE, PostgreSQL serialises them:
   * one gets 1 row, the other gets 0 and is treated as REUSE.
   *
   * @returns true if this call revoked it; false if it was already revoked.
   */
  async revokeIfLive(id: string, replacedBy: string | null): Promise<boolean> {
    const [affected] = await this.tokens.update(
      { revokedAt: new Date(), replacedBy },
      { where: { id, revokedAt: { [Op.is]: null } } },
    );

    return affected === 1;
  }

  /**
   * Revokes every live token in a family. The incident response.
   *
   * Used for logout (end this session) and for reuse detection (end this
   * session because someone else has a copy of it).
   */
  async revokeFamily(familyId: string): Promise<number> {
    const [affected] = await this.tokens.update(
      { revokedAt: new Date() },
      { where: { familyId, revokedAt: { [Op.is]: null } } },
    );

    return affected;
  }

  /** Revokes every live session for a user. "Log out everywhere." */
  async revokeAllForUser(userId: string): Promise<number> {
    const [affected] = await this.tokens.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: { [Op.is]: null } } },
    );

    return affected;
  }
}

function toRecord(row: RefreshToken): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedBy: row.replacedBy,
  };
}
