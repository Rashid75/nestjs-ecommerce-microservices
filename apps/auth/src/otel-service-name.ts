/**
 * Names this process for OpenTelemetry, before anything else happens.
 *
 * WHY A FILE RATHER THAN A LINE IN main.ts. TypeScript hoists every `import`
 * above the first statement, so an assignment written at the top of main.ts
 * would still run AFTER the tracing import had already read the variable.
 * Import order between modules is preserved; statement order relative to
 * imports is not. A side-effect module imported first is the only placement
 * that actually runs first.
 *
 * WHY NOT THE SERVE TARGET. It was there until Milestone 12, as
 * `serve.options.env`, and `@nx/js:node` has no such option — Nx rejected
 * the whole target with "'env' is not found in schema" and no service would
 * start. A setting that only exists in a dev-server config is also absent in
 * production, which is exactly where the service name matters most.
 *
 * `??=` so a real deployment can still override it from the environment.
 */
process.env.OTEL_SERVICE_NAME ??= 'auth';
