# Observability

Three signals, and they answer different questions. Reaching for the wrong
one is how an afternoon disappears.

| Signal      | Answers                    | Where it lives                     |
| ----------- | -------------------------- | ---------------------------------- |
| **Logs**    | _What happened, in order?_ | stdout, JSON, one line per event   |
| **Traces**  | _Where did the time go?_   | spans with a parent and a duration |
| **Metrics** | _How often, and how bad?_  | aggregates over time — rates, p99s |

A log line has no duration and no parent, so no number of them shows you that
checkout spent 900ms inside the payment provider. A trace shows exactly that
and tells you nothing about how often it happens. A metric tells you how often
and nothing about which request.

---

## Logs — always on

Every service logs JSON to stdout through Pino. Every line carries:

```json
{
  "level": "info",
  "time": "2026-09-15T07:29:16.821Z",
  "service": "gateway",
  "correlationId": "proof-12345",
  "trace_id": "76f56508b1c7f4e632396a9a3b36603d",
  "span_id": "46aa4f0ab4761e76",
  "context": "HTTP",
  "method": "GET",
  "url": "/api/products",
  "status": 503,
  "durationMs": 23.8,
  "msg": "GET /api/products 503 23.8ms"
}
```

| Variable     | Default |                                                                    |
| ------------ | ------- | ------------------------------------------------------------------ |
| `LOG_LEVEL`  | `info`  | `trace` … `fatal`. Turn it up during an incident without a deploy. |
| `LOG_PRETTY` | `false` | Colourised lines instead of JSON. `true` locally.                  |

**Redacted on every line**, including lines added later by someone not
thinking about it: `authorization`, cookies, `password`, `passwordHash`,
`accessToken`, `paymentMethodToken`, `cardNumber`, `cvv`.

### The correlation id

Minted at the API Gateway per customer action — or adopted from an
`X-Correlation-Id` header the client supplies — and carried to every service
it touches:

```text
client → gateway      X-Correlation-Id, or the gateway mints one
gateway → service     the same header on every proxy call
service → service     the same header (cart→product, order→cart, payment→order)
service → RabbitMQ    a correlationId field on the event payload
RabbitMQ → consumer   the handler re-enters the scope from the payload
gateway → client      echoed on the response
```

```bash
npm start | grep 9f2c1a7e
```

Nothing carries it automatically. Every outbound client spreads
`...correlationHeaders()`, every publisher stamps `correlationIdForEvent()`,
and every message handler calls `runWithCorrelationId()`. An omission is
visible in review and invisible at runtime, which is why it is explicit.

---

## Traces — off by default

```bash
# .env
OTEL_ENABLED=true
OTEL_EXPORTER=console       # no infrastructure needed at all
```

Spans print to stdout: every HTTP request in and out, every SQL statement,
every Redis command, every AMQP publish and consume — automatically, because
the instrumentation patches those libraries as they load.

```text
POST /api/orders                                      947ms
  ├─ GET cart:3004 /cart                               31ms
  │   └─ SELECT carts … JOIN cart_items                 4ms
  ├─ INSERT orders / order_items                        9ms
  └─ publish order.confirmed → ecommerce.events         2ms
POST /api/payments                                    905ms
  └─ charge (mock provider)                           901ms   ← there it is
```

**`import '@ecommerce/observability/tracing'` is the first line of every
`main.ts`, and it has to stay there.** Instrumentation patches modules as they
are `require`d; anything imported above that line is the unpatched version and
will never appear in a trace.

It works here only because the builds keep `node_modules` **external**
(`generatePackageJson` in each webpack config). Bundle them and the
instrumentation silently does nothing — you get traces, they are just empty.

`OTEL_SERVICE_NAME` is set **per service** in its `serve` target, not in
`.env`: one value in the shared file would label all eight services
identically, and a trace where everything is called "ecommerce" tells you
nothing.

---

## SigNoz — traces and metrics with a UI

```bash
# .env
OTEL_ENABLED=true
OTEL_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

SigNoz is a Docker Compose stack — ClickHouse, a collector, a query service
and a UI — not a library, which is why it is the last thing in this milestone
rather than the first. Run it from its own repository:

```bash
git clone -b main https://github.com/SigNoz/signoz.git
```

```bash
cd signoz/deploy/docker && docker compose up -d
```

The UI is then at http://localhost:8080 and the OTLP endpoint at `:4318`,
which is what the services are configured for. Start the stack, place an
order, and the whole checkout appears in **Traces** as one waterfall across
four services.

> **Not verified here.** SigNoz's compose file is theirs and changes with
> their releases; the exporter configuration above is what this system sends,
> and it is standard OTLP/HTTP. If the endpoint or the UI port has moved,
> their README is the authority.

Any OTLP collector works — Jaeger (`:4318` too), Grafana Tempo, Honeycomb, a
plain `otel-collector`. Nothing in this codebase names SigNoz.

### What metrics arrive

The auto-instrumentation emits HTTP server and client duration histograms, so
request rate, error rate and latency percentiles are available without a line
of application code. Custom business metrics — orders placed, payments
declined — are a deliberate next step, not an omission: a metric is cheap to
add and expensive to have too many of.

---

## Reading an incident

1. **A customer reports a failure.** They quote the correlation id from the
   response, or you find it by searching their order number in the logs.
2. **`grep` it.** Every line from every service, in order, with the failure
   in it.
3. **Click through to the trace** from any of those lines — `trace_id` is on
   all of them — to see which hop was slow, or where it stopped.
4. **Check the metric** to learn whether it is one customer or everyone.

Each step answers something the previous one cannot.
