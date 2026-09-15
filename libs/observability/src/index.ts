/**
 * The public surface of `@ecommerce/observability`.
 *
 * Eight consumers, which is as clear a case for a shared library as this
 * project has had: the logging format, the redaction list and the
 * correlation header must be IDENTICAL across every service, or the logs
 * cannot be searched as one stream and the trail breaks at the first hop
 * that spells the header differently.
 */
export * from './lib/correlation';
export * from './lib/correlation.middleware';
export * from './lib/observability.module';
export * from './lib/pino-logger.service';
