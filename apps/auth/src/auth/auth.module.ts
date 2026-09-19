import {
  EVENTS_CLIENT,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  loadPemKey,
} from '@ecommerce/contracts';
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
          const exchange: string = config.get('RABBITMQ_EXCHANGE', {
            infer: true,
          });

          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              // Published to the EXCHANGE, not to a queue. The publisher does
              // not know or care which services have bound a queue to it.
              exchange,
              exchangeType: 'topic',
              // Tells Nest to use the event pattern as the ROUTING KEY, so
              // "order.confirmed" is routed by the broker rather than being
              // the name of a queue.
              wildcards: true,
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

    // registerAsync, not register, because the keys come from validated
    // configuration rather than from a literal. A hardcoded fallback such as
    // `secret: process.env.JWT_SECRET || 'dev-secret'` is one of the most
    // common real-world vulnerabilities: it means production silently runs on
    // a publicly known signing key whenever the variable is missing. Ours
    // cannot start at all without a readable keypair.
    //
    // RS256 SINCE MILESTONE 12. The trigger written down here in M2 arrived
    // exactly as described: the gateway needed to verify tokens, and under
    // HS256 that would have meant giving a public-facing process the ability
    // to MINT admin tokens. Now:
    //
    //   privateKey  signs. This service, and nothing else in the system.
    //   publicKey   verifies. Distributed freely; forges nothing.
    //
    // Note there is no HS256 fallback and no "algorithm from config". A
    // verifier that accepts more than one algorithm is how `alg: none` and
    // the RS256-to-HS256 confusion attack get in.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AuthEnv, true>) => ({
        privateKey: loadPemKey(
          config.get('JWT_PRIVATE_KEY_PATH', { infer: true }),
          'JWT private key',
        ),
        publicKey: loadPemKey(
          config.get('JWT_PUBLIC_KEY_PATH', { infer: true }),
          'JWT public key',
        ),
        signOptions: {
          algorithm: JWT_ALGORITHM,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          // The KEY ID, so a token says which key signed it. Nothing reads it
          // yet — with one key there is nothing to choose between. It is
          // stamped now because rotation means "publish the new public key,
          // start signing with the new private key, keep accepting the old
          // one until the last token expires", and a verifier can only do
          // that if the tokens already say which key they used. Adding
          // `kid` at rotation time is too late for every token already out.
          keyid: 'dev-1',
        },
        verifyOptions: {
          algorithms: [JWT_ALGORITHM],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
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
