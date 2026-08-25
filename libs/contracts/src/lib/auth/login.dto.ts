import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The login request contract.
 *
 * Note how much WEAKER the password rules are here than in RegisterDto: only
 * "is a non-empty string of plausible length". That is deliberate.
 *
 * If login enforced the same complexity rules as registration, then tightening
 * the password policy later would lock out every existing user whose (valid,
 * correctly hashed) password no longer matches the new rule. Registration
 * decides what a NEW credential must look like. Login only has to decide
 * whether the supplied credential matches the stored hash.
 */
export class LoginDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ example: 'correct-horse-Battery9', maxLength: 72 })
  @IsString()
  @MinLength(1)
  // Still capped, because an unbounded string is an unbounded amount of work
  // for bcrypt to hash on a public endpoint.
  @MaxLength(72)
  password!: string;
}
