/**
 * The side-effect entry point: importing this starts OpenTelemetry.
 *
 * It exists as a separate file with nothing else in it so that the FIRST
 * line of every `main.ts` can be:
 *
 * ```ts
 * import '@ecommerce/observability/tracing';
 * ```
 *
 * Auto-instrumentation patches modules as they are required, so anything
 * imported before this line is the unpatched version and will never appear
 * in a trace. A file whose only job is to run first makes that ordering
 * impossible to get subtly wrong — there is nothing else in it anyone might
 * be tempted to move.
 */
import { startTracing } from './lib/tracing';

const started = startTracing();

if (started) {
  // Not the application logger: that does not exist yet, and cannot, because
  // this runs before the Nest application is constructed. One line on stdout
  // is the right amount of noise for "the thing that must run first, ran".
  // eslint-disable-next-line no-console
  console.log(
    `[tracing] OpenTelemetry started for ${process.env['OTEL_SERVICE_NAME'] ?? 'unknown-service'} (${process.env['OTEL_EXPORTER'] ?? 'console'})`,
  );
}
