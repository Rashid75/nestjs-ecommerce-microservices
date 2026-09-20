import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { RefreshToken } from './refresh-token.model';
import { RefreshTokensRepository } from './refresh-tokens.repository';

/**
 * Owns the `refresh_tokens` table.
 *
 * Only the repository is exported; the model is not, so nothing outside this
 * module can query the table directly. Same rule as UsersModule, and it
 * matters more here — this table is the list of live sessions.
 */
@Module({
  imports: [SequelizeModule.forFeature([RefreshToken])],
  providers: [RefreshTokensRepository],
  exports: [RefreshTokensRepository],
})
export class TokensModule {}
