import { EVENTS_CLIENT } from '@ecommerce/contracts';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  type RmqOptions,
  Transport,
} from '@nestjs/microservices';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { AuthEnv } from '../config/env.validation';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    // The RabbitMQ publisher, registered in the module whose service uses it.
    //
    // `ClientsModule` is NOT global, so the provider has to live where it is
    // injected. Putting it in AppModule looks tidier and fails with
    // "Nest can't resolve dependencies ... EVENTS_CLIENT" — the client
    // belongs next to its consumer.
    ClientsModule.registerAsync([
      {
        name: EVENTS_CLIENT,
        inject: [ConfigService],
        // The return type is annotated so TypeScript checks the shape here
        // rather than deep inside Nest's overloads, where the error is four
        // levels of union mismatch and says almost nothing.
        useFactory: (config: ConfigService<AuthEnv, true>): RmqOptions => {
          const url: string = config.get('RABBITMQ_URL', { infer: true });
          const queue: string = config.get('RABBITMQ_QUEUE', { infer: true });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue,
              // Survives a broker restart. Nest publishes persistent
              // messages by default, which is the other half of that.
              queueOptions: { durable: true },
            },
          };
        },
      },
    ]),

    UsersModule,

    // Makes Passport's guards available. `defaultStrategy` is intentionally
    // NOT set: a default means `@UseGuards(AuthGuard())` silently picks a
    // strategy, and silence is the wrong property for an authorisation
    // decision. Every guard in this codebase names its strategy.
    PassportModule,

    // registerAsync, not register, because the secret comes from validated
    // configuration rather than from a literal. A hardcoded fallback such as
    // `secret: process.env.JWT_SECRET || 'dev-secret'` is one of the most
    // common real-world vulnerabilities: it means production silently runs on
    // a publicly known signing key whenever the variable is missing. Ours
    // cannot start at all without a 32-character secret.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AuthEnv, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          // HS256: one shared secret both signs and verifies. Correct while a
          // single service does both.
          //
          // The moment another service needs to verify tokens itself, that
          // service would need the signing key — and a key that can verify can
          // also mint. At that point switch to RS256: Auth holds the private
          // key, everyone else gets the public one. Noted here because it is a
          // decision with a clear trigger, not a rewrite to fear.
          algorithm: 'HS256',
          issuer: 'ecommerce-auth',
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: 'ecommerce-auth',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  // JwtStrategy is listed as a provider so Nest instantiates it. Instantiating
  // it is what registers it with Passport under the name 'jwt' — there is no
  // separate registration call, which is why a forgotten provider produces the
  // baffling "Unknown authentication strategy 'jwt'".
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
