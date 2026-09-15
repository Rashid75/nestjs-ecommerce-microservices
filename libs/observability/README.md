# @ecommerce/observability

Structured logging and correlation ids, shared by every service.

```ts
// main.ts
const logger = app.get(PinoLoggerService);
app.useLogger(logger);
app.use(correlationMiddleware(logger));
```

```ts
// an outbound HTTP call
headers: { 'x-user-id': userId, ...correlationHeaders() }
```

```ts
// a message handler, re-entering the scope on the other side of the broker
await runWithCorrelationId(payload.correlationId, () => this.handle(payload));
```

One id is minted at the API Gateway per customer action and travels with it —
through HTTP headers, and through the `correlationId` on every event payload.
`grep <id>` across eight services returns that one journey, in order.

Read `src/lib/correlation.ts` for why the id lives in `AsyncLocalStorage` and
not in a module-level variable, and `src/lib/pino-logger.service.ts` for what
is redacted and why.
