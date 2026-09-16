/**
 * `/health/live` and `/health/ready`.
 *
 * A SEPARATE ENTRY POINT from the library's main barrel, and not for tidiness:
 * `@nestjs/terminus` v12 ships ESM only, and Jest — running ts-jest in
 * CommonJS — cannot parse it. Re-exported from `index.ts`, every service's
 * unit tests would load Terminus transitively through any import of this
 * library and fail before running a single assertion.
 *
 * So health lives behind `@ecommerce/observability/health`, imported by the
 * one file per service that actually wires it up:
 *
 * ```ts
 * import { HealthModule } from '@ecommerce/observability/health';
 * ```
 *
 * The same shape as `@ecommerce/observability/tracing`, and for a related
 * reason: a heavy dependency should only be loaded by the code that needs it.
 */
export * from './lib/health/health.indicators';
export * from './lib/health/health.module';
