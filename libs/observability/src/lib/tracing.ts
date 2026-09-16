/**
 * Starts OpenTelemetry. **Must run before anything else is imported.**
 *
 * WHY THE ORDER IS NOT NEGOTIABLE. Auto-instrumentation works by
 * monkey-patching modules as they are `require`d — it wraps `http.request`,
 * Express's router, the `pg` client, `amqplib`'s channel, even Pino. A
 * module that was already loaded is already the unpatched version, and
 * nothing will be traced through it. So this is imported on the FIRST line
 * of every `main.ts`, above Nest, above everything:
 *
 * ```ts
 * import '@ecommerce/observability/tracing';   // first, always
 * import { NestFactory } from '@nestjs/core';
 * ```
 *
 * The one thing that makes this work at all here: this project's builds keep
 * `node_modules` EXTERNAL (see `generatePackageJson` in each webpack config),
 * so `express` and `pg` are genuinely `require`d at runtime and can be
 * patched. Bundle them into the output and every instrumentation silently
 * does nothing — you get traces, they are just empty, which is a miserable
 * afternoon.
 *
 * WHAT A TRACE ADDS THAT A LOG DOES NOT. The logs from pass 1 tell you WHAT
 * happened, in order. A trace tells you WHERE THE TIME WENT:
 *
 * ```text
 * POST /api/orders                                      947ms
 *   ├─ GET cart:3004 /cart                               31ms
 *   │   └─ SELECT carts … JOIN cart_items                 4ms
 *   ├─ INSERT orders / order_items                        9ms
 *   └─ publish order.confirmed → ecommerce.events         2ms
 * POST /api/payments                                    905ms
 *   └─ charge (mock provider)                           901ms   ← there it is
 * ```
 *
 * No number of log lines makes that shape visible, because a log line has no
 * duration and no parent.
 *
 * EVERY IMPORT IN HERE IS LAZY, and that is deliberate. The OpenTelemetry SDK
 * and its auto-instrumentations are a large dependency tree, and this is off
 * by default — "off" should mean the cost is not paid at all, not that it is
 * paid and then discarded. Eight services each loading a tracing SDK they
 * were told not to use is a second of startup nobody asked for.
 */

interface TracingOptions {
  service: string;
  /** Off entirely when false — nothing is even loaded. */
  enabled: boolean;
  /**
   * `otlp`    send to a collector (SigNoz) over HTTP.
   * `console` print spans to stdout. THE DEFAULT, so tracing can be seen
   *           with no infrastructure at all — the same reasoning as
   *           `MAIL_TRANSPORT=log` in the Notification Service.
   */
  exporter: 'otlp' | 'console';
  endpoint: string;
}

function readOptions(): TracingOptions {
  // `.env` is loaded HERE rather than by Nest's ConfigModule, because that
  // does not exist yet — this runs before the application is constructed.
  // Loading it twice is harmless: dotenv never overwrites a variable that is
  // already set, which is also why a value passed on the command line still
  // wins over the file.

  const dotenv = require('dotenv') as { config: () => void };
  dotenv.config();

  return {
    service: process.env['OTEL_SERVICE_NAME'] ?? 'unknown-service',
    enabled: process.env['OTEL_ENABLED'] === 'true',
    exporter: process.env['OTEL_EXPORTER'] === 'otlp' ? 'otlp' : 'console',
    endpoint:
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318',
  };
}

/** Builds and starts the SDK. Returns whether it actually started. */
export function startTracing(): boolean {
  const options = readOptions();

  if (!options.enabled) {
    return false;
  }

  const { NodeSDK } =
    require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } =
    require('@opentelemetry/auto-instrumentations-node') as typeof import('@opentelemetry/auto-instrumentations-node');
  const { resourceFromAttributes } =
    require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } =
    require('@opentelemetry/sdk-trace-base') as typeof import('@opentelemetry/sdk-trace-base');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    require('@opentelemetry/semantic-conventions') as typeof import('@opentelemetry/semantic-conventions');

  // The exporters, loaded only for the mode actually in use.
  const { OTLPTraceExporter } =
    options.exporter === 'otlp'
      ? (require('@opentelemetry/exporter-trace-otlp-http') as typeof import('@opentelemetry/exporter-trace-otlp-http'))
      : { OTLPTraceExporter: undefined };
  const { OTLPMetricExporter } =
    options.exporter === 'otlp'
      ? (require('@opentelemetry/exporter-metrics-otlp-http') as typeof import('@opentelemetry/exporter-metrics-otlp-http'))
      : { OTLPMetricExporter: undefined };
  const { PeriodicExportingMetricReader } =
    options.exporter === 'otlp'
      ? (require('@opentelemetry/sdk-metrics') as typeof import('@opentelemetry/sdk-metrics'))
      : { PeriodicExportingMetricReader: undefined };

  const spanProcessor =
    OTLPTraceExporter === undefined
      ? // SIMPLE for the console: batching would mean spans appear seconds
        // after the request that produced them, which defeats the point of
        // watching them go by.
        new SimpleSpanProcessor(new ConsoleSpanExporter())
      : // BATCHED for a real exporter: one HTTP request per few hundred
        // spans rather than one per span. Tracing that costs a network round
        // trip per operation is tracing somebody will turn off.
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
        );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      // What every span is labelled with. Without it, eight services' spans
      // arrive as one anonymous heap — which is why OTEL_SERVICE_NAME is set
      // per service in its `serve` target rather than once in `.env`.
      [ATTR_SERVICE_NAME]: options.service,
      [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.0.0',
    }),

    spanProcessors: [spanProcessor],

    // METRICS only go to a collector. There is no console metric exporter
    // worth having: a metric is an aggregate over time, and a number printed
    // to a terminal every fifteen seconds tells you nothing a log line did
    // not already.
    ...(PeriodicExportingMetricReader === undefined ||
    OTLPMetricExporter === undefined
      ? {}
      : {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: `${options.endpoint}/v1/metrics`,
            }),
            // Exported on a timer rather than per event. 15s is frequent
            // enough to watch an incident unfold and cheap enough to leave
            // on.
            exportIntervalMillis: 15_000,
          }),
        }),

    instrumentations: [
      getNodeAutoInstrumentations({
        /**
         * OFF DELIBERATELY. `fs` produces a span for every file read —
         * thousands per second at startup — and buries the ones that mean
         * something. Auto-instrumentation is a good default and a bad
         * absolute.
         */
        '@opentelemetry/instrumentation-fs': { enabled: false },

        /** Also off: it spans every DNS lookup, including the pooled ones. */
        '@opentelemetry/instrumentation-dns': { enabled: false },

        '@opentelemetry/instrumentation-http': {
          // Health checks and metrics scrapes would otherwise be most of the
          // trace volume and none of the interest.
          ignoreIncomingRequestHook: (request: { url?: string }) =>
            request.url === '/health' || request.url === '/metrics',
        },
      }),
    ],
  });

  sdk.start();

  /**
   * Flush on the way out.
   *
   * Spans are batched, so a process that exits without this loses whatever
   * had not been sent — and the spans you most want are the ones from just
   * before it died.
   */
  const shutdown = (): void => {
    void sdk.shutdown().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return true;
}
