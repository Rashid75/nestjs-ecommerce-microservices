import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { User } from './user.model';
import { UsersRepository } from './users.repository';

/**
 * Owns everything about the `users` table.
 *
 * `SequelizeModule.forFeature([User])` registers the model with the connection
 * opened by DatabaseModule and provides the injection token that
 * `@InjectModel(User)` resolves. It does not create the table — the migration
 * does.
 *
 * Only UsersRepository is exported. The `User` model itself is NOT, so no
 * other module can inject it and start writing queries outside the repository.
 * The rule is enforced by the module system rather than by review.
 */
@Module({
  imports: [SequelizeModule.forFeature([User])],
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
