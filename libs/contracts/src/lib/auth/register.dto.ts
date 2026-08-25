import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The registration request contract.
 *
 * This class is used by BOTH the API Gateway and the Auth Service. That is the
 * point of `libs/contracts`: the two apps talk over HTTP, so the shape of the
 * request body is a genuine shared concern. Two hand-maintained copies would
 * drift, and the drift would only show up at runtime, in the wire format.
 *
 * Note what is NOT shared: the `User` Sequelize model. A DTO is the public
 * shape of a message. A model is a service's private persistence detail, and
 * sharing models is how a microservice monorepo turns into a distributed
 * monolith.
 */
export class RegisterDto {
  @ApiProperty({
    example: 'ada@example.com',
    maxLength: 320,
    description: 'Login identity. Stored and compared in lowercase.',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  // Normalise BEFORE validation runs so `Ada@Example.com` and `ada@example.com`
  // cannot become two accounts. Doing this in the DTO rather than in the
  // service means every entry point gets it, including Swagger's "try it out".
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({
    example: 'correct-horse-Battery9',
    minLength: 12,
    maxLength: 72,
    description:
      'Minimum 12 characters, with at least one lowercase letter, one uppercase letter and one digit.',
  })
  @IsString()
  @MinLength(12)
  // 72 is not an arbitrary limit — it is bcrypt's. bcrypt hashes at most 72
  // BYTES and silently ignores everything after that, so a 200-character
  // passphrase would be no stronger than its first 72 bytes. Rejecting the
  // input is honest; silently truncating a credential is not.
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'password must contain at least one lowercase letter, one uppercase letter and one digit',
  })
  password!: string;

  @ApiProperty({ example: 'Ada', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName!: string;

  @ApiProperty({ example: 'Lovelace', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName!: string;
}
