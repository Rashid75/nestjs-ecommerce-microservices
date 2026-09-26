# Project Plan & Progress

The 15-milestone plan for this backend, with what is actually built as of
**2026-09-15**.

This file is the source of truth for progress. It is updated at the end of
every milestone — completed work moves from _Planned_ to _Delivered_, and
anything deliberately deferred is recorded with the **trigger** that should
bring it back, rather than a vague "later".

|                         |                                                                       |
| ----------------------- | --------------------------------------------------------------------- |
| **Milestones complete** | 14 of 15 — M13 (testing) skipped at Rashid's request                  |
| **Services running**    | Gateway, Auth, Product, Inventory, Cart, Order, Payment, Notification |
| **Infrastructure**      | PostgreSQL 18, Redis 7, RabbitMQ 3, OpenTelemetry, Docker Compose     |
| **Databases**           | one per service, seven in total                                       |
| **Next milestone**      | none — the plan is finished                                           |

```text
M1 ██ M2 ██ M3 ██ M4 ██ M5 ██ M6 ██ M7 ██ M8 ██
M9 ██ M10 ██ M11 ██ M12 ██ M13 ⊘⊘ M14 ██ M15 ██
```

---

## Working agreement

This is a **learning project**. The rules it runs under:

1. **One milestone at a time.** Work stops at the end of each and waits for
   explicit confirmation. "Continue" means advance exactly one.
2. **Explain before building** — what, why, the architecture, the folder
   layout, the technology choice and its alternatives. Then build.
3. **Optimise for understanding**, not for finishing quickly.
4. **Fixed layering.** `Controller → Service → Repository → Model → PostgreSQL`.
   No Sequelize in a controller, ever.
5. **`synchronize: false`.** Every schema change is a migration.
6. **Database per service.** No service reads another's tables.
7. **Commits are manual.** Changes are prepared; Rashid reviews and commits.
8. **Simple first, then the complexity — inside the same milestone.** Where a
   milestone has a hard idea in it, build the plain version first, run it,
   and find its defects by hand. Only then add the machinery that fixes them,
   with the specific failure it answers named next to it. A pattern
   introduced before its problem is a pattern taken on trust, and this
   project is not for accumulating trust. Milestone 8 was the first split
   this way: a plain Order Service, then order events — and the saga and the
   outbox were left in the deferred table, each with the failure that should
   bring it back.

---

## Current architecture

```text
   Client
     ▼
┌──────────────────────┐
│  API Gateway :3000   │  public · /api · DTO validation · auth guard · routing
└──────────┬───────────┘
           │ HTTP (axios, 5s timeout, honest failure mapping, X-User-Id)
   ┌───────┼────────┬──────────────┬──────────────┐
   ▼       ▼        ▼              ▼              ▼
┌──────┐ ┌───────┐ ┌───────────┐ ┌────────┐ ┌────────────┐
│Auth  │ │Product│ │Inventory  │ │Cart    │ │Order :3005 │  all on 127.0.0.1
│:3001 │ │:3002  │ │:3003      │ │:3004   │ │(saga owner)│
└──┬───┘ └───┬───┘ └─────┬─────┘ └───┬────┘ └─────┬──────┘
   ▼         ▼           ▼           ▼            ▼
ecommerce_ ecommerce_ ecommerce_  ecommerce_  ecommerce_
 auth_db   product_db inventory_db  cart_db     order_db

Checkout, then payment — two separate calls, each retryable on its own:
   Order   ──GET /cart──────────────► Cart        read, nothing to undo
   Order   ──write order + items────► its own DB  one local transaction
   Order   ──order.confirmed────────► RabbitMQ    the cart converts itself
   Payment ──GET /orders/:id────────► Order       amount + ownership
   Payment ──charge──────────────────► provider   approved · declined · ?
   Payment ──payment.succeeded──────► RabbitMQ    the order marks itself PAID
   No stock is reserved — see the deferred table.

RabbitMQ :5672   topic exchange ecommerce.events, one queue per consumer
   Auth      → user.registered
   Product   → product.price_changed · product.archived
   Inventory → inventory.reserved · inventory.released
   Order     → order.confirmed · order.cancelled
   Payment   → payment.succeeded · payment.failed
   Notify    → nothing. It is purely a consumer.

   queue cart_service          ← product.* · order.confirmed
   queue order_service         ← payment.succeeded · payment.failed
   queue notification_service  ← user.registered · order.confirmed
                                 · payment.succeeded
   order.confirmed goes to TWO of them, each getting its own copy — which is
   the whole reason M10 replaced the single shared queue with an exchange.

Every request and every event carries a CORRELATION ID, minted at the
gateway. `grep <id>` across all eight services returns one customer's
journey, in order.

Redis :6379   ecom:gateway:*  rate-limit counters + token introspection
              ecom:product:*  cache-aside entries (optional, fails open)
```

Target, for reference — this is where it ends up, not where it is:

```text
Gateway → Auth · Users · Products · Inventory · Cart → Orders → Payment · Notification
Infrastructure: PostgreSQL · Redis · RabbitMQ · MailHog · OpenTelemetry · SigNoz
```

---

## ✅ Milestone 1 — Nx Workspace and Project Foundation

**Status: complete.**

### Delivered

- Nx 23 monorepo, npm, one dependency tree
- NestJS 11, TypeScript in `strict` mode plus `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitOverride`
- `useDefineForClassFields: false` — required by decorator-based ORMs
- ESLint flat config with real `@nx/enforce-module-boundaries` constraints:
  `type:app` may depend only on `type:lib`; nothing may depend on an app
- Prettier, `.gitattributes` for LF normalisation
- `@nestjs/config` + Joi validation that **refuses to boot** on bad config
- `.env.example` committed; `.env` git-ignored
- README with architecture, stack and decisions

### Key decisions

| Decision                      | Why                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Monorepo over polyrepo        | Nine services sharing contracts and CI; Nx gives an affected-graph and caching. Cost: boundaries need tooling, not physics. |
| Boundary tags from day one    | A monorepo without them becomes a distributed monolith. The rule must exist before the temptation does.                     |
| Strict TypeScript immediately | Retrofitting it across nine services later is a multi-day slog.                                                             |
| No `libs/` yet                | A shared library with one consumer is a guess at an interface.                                                              |

---

## ✅ Milestone 2 — API Gateway + Auth Foundation

**Status: complete, verified end to end.**

### Delivered

**Auth Service** (`:3001`, bound to `127.0.0.1`)

- Sequelize + sequelize-typescript; `synchronize` hardcoded `false`
- sequelize-cli wired for a monorepo via absolute `.sequelizerc` paths
- `users` migration: UUID PK, unique email index, lowercase and role CHECK
  constraints, all inside one transaction
- `User` model with `defaultScope` excluding `passwordHash`, and one named
  `withPasswordHash` scope used only by the login path
- `UsersRepository` — the only Sequelize consumer; returns plain records
- Registration and login with bcrypt (cost 12)
- Timing-equalised login via a dummy hash; identical responses for unknown
  email, wrong password and disabled account
- Passport JWT strategy, `JwtAuthGuard`, `@CurrentUser()` decorator

**API Gateway** (`:3000`, public)

- Forwards `/api/auth/*` over HTTP with a 5s timeout
- Honest failure mapping: pass-through status · 503 · 504 · 502
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`)

**`libs/contracts`** — auth DTOs shared by both apps. No models shared.

**Tooling** — Postman collection (13 requests, 4 folders, ~30 assertions),
per-service Node inspector ports, `npm run stop` for orphaned dev servers.

### Key decisions

| Decision                                           | Why                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 15-minute access token                             | A signed token cannot be revoked. Its lifetime _is_ the blast radius of a stolen one.                  |
| DB lookup on every authenticated request           | Disabling an account takes effect immediately, at the cost of one PK lookup. Redis absorbs this in M4. |
| HS256, for now                                     | Correct while one service both signs and verifies.                                                     |
| Uniqueness by unique index, not pre-check          | Check-then-insert is a race; only the index is atomic.                                                 |
| Enumeration accepted at register, refused at login | Shopper experience vs. attack surface, decided per endpoint rather than globally.                      |

### Verified

Register → login → `/auth/me` → duplicate 409 → wrong password 401, all green
through the gateway. 7 unit tests.

---

## ✅ Milestone 3 — Product Service

**Status: complete.**

### Delivered

**Product Service** (`:3002`, bound to `127.0.0.1`)

- `categories` and `products` migrations, each in one transaction
- Soft delete (`paranoid`) on both, with **partial** unique indexes so a
  deleted row does not reserve its slug or SKU forever
- `price` as `DECIMAL(12,2)`, never a float; exposed as an exact string
- Foreign key `products.category_id → categories.id ON DELETE RESTRICT`
- Four purpose-built indexes, each justified in the migration
- Full CRUD for products and categories through
  `Controller → Service → Repository → Model`
- Pagination, search, category filter, status filter, price range, sorting
- `ORDER BY` restricted by an enum allow-list — the one thing SQL cannot
  parameterise

**API Gateway** — `/api/products` and `/api/categories`, a second `HttpModule`
with its own baseURL, and the forwarding logic extracted to a shared
`UpstreamProxy` now that there are two downstream services.

**`libs/contracts`** — catalog DTOs and a reusable pagination envelope.

### Key decisions

| Decision                             | Why                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DECIMAL(12,2)`, exposed as a string | Floats cannot represent 19.99. Rounding errors in money reach an accountant before an engineer. Integer minor units revisited at M9. |
| Offset pagination                    | A catalogue with "page 3 of 47" wants page numbers. Keyset is for infinite scroll and exports.                                       |
| Sort field as an enum                | `ORDER BY $1` does not exist; an allow-list is the only real defence.                                                                |
| Flat categories, no tree             | Nesting costs recursive CTEs, cycle checks and "include descendants?" in every query. Adding `parent_id` later is additive.          |
| Soft delete everywhere               | Order history will reference products long after they stop being sold.                                                               |
| `ON DELETE RESTRICT`, not CASCADE    | Deleting a category must not silently delete its products. Referential integrity should be loud.                                     |
| Explicit patch construction          | Spreading a DTO includes `undefined` keys and writes NULL over NOT NULL columns — the classic way PATCH destroys data.               |

### Verified

Type-check, lint and 18 unit tests across three projects.

---

## ✅ Milestone 4 — Redis and Caching

**Status: complete.**

### Delivered

**`libs/redis`** — the third library, created because there were two real
consumers, not in anticipation of one.

- `RedisModule.forRootAsync` — one lazily-connected ioredis client per app,
  each with its own key prefix (`ecom:gateway:`, `ecom:product:`), since
  Redis has no per-service isolation the way PostgreSQL has databases
- `CacheService` — cache-aside `getOrSet`, TTL with jitter, negative
  caching, generation-based invalidation, best-effort single flight
- **Every operation fails open.** Redis down means slower, never broken

**Product Service** — cache-aside over the catalogue

- `GET /products/:id` cached for 300s, with single-flight rebuild
- `GET /products` cached for 60s, keyed by a stable hash of every parameter
  that changes the result
- Writes `DEL` the detail key and `INCR` the list generation, after the
  database commit
- `X-Cache: HIT | MISS` on every read, relayed by the gateway
- `CACHE_ENABLED=false` kill switch
- Categories deliberately **not** cached — twenty rows, one indexed query

**API Gateway** — Redis-backed rate limiting

- Global guard, so a new endpoint inherits a budget instead of having none
- `@RateLimit()` per route, `@SkipRateLimit()` to opt out
- `/auth/login` 5/min, `/auth/register` 5/15min, everything else 100/min
- Atomic INCR + EXPIRE via a Lua script
- `X-RateLimit-Limit`, `-Remaining`, `-Reset` and `Retry-After`
- `RATE_LIMIT_FAIL_OPEN` — an explicit availability-vs-security switch

### Key decisions

| Decision                                                  | Why                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cache-aside, not write-through/behind                     | Only caches what is read; a cache failure degrades to slower, not wrong or lost.                                                           |
| Cache fails open, boot does not require Redis             | A cache is an optimisation. An optimisation must never be a hard dependency. Contrast with PostgreSQL, which is proven at boot.            |
| Generation counter, never `KEYS` + `DEL`                  | `KEYS` blocks single-threaded Redis across the whole keyspace. `INCR` invalidates every list page in O(1).                                 |
| Invalidate after the write, and delete rather than update | Invalidating first lets a concurrent read repopulate from the old row. Writing the new value lets two updates land out of order and stick. |
| TTL jitter                                                | Keys written together would otherwise expire together and hand the database a cliff instead of a slope.                                    |
| Negative caching                                          | Without it the cache protects only the happy path — the one an attacker avoids.                                                            |
| Lua script for the limiter                                | `INCR` then `EXPIRE` is two round trips; a crash between them creates a key with no TTL and a permanently locked-out client.               |
| Rate limiter is global                                    | Per-route guards fail open when forgotten. Global fails closed.                                                                            |
| `X-Forwarded-For` ignored                                 | Client-supplied, so trusting it without a real proxy makes the limiter trivially bypassable. Needs `trust proxy` at deployment time.       |
| Fail-open by default, configurable                        | Availability is the likelier incident today; fail-closed is defensible for credential endpoints in production.                             |

### Verified

34 unit tests (12 cache, 15 product, 7 auth). With Redis **stopped**: all
three services boot, log `running without cache`, serve the catalogue with
`X-Cache: MISS`, and pass eight rapid logins through un-throttled — the
fail-open path, confirmed end to end.

---

## ✅ Milestone 5 — Inventory Service

**Status: complete.**

### Delivered

**Inventory Service** (`:3003`, bound to `127.0.0.1`)

- `inventory_items` — one row per product: `onHand`, `reserved`, a
  `version` counter, and **no foreign key** to `products` (different
  database — that absence is the design)
- `stock_movements` — an append-only ledger with signed quantities and the
  balances captured after each movement
- Three CHECK constraints, including the anti-overselling invariant
  `quantity_reserved <= quantity_on_hand`
- Operations: receive, reserve, release, fulfil, adjust — each one atomic,
  each one writing balance and ledger in the SAME transaction
- `reserveWithPessimisticLock()` kept unwired, purely to read beside the
  production path
- **No Redis**: stock is the one thing in this system that must never be
  cached

**API Gateway** — `/api/inventory/*`, with a 30/min budget on `reserve`
because inventory exhaustion is a denial of service against the _business_,
not the infrastructure.

**`tools/oversell-demo.mjs`** — fires N concurrent reservations at one unit
and asserts exactly one succeeds. The only thing that can actually prove the
race is closed.

### Key decisions

| Decision                                   | Why                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic conditional UPDATE for reserve      | The check lives in the WHERE clause, so there is no window between deciding and acting. One round trip, no lock held across application logic. |
| Not `SELECT ... FOR UPDATE` as the default | Correct, but holds a lock for as long as the application takes to decide. Reserve for decisions spanning several rows.                         |
| A transaction alone is NOT enough          | Under READ COMMITTED a plain SELECT takes no lock. Atomicity is not mutual exclusion — the most common misunderstanding in this area.          |
| `available` derived, never stored          | A stored third column drifts, and then you cannot tell which of the three is wrong.                                                            |
| Reserve does not touch `onHand`            | Until goods ship they are physically on the shelf. Decrementing early makes the system disagree with the warehouse.                            |
| Append-only ledger                         | "We have 7" is not an answer to "why 7?". Also where idempotency lives in M8.                                                                  |
| Invariants as CHECK constraints            | They hold for every writer — including psql and a 2am data-fix script. Application validation only protects callers that use the application.  |
| 409, not 400, for insufficient stock       | The request was well formed; it lost a race. A client reading 409 knows a retry may work.                                                      |
| No cache on stock                          | A cached `available: 1` is a promise the warehouse cannot keep.                                                                                |

### Verified

45 unit tests across five projects. The concurrency property itself is
verified by `npm run demo:oversell` against a running stack — unit tests
cannot demonstrate a race, because a mocked repository has no rows to contend
over.

---

## ✅ Milestone 6 — Cart Service

**Status: complete.**

### Delivered

**Cart Service** (`:3004`, bound to `127.0.0.1`)

- `carts` + `cart_items` in PostgreSQL, with a **partial unique index**
  giving one active cart per user
- Price and name **snapshotted** from the Product Service at add-time
- `money.ts` — exact decimal arithmetic in integer minor units
- Add is an UPSERT (`ON CONFLICT DO UPDATE`); PATCH sets an absolute
  quantity; clearing empties the cart but keeps the row
- Calls the Product Service directly — the first service-to-service hop that
  does not go through the gateway

**API Gateway** — the first **authenticated** resource

- `AuthenticatedUserGuard`: verifies tokens by INTROSPECTING `/auth/me`,
  with no signing-key sharing, cached in Redis for 30s under a SHA-256 hash
  of the token
- Forwards only the resolved user id as `X-User-Id`
- Fails CLOSED when Auth is unreachable — the deliberate opposite of the rate
  limiter's default

### Key decisions

| Decision                                  | Why                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL, not Redis, for the cart       | Durable, queryable for abandonment analytics, transactional with order creation. The speed win was a few hundred microseconds on a sub-millisecond operation. |
| Redis IS used — for token introspection   | The one thing here that is genuinely a cache: read-mostly, reconstructible, bounded staleness.                                                                |
| Snapshot the price                        | Stable totals, renders without the catalogue, and a record of what the customer was shown. Re-validated at checkout (M8).                                     |
| Integer minor units for arithmetic        | Float drift appears for _some_ prices and not others, so spot-checking proves nothing.                                                                        |
| Absolute quantity on PATCH                | A delta is not idempotent: a retry after a timeout buys two laptops.                                                                                          |
| No `:cartId` in any route                 | Removes insecure direct object reference structurally — there is no id to tamper with and no ownership check to forget.                                       |
| Introspection, not local JWT verification | An HS256 key that can verify can also mint. RS256 remains the clean fix.                                                                                      |
| Guard fails closed                        | Failing open on rate limiting is degradation; failing open on authentication is a complete bypass.                                                            |

### Verified

62 unit tests across seven projects, and the authentication chain end to end:
no token → 401, tampered token → 401, valid token → reaches the Cart proxy.

**A real bug found by that verification.** `@UseGuards(SomeGuard)`
instantiates the guard in the module declaring the CONTROLLER, not the one
providing it — so the guard picked up CartModule's HTTP client and sent every
introspection to the Cart Service. Symptom: 503 for every token, valid or
not. Fixed with a named, exported injection token.

Also verified this milestone: `npm run demo:oversell` — **20 concurrent
reservations against 1 unit, exactly 1 succeeded**. That was Milestone 5's
outstanding claim.

---

## ✅ Milestone 7 — RabbitMQ Messaging

**Status: complete.**

Built with **NestJS's built-in RabbitMQ integration**, not a custom framework.
The guiding rule for this project: _keep the implementation simple until the
lesson requires more complexity._

### Delivered

**Publishers** — `ClientsModule.registerAsync()` in each publishing feature
module, giving a `ClientProxy` to inject:

| Service   | Emits                                       |
| --------- | ------------------------------------------- |
| Auth      | `user.registered`                           |
| Product   | `product.price_changed`, `product.archived` |
| Inventory | `inventory.reserved`, `inventory.released`  |

**Consumer** — the Cart Service is a **hybrid application**: HTTP and RabbitMQ
in one process. `CatalogueEventsController` carries `@EventPattern()`
handlers that flag cart lines when a product's price changes or it is
archived. It does not reprice — the snapshot is what the customer was shown.

**Contracts** — pattern strings and payload types in `@ecommerce/contracts`,
so publisher and consumer cannot drift on spelling.

### Deliberately NOT built

Everything below was considered and left out, because nothing in this
milestone needs it yet:

| Not built                                        | Comes back when                                        |
| ------------------------------------------------ | ------------------------------------------------------ |
| Custom connection manager                        | Never — Nest owns the connection                       |
| Custom publisher / consumer abstraction          | Never, unless Nest's stops fitting                     |
| Retry with backoff                               | A handler failure needs surviving                      |
| Dead-letter queue                                | A poison message actually blocks a queue               |
| Idempotency ledger                               | A duplicate delivery causes real damage — M8           |
| Transactional outbox                             | A lost event means a lost order — M8                   |
| Event envelope (eventId, correlationId, version) | Tracing (M11) and idempotency (M8) need them           |
| Topic exchange with bindings                     | A second service needs its own copy of the same events |

### Key decisions

| Decision                                          | Why                                                                                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/microservices` over raw amqplib          | Fewer moving parts, idiomatic Nest, nothing to maintain. Learn the framework's answer before building your own.                                                                                       |
| `emit()`, not `send()`                            | `emit` is fire-and-forget for EVENTS; `send` is request/response for COMMANDS (`@MessagePattern`). Nobody replies to "a user registered".                                                             |
| Past-tense event names                            | `user.registered`, never `send.welcome.email`. The second couples Auth to the existence of an email system.                                                                                           |
| One shared queue                                  | Nest's RMQ transport is queue-centric. Simple, with a real limitation: a second consuming service would COMPETE for messages rather than each getting a copy. Exchanges answer that, when we need it. |
| `ClientsModule` in the FEATURE module             | It is not global, so the provider must live where it is injected. Putting it in AppModule fails with "Nest can't resolve dependencies ... EVENTS_CLIENT".                                             |
| HTTP listener started BEFORE the message listener | `startAllMicroservices()` waits for the broker and retries indefinitely. Awaiting it first means a down broker takes the whole HTTP API down with it.                                                 |
| Flag cart lines, never reprice them               | The snapshot is what the customer was shown. Checkout re-confirms (M8).                                                                                                                               |

### Verified

83 unit tests across seven projects; all five services build, lint and boot.
With RabbitMQ **stopped**: every service starts, registration still returns
201, and the catalogue API still serves — the broker is genuinely optional
for the HTTP paths.

---

## ✅ Milestone 8 — Order Service and Order Events

**Status: complete.** Built in two passes, deliberately: the plain version
first, then the messaging — so each piece answered a problem that had already
been seen rather than one taken on trust.

### Pass 1 — a plain Order Service

**Order Service** (`:3005`, `ecommerce_order_db`, inspector 9234)

```text
POST /orders
   1  GET cart:3004 /cart          read the caller's cart
   2  empty? → 400                 nothing written
   3  copy the lines into an       ONE local transaction:
      order and its items          orders + order_items
   4  return it, CONFIRMED
```

- Two tables: `orders`, `order_items`
- `order_number` from a PostgreSQL **sequence** (`ORD-00000001`) — customer
  facing, generated by the database so two concurrent checkouts cannot
  collide
- `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`
- Order lines are the **third snapshot** of the same product data:
  catalogue → cart line → order line. Each answers a different question:
  what it costs now, what the customer was shown, what they agreed to pay
- `line_total` is **stored**, unlike the cart's derived total, with a
  `CHECK (line_total = unit_price * quantity)` keeping it honest
- Cancellation is a **compare-and-set** (`WHERE status = 'CONFIRMED'`), so
  two concurrent cancellations cannot both succeed
- Every read is scoped by `user_id` **in the WHERE clause**, so a missing
  filter fails closed rather than leaking
- `libs/money` — the exact-decimal arithmetic moved out of the Cart Service
  when the Order Service became its second consumer

### Pass 2 — order events over RabbitMQ

The gap pass 1 left, and the one worth fixing first: an order was placed and
the cart stayed full.

```text
Order Service ── order.confirmed ──► ecommerce_events ──► Cart Service
                 order.cancelled                          cart → CONVERTED
```

- Published with a plain `emit()` after the commit, exactly as Auth, Product
  and Inventory already do. **No outbox** — see below
- The payload carries `cartId`, so the consumer converts the cart the order
  came from rather than "whatever is active on arrival"
- The consumer is **idempotent by construction**: a conditional
  `UPDATE … WHERE status = 'ACTIVE'` makes a duplicate delivery a no-op, with
  no processed-events ledger needed
- The Cart Service now has two message controllers, split by the source of
  the events rather than merged into one

### Key decisions

| Decision                                     | Why                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty `CreateOrderDto`, prices from the cart | A client that could send its own lines would order a £900 laptop for a penny. The empty DTO still exists so `forbidNonWhitelisted` rejects a body rather than ignoring it.                  |
| The order recomputes its own totals          | Same function, same library as the cart — but the order is the record of what will be charged, and must not depend on another service getting the multiplication right.                     |
| `line_total` stored, cart total derived      | A cart is a working document; an order is a financial record that must report the same figure in five years.                                                                                |
| Order number from a sequence                 | Non-transactional on purpose: two checkouts get 41 and 42 and neither waits. Gaps are an accounting curiosity; duplicate order numbers are a support incident.                              |
| 404, not 403, for someone else's order       | A 403 confirms the order exists.                                                                                                                                                            |
| `POST /orders/:id/cancel`, not `PATCH`       | A state transition that can be refused is not "write a value into a field". `PATCH` invites a client to believe it can set SHIPPED.                                                         |
| Cart converted by an EVENT, not by a call    | A synchronous `POST /cart/convert` would put the Cart Service on the critical path of taking an order, and a failure after it would leave the customer with no basket AND no order.         |
| Publish AFTER the commit                     | The two available orderings both have a failure. Publishing first can announce an order that does not exist; publishing after can lose the announcement. The second failure is the smaller. |

### Deliberately NOT built

| Not built                           | Comes back when                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Stock reservation at checkout**   | Two customers can both order the last unit today. Reserving is a write into another service's database, so it needs an undo when a later step fails — a compensating workflow. Do it when overselling matters more than the complexity does. |
| **Stock reservation at checkout**   | Two customers can both order the last unit today. Reserving is a write into another service's database, so it needs an undo when a later step fails.                                                                                         | when it bites |
| **Saga + compensation**             | With stock reservation, or with the Payment Service — whichever forces it first.                                                                                                                                                             | M9 candidate  |
| **Transactional outbox**            | A lost event costs something real — an unsent email, an unpicked warehouse order. Today the worst case is a cart left full.                                                                                                                  | M10           |
| **`Idempotency-Key` on checkout**   | When a double-clicked checkout is observed creating two orders. The window is already small: the second click usually finds an empty cart.                                                                                                   |
| **Trace sampling**                  | Everything is sampled today. Expensive at real volume; a head sampler is one config line.                                                                                                                                                    | when measured |
| **Custom business metrics**         | A dashboard that needs one. Cheap to add, expensive to have too many of.                                                                                                                                                                     | on demand     |
| **Alerting**                        | Metrics exist and nothing watches them.                                                                                                                                                                                                      | M12           |
| **Log shipping**                    | Logs are JSON on stdout, which is right — but nothing collects them. Needed the moment there is more than one machine.                                                                                                                       | M14           |
| **Order events consumed elsewhere** | The Notification Service, M10 — and that is also when one queue stops being enough and a topic exchange is needed.                                                                                                                           |

### Verified

94 unit tests across eight projects; all six services build and lint. With
RabbitMQ **stopped**, checkout still returns 201 and the order is written —
only the cart conversion is delayed, which is the failure the publish-after-
commit choice accepts.

---

## ✅ Milestone 9 — Payment Service

**Status: complete.** Split the same way as M8: the plain version first,
then the machinery that fixes what it visibly got wrong.

### The flow

```text
POST /api/payments { orderId, paymentMethodToken }
   │
   1  GET order:3005 /orders/:id     amount + ownership, server-side
   2  write payment PENDING          BEFORE calling out
   3  charge the mock provider       approved · declined · no answer
   4  settle the row + publish       payment.succeeded / payment.failed
                                          │
                                          ▼
                        Order Service consumes it: CONFIRMED → PAID
```

### Delivered

**Payment Service** (`:3006`, `ecommerce_payment_db`, inspector 9235)

- One table, `payments` — **one row per attempt**, not per order. A declined
  attempt followed by a successful one leaves two rows, and both matter
- `reference` from a PostgreSQL sequence (`PAY-00000001`)
- `POST /payments`, `GET /payments`, `GET /payments/:id`
- **The amount is never in the request.** It is read from the order, which
  read it from the cart, which read it from the catalogue
- Ownership is enforced by forwarding `X-User-Id` to the Order Service, so
  paying for a stranger's order fails on the same 404 that stops reading it

**The mock provider** — six test tokens, modelled on real test cards:

| Token             | What happens                            |
| ----------------- | --------------------------------------- |
| `tok_ok`          | approved                                |
| `tok_declined`    | declined — insufficient funds           |
| `tok_fraud`       | declined — suspected fraud              |
| `tok_timeout`     | takes 30s, so the deadline really fires |
| `tok_unavailable` | provider is down                        |
| `tok_flaky`       | fails about half the time               |

**The Order Service is now a hybrid application** — HTTP plus a RabbitMQ
listener, like the Cart Service. It consumes `payment.succeeded` and moves
the order CONFIRMED → PAID with a conditional UPDATE, so a duplicate delivery
is a no-op and a cancelled order can never be quietly marked paid.

### Key decisions

| Decision                                              | Why                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tokens, never card data**                           | The schema has no `card_number`, no CVV, no expiry — only a provider token, a last-4 and a brand. Data you never hold cannot leak, and it is what keeps this service outside PCI scope.        |
| **A separate `POST /payments`**, not part of checkout | Charging inside `POST /orders` means an order that must be undone when the charge fails — a compensating workflow. Two calls keep each step individually retryable.                            |
| **Write PENDING before calling the provider**         | A process that dies mid-charge must still leave a row saying "we asked". Writing afterwards means a customer can be charged with no record that anything was attempted.                        |
| **402 vs 503** — declined vs no answer                | A decline is a decision: retrying is pointless and costs the customer a queue of failed attempts on their statement. A timeout is an absence of information: retrying is the correct response. |
| **`retryable` is stored, not derived**                | A judgement about a past event must not change because the rules changed afterwards.                                                                                                           |
| **A timeout records FAILED, never "declined"**        | The outcome is genuinely UNKNOWN — the provider kept working after we stopped waiting. Calling that a decline would be a guess presented as a fact.                                            |
| **The gateway gets its own, longer deadline**         | 20s, against the service's 10s provider deadline. If the outer timeout fires first, the inner one never gets to do its job and the customer sees a 504 for a charge that was still in flight.  |
| **A failed payment leaves the order CONFIRMED**       | The commonest thing after a decline is paying with another card. Ending the order because one card was refused would take that away.                                                           |

### Deliberately NOT built — pass 2

| Not built                                          | The failure it answers                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Idempotency-Key` on `POST /payments`**          | Send the same request twice and you get two payments. If both succeed the customer is charged twice — reproducible in one click.                                            |
| **`UNIQUE (order_id) WHERE status = 'SUCCEEDED'`** | The database currently permits two successful payments for one order. The index refuses the second; the key returns the first one's answer, and those are different things. |
| **Automatic retry of a retryable failure**         | The API says whether a retry is worth making. Nothing makes it.                                                                                                             |
| **Reconciliation of stuck PENDING rows**           | A payment whose provider never answered stays PENDING forever, and nobody is told.                                                                                          |
| **Refunds**                                        | A refund is a separate signed record, not a deleted payment. It needs its own endpoint, event and order transition.                                                         |

### Verified

110 unit tests across ten projects; all seven services build and lint. With
RabbitMQ stopped, a payment still succeeds and is recorded — only the order's
move to PAID waits for the broker.

---

## ✅ Milestone 10 — Notification Service

**Status: complete.** Pass 1 built the service, the templates and the topic
exchange it forced; pass 2 made it survive being told the same thing twice.

### The architectural change this milestone forced

M7 built one queue and wrote down its limitation: RabbitMQ delivers each
message in a queue to exactly ONE consumer. The Notification Service needs
`order.confirmed`, and so does the Cart Service — on one shared queue they
would have TAKEN TURNS, each getting roughly half.

So publishers now publish to a **topic exchange**, and every consuming
service declares its own durable queue bound to the routing keys it wants:

```text
publish "order.confirmed" ──► exchange ecommerce.events (topic)
                                 ├──► cart_service          → cart CONVERTED
                                 ├──► notification_service   → confirmation email
                                 └──► order_service          no binding, no copy
```

Nest reads the `@EventPattern()` strings in each app and creates one binding
per handler. **No publisher code changed** — only its configuration. That is
the point of an exchange: who listens is not the publisher's business, and
the fourth consumer will not touch them either.

Two replicas of one service still share that service's queue, and therefore
still compete — which is exactly what you want for scaling out. Competing
consumers _within_ a service is a feature; competing _across_ services was
the bug.

### Delivered

**Notification Service** (`:3007`, `ecommerce_notification_db`, inspector 9236)

- Consumes `user.registered`, `order.confirmed`, `payment.succeeded`
- Three emails: welcome, order confirmation, payment receipt — plain
  functions, both a text and an HTML part
- **Nodemailer with two transports**: `log` (the default, so the stack runs
  with nothing extra installed) and `smtp` for MailHog
- `GET /notifications` — read only. There is deliberately no `POST`
- The first service in the system that calls nothing and publishes nothing

**`contacts` — a projection.** An order confirmation needs an email address,
and `order.confirmed` carries only a user id, because the Order Service has
only a user id. The three ways out:

|                                 | Cost                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Call the Auth Service per email | a synchronous hop on the critical path of every receipt                                                   |
| Put the address in every event  | Order and Payment would each have to call Auth to enrich their own events — the hop moves, it does not go |
| **Keep a local copy** (this)    | the copy can be stale, and a customer who registered before this service existed has no row               |

The third is the standard answer to "a consumer needs data it does not own",
and its costs are written down rather than discovered.

### Key decisions

| Decision                                     | Why                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Emails live in their own service**         | `user.registered` is a fact; "send a welcome email" is an instruction. The moment Auth issues instructions it has to know an email system exists, then an SMS system, then who opted out of which. |
| **Topic exchange, one queue per service**    | The only arrangement where two services can both receive the same event.                                                                                                                           |
| **Queue names are constants, not config**    | A queue name identifies _who is consuming_, which is a property of the code, not of the environment.                                                                                               |
| **`MAIL_TRANSPORT=log` by default**          | Defaulting to SMTP means every receipt fails until someone starts a mail server, and the failure looks like a bug in this service rather than a missing container.                                 |
| **A send failure is recorded, never thrown** | Throwing out of a handler makes Nest nack and RabbitMQ redeliver — retrying a bad address forever, and re-sending an email that may already have gone out.                                         |
| **The body is stored, and never logged**     | "What did we send them?" needs an answer; an application log is read by more people and kept longer than anyone intends.                                                                           |
| **No contact → a FAILED row**                | An email nobody received is exactly what support needs to be able to find. Silently skipping it is the one unacceptable option.                                                                    |

### Deliberately NOT built — pass 2

| Not built                               | The failure it answers                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A processed-events ledger**           | RabbitMQ delivers at-least-once, so a redelivered `order.confirmed` sends a SECOND confirmation. Every other consumer survived that by being naturally repeatable — `UPDATE … WHERE status = 'ACTIVE'` does nothing twice. **There is no WHERE clause that un-sends an email.** This is the first place the ledger is genuinely needed, and it needs events to carry an id, which they do not yet. |
| **Retry of a failed send**              | A send that fails is recorded FAILED and left there. Nothing tries again and nothing tells anyone.                                                                                                                                                                                                                                                                                                 |
| **Notification preferences**            | Every customer gets every email. Anything beyond strictly transactional mail needs opt-outs first.                                                                                                                                                                                                                                                                                                 |
| **`order.shipped` / `order.delivered`** | Nothing publishes them — there is no fulfilment workflow yet.                                                                                                                                                                                                                                                                                                                                      |

### Verified

122 unit tests across eleven projects; all eight services build and lint.

> ⚠️ **The exchange needs one runtime check.** Every publisher and consumer was
> reconfigured, and the bindings are only created when the services connect to
> a live broker. Start RabbitMQ, run a checkout, and confirm in the management
> UI at :15672 that `ecommerce.events` exists with three queues bound to it.
> The old `ecommerce_events` queue from M7 is now unused and can be deleted
> there.

---

## ✅ Milestone 11 — Observability

**Status: complete.** Pass 1 was structured logs and correlation ids — the
half that needs no infrastructure. Pass 2 added traces and metrics.

Full reference: [docs/OBSERVABILITY.md](OBSERVABILITY.md).

### The question this answers

> "A customer says their order failed at 14:32. What happened?"

Eight processes, each writing its own lines. Before this milestone that
question took eight terminals and a lot of guessing. Now:

```text
grep 9f2c1a7e  ⇒  gateway       POST /api/orders 201 84ms
                  order         order ORD-00000042: 2 line(s), 48.24 USD
                  cart          cart 3f9…: marked CONVERTED
                  notification  ORDER_CONFIRMED → ada@example.test
                  payment       PAY-00000007: 48.24 USD approved
                  order         payment PAY-00000007: order → PAID
```

One id, minted once, carried across six HTTP hops and four RabbitMQ events.

### Delivered

**`libs/observability`** — the third shared library, and the clearest case
yet: the log format, the redaction list and the header spelling must be
identical in all eight services, or the stream cannot be searched as one and
the trail breaks at the first hop that disagrees.

- **Pino** behind Nest's `LoggerService`, so Nest's own logs come out in the
  same format. JSON in production; `pino-pretty` when `LOG_PRETTY=true`
- Every line carries `service`, `level`, `correlationId` and an ISO
  timestamp — the correlation id supplied by a `mixin`, so no call site
  passes it
- **Redaction** of `authorization`, cookies, `password`, `passwordHash`,
  `accessToken`, `paymentMethodToken`, `cardNumber`, `cvv`
- One log line per HTTP request, on `finish`, with method, path, status and
  duration — at `warn` for 4xx and `error` for 5xx, because alerting on a
  rate that includes mistyped emails gets muted
- `LOG_LEVEL` and `LOG_PRETTY` in every service's env contract

**Correlation ids**, propagated by hand at every boundary:

| Hop                 | How it travels                                                    |
| ------------------- | ----------------------------------------------------------------- |
| client → gateway    | `X-Correlation-Id` if supplied, otherwise **minted here**         |
| gateway → service   | the same header, on every proxy call                              |
| service → service   | the same header (cart→product, order→cart, payment→order)         |
| service → RabbitMQ  | `correlationId` on the event payload                              |
| RabbitMQ → consumer | the handler re-enters the scope from the payload                  |
| gateway → client    | echoed on the response, so a failed request comes with its own id |

`AsyncLocalStorage` holds it. A module-level variable would be overwritten by
the next concurrent request the moment the first one awaited anything — a
silent, intermittent bug that files one customer's actions under another.

### Key decisions

| Decision                                               | Why                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`eventId` and `correlationId` are different fields** | One identifies _this message_ ("have I handled it?"); the other identifies _the whole story_ ("what else happened because of this?"). Dedupe on a correlation id and you drop the second event of a checkout.                               |
| **Propagation is explicit at every hop**               | There is no magic that carries a header across a network. Spreading `...correlationHeaders()` into an existing headers object keeps an omission visible in review — and an omission is invisible at runtime until you need that exact path. |
| **Middleware, not an interceptor**                     | `AsyncLocalStorage.run()` must _wrap_ the work. An interceptor returns an Observable that Nest subscribes to afterwards, outside the scope; it mostly appears to work.                                                                      |
| **Scope re-entered in the controller, explicitly**     | Same reason, on the message side. Seven visible lines beat a global interceptor that silently loses context.                                                                                                                                |
| **Redaction is a blunt list, applied to every line**   | It has to cover the lines a future colleague adds without thinking about it.                                                                                                                                                                |
| **`app.useLogger()`**                                  | A system where half the lines are JSON and half are Nest's default format cannot be shipped anywhere.                                                                                                                                       |
| **A client may supply the id**                         | A front end that mints one per user action can quote it in a bug report. It is an opaque label with no authority and is never used to look anything up.                                                                                     |

### Deliberately NOT built — pass 2

| Not built                | What it adds                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenTelemetry traces** | Logs tell you _what happened_; a trace tells you _where the time went_ — a waterfall showing that checkout spent 40ms in the cart read and 900ms waiting for the provider. |
| **Metrics**              | Request rate, error rate, latency percentiles. A p99 is not visible in any number of log lines.                                                                            |
| **SigNoz**               | Somewhere to send both, and the reason this is pass 2: it is a Docker Compose stack, not a library.                                                                        |
| **Log shipping**         | The logs are JSON on stdout, which is exactly right — but nothing collects them yet.                                                                                       |

### Verified

129 unit tests across twelve projects; all eight services build and lint. The
correlation scope has its own tests, including the concurrency case, because
the failure it prevents is invisible in a log that looks perfectly fine.

Tracing was checked by running the gateway with `OTEL_EXPORTER=console` and
making a real request: the span carried `http.route: /api/products` with a
duration matching the log line's `durationMs`, the log line carried
`trace_id` and `span_id`, and a client-supplied `X-Correlation-Id` was
adopted and echoed back. With `OTEL_ENABLED=false` the process prints nothing
and loads none of it.

> SigNoz itself is **not verified here** — it is a Docker Compose stack owned
> by its own repository. The exporter configuration is standard OTLP/HTTP;
> see [docs/OBSERVABILITY.md](OBSERVABILITY.md) for how to run it.

---

## ✅ Milestone 12 — Production Hardening

**Complete, in four passes.** Simple first, then the complexity, inside the
same milestone (working agreement, rule 8).
Simple first, then the complexity, inside the same milestone (working
agreement, rule 8).

### The question this answers

> "The Order Service is running. Should it be sent traffic?"

Those are two different questions, and answering them with one endpoint is
the most common way a health check makes an outage worse. A process can be
alive and useless — its database connection gone, its broker disconnected —
and a process can be temporarily unable to serve while being perfectly
healthy. An orchestrator reacts to the two very differently:

| Probe                | Asks                                | A failure means             | Depends on          |
| -------------------- | ----------------------------------- | --------------------------- | ------------------- |
| `GET /health/live`   | "is this process wedged?"           | **kill and restart** it     | nothing at all      |
| `GET /health/ready`  | "should this instance get traffic?" | **take it out of the pool** | database, Redis, broker |

The line that matters: **liveness checks nothing**. A liveness probe that
touches the database restarts every replica during a database blip, turning
a brief dependency outage into a total application outage — and the restarts
themselves then hammer the recovering database. Readiness is where
dependencies belong, because failing it removes the instance from the load
balancer and _leaves it running_ to recover.

### Delivered — pass 1

**Health checks** (`@nestjs/terminus`), on all eight services:

- `GET /health/live` — returns 200 if the event loop can answer. Nothing else.
- `GET /health/ready` — `SELECT 1` against PostgreSQL, `PING` against Redis,
  and the broker connection state. Each with a **2-second timeout**, because
  a health endpoint that hangs is worse than one that fails: the probe itself
  then times out and takes longer to notice.
- A dependency a service does not have reports `up` with
  `detail: "not configured"` rather than being silently skipped.
- The broker is **degraded, not down**, in services that survive without it.
  The Cart Service still serves carts with RabbitMQ disconnected; only its
  catalogue flags go stale. Failing readiness for that would turn a partial
  degradation into a full outage.

Health lives behind its own entry point, `@ecommerce/observability/health`,
and is **deliberately not re-exported** from the library barrel. Terminus v12
ships ESM only; re-exported from `index.ts`, every service's Jest suite would
load it transitively through any import of the library and fail before
running an assertion. The same shape as
`@ecommerce/observability/tracing`, for a related reason.

**A global exception filter** (`AllExceptionsFilter`), on all eight services.
Two jobs, and the second is the one that matters:

1. Every error leaves in the same envelope — `statusCode`, `error`,
   `message`, `correlationId`, `path`, `timestamp` — so a client parses one
   shape.
2. An error **nobody anticipated** becomes a 500 containing nothing but the
   correlation id, while the real cause goes to the log.

A `QueryFailedError` message names the table, the column and the failing
constraint. `insert or update on table "orders" violates foreign key
constraint "orders_user_id_fkey"` is a free schema disclosure, and it reaches
a customer the moment anyone "improves" a handler to include `error.message`.
A test asserts that it does not.

Deliberate errors keep everything they were given: a 402 keeps its
`failureCode` and `retryable`, a `BadRequestException` keeps
class-validator's array of messages. The filter flattens the _unknown_, not
the considered. It also **rethrows** anything whose host is not HTTP — a
RabbitMQ handler's failure must be nacked by Nest's RMQ machinery, not turned
into an HTTP response against an undefined response object.

**Graceful shutdown** — `app.enableShutdownHooks()` on all eight. Without it
Nest never runs `onApplicationShutdown` and the process simply dies on
SIGTERM: in-flight requests cut mid-response, database and broker connections
dropped rather than closed. With it, modules tear down in reverse dependency
order, so the RabbitMQ consumer stops before the database it writes to
closes. Every internal timer added in this milestone is `unref()`'d so a
pending retry or probe cannot hold the grace period open.

**Helmet and CORS**, on the **gateway only**. The internal services bind to
127.0.0.1 and are never spoken to by a browser, so `X-Frame-Options` on the
Cart Service protects nothing. Defence in depth is real and is not an
argument for putting a control where it cannot apply — that is noise that
hides the controls that matter.

CORS is an **allow-list**, driven by `CORS_ALLOWED_ORIGINS`, and the default
is **empty, meaning no browser origin is allowed**. `origin: true` reflects
whatever origin asked, which is not a policy; with credentials enabled it is
the absence of one.

**A retry policy** in `UpstreamProxy`, and mostly a policy about _not_
retrying. Two questions, both of which must be yes:

- **Safe to repeat?** GET and HEAD only. Retrying a POST can place a second
  order or take a second payment, and the gateway cannot know whether the
  first one landed. The Payment Service solves that for itself with an
  idempotency key, because it is the only component that can.
- **Could it work next time?** Only when there was **no response** —
  `ECONNREFUSED`, `ECONNRESET`, a DNS blip. A service that answered 404 will
  answer 404 again.

A **timeout is deliberately not retried**: it is precisely the case where we
do not know whether the work happened. One retry, not five, with exponential
backoff plus jitter — every retry is load added to a system that is already
failing, multiplied by every replica doing the same thing.

### Verify

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Then stop PostgreSQL and call `/health/ready` again: it answers **503** with
the failing indicator named, while `/health/live` still answers **200**. That
difference is the whole milestone.

### Delivered — pass 2

The three things that are really one decision: you cannot verify a token at
the edge while the algorithm is symmetric, you cannot enforce roles without
verifying, and you cannot close the write endpoints without both.

**RS256, replacing the HS256 shared secret.**

| | HS256 (M2 → M11) | RS256 (M12) |
| --- | --- | --- |
| Keys | one secret | private + public |
| Who can verify | anyone holding the secret | anyone, with the public key |
| Who can **mint** | anyone holding the secret | only the private-key holder |
| Distributable? | no | the public half, freely |

That last row is the whole argument. Under HS256, letting the gateway check a
token means letting the gateway **issue** one — including an ADMIN one, from
the single process the internet can reach. The trigger written into
`auth.module.ts` back in M2 ("the moment another service needs to verify
tokens itself") arrived exactly as described.

Keys are generated by `node tools/generate-jwt-keys.mjs` into a git-ignored
`keys/`, and referenced by **path**, not value: a PEM is multi-line, and a
path also keeps key material out of the process environment — which is
readable by anything running as the same user and captured by most crash
reporters. Tokens are stamped with a `kid` that nothing reads yet, because
rotation means "accept the old key until the last token expires" and a
verifier can only do that if the tokens already say which key signed them.
Adding `kid` at rotation time is too late for every token already issued.

Also pinned, in `libs/contracts/src/lib/auth/jwt-keys.ts` so all eight
services cannot disagree: **algorithm**, **issuer**, **audience**. A verifier
that accepts "whatever the header says" is the classic JWT hole — `alg: none`
needs no signature at all, and `alg: HS256` invites the verifier to HMAC the
token with the public key, which is public.

**Verify, then ask** — the gateway's new two-step authentication.

1. **Verify locally** with the public key. Microseconds, no network. A
   forged, expired, altered or foreign token dies here, so a
   credential-stuffing run puts **zero** load on the Auth Service.
2. **Introspect**, cached 30s, for the facts a signature cannot carry: is
   this account still active, and what is its role *now*.

Dropping step 2 would be faster and would widen the revocation window from
30 seconds to the full 15-minute token lifetime. That trade is a security
regression bought with a latency win, so it is not made.

**RBAC** — `@Roles(UserRole.Admin)` plus `RolesGuard`.

The decision worth noticing: the guard reads the role from the **introspected
profile**, not from the token's `role` claim, even though the claim is right
there and free. The claim was true when the token was minted, and the token
lives 15 minutes; an admin demoted a minute ago still carries a token saying
ADMIN. A token is an assertion about the past — use it to establish *who* is
asking, and check anything that can change against the system of record.

It also distinguishes the two statuses that get confused constantly:

- **401** "I do not know who you are." Authenticate and retry.
- **403** "I know exactly who you are, and the answer is no." Retrying is
  pointless.

**The known gap, closed.** Every catalogue and inventory write now requires
an authenticated ADMIN:

| Endpoints | Before | After |
| --- | --- | --- |
| `GET /products`, `/categories`, `/inventory/:id` | public | public |
| `POST`/`PATCH`/`DELETE` products, categories | **anyone** | ADMIN |
| `POST /inventory`, `receive`, `adjust` | **anyone** | ADMIN |
| `reserve`, `release`, `fulfil` | **anyone** | ADMIN |

Guards are per-method, not on the class: a storefront catalogue is meant to
be browsed by anyone, including a crawler with no account, and guarding the
controller would break the shop to protect four endpoints.

`reserve`, `release` and `fulfil` are marked ADMIN and that is honestly the
wrong shape — they are service-to-service operations the Order Service should
perform with an identity of its own. ADMIN is correct today because only an
operator calls them; the proper answer is a service identity, deferred with
that trigger.

**Two defects found while verifying, both fixed:**

- `serve.options.env` in all eight `project.json` files — `@nx/js:node` has
  no `env` option, so **every** `nx serve` failed schema validation with
  `'env' is not found in schema`. The per-service `OTEL_SERVICE_NAME` added
  in M11 pass 2 now lives in `apps/*/src/otel-service-name.ts`, imported
  before the tracing bootstrap. TypeScript hoists imports above statements,
  so a line at the top of `main.ts` would still have run *after* tracing read
  the variable — a side-effect module imported first is the only placement
  that works. It is also a setting that now exists in production, not only in
  a dev-server config.
- `HealthModule` was in the gateway's `providers` instead of `imports`,
  where a module silently does nothing: `/health/*` 404'd on the gateway
  only. The probes are now also **excluded from the API prefix**, so the path
  is `/health/live` on all eight services rather than `/api/health/live` on
  one of them.

### Verify

An admin cannot be created through the API — an endpoint that mints its own
administrators is a privilege-escalation hole waiting to be found. Register
normally, then promote with SQL (see the commands below), and log in again.

```bash
curl -i -X POST http://localhost:3000/api/categories -H "Content-Type: application/json" -d "{\"name\":\"Nope\",\"slug\":\"nope\"}"
```

401 with no token. With a **customer** token: 403. With an **admin** token:
201. Before this pass, all three returned 201.

### Delivered — pass 3

Refresh tokens, and with them the answer to a question this system has been
dodging since M2: **how do you have long sessions without long-lived
credentials you cannot take back?**

| | access token | refresh token |
| --- | --- | --- |
| Lifetime | ~15 minutes | ~30 days |
| Checked by | signature alone | a row in `refresh_tokens` |
| Sent | every request | a few times a day |
| Format | JWT, with claims | **opaque** — 256 random bits |
| Revocable | **no** | yes, by writing one row |

The stateless access token is short *because* nothing can stop it early. The
refresh token is allowed to be long *because* it is stateful. Neither
property is a compromise; they are the reason there are two tokens.

**The refresh token is opaque, not a JWT.** A JWT is the reflex and it is
wrong here: the claims get read from the database anyway, the signature
proves nothing the row does not, and the self-contained format leaks whatever
is inside it to anyone with a base64 decoder. What it costs is real — people
see a JWT and assume it can be trusted standalone.

**Only a SHA-256 hash is stored**, never the token. This table is a list of
live credentials; a leaked backup, a support query or a compromised read
replica would otherwise let someone impersonate every user with an active
session for thirty days without touching a password. SHA-256 rather than
bcrypt is deliberate: the input is CSPRNG output, so there is no dictionary
to slow down, and a salted hash could not be looked up without scanning.

**Rotation.** Every use retires the token presented and issues a new one. A
long-lived token used over and over means a stolen copy works for thirty days
and nothing ever notices. With rotation, the thief's use and the customer's
use *collide* — and a collision is a signal.

**Reuse detection** turns that signal into a defence. Presenting an
already-rotated token means two parties hold it, and nothing distinguishes
which is the customer. So the whole **family** — every token descended from
that login — is revoked, and both parties go back to the password. Refusing
only the replayed token would leave whichever party rotated last holding a
live session, and in the bad case that is the attacker.

It is deliberately blunt. Logging a real customer out because their phone
retried on a flaky connection is a bad afternoon; leaving an attacker with a
thirty-day session is a bad year.

**The concurrency race, closed the same way every status transition in this
project is.** Two requests arriving with the same valid token — a client
retrying a timed-out call, or a thief racing the victim — must not both
succeed, or the session silently forks into two live branches. The repository
does a compare-and-set (`UPDATE … WHERE revoked_at IS NULL`) and reports
whether *this* call was the one that retired it. Exactly one wins; the loser
is treated as reuse, because from there it is indistinguishable from it.

**Every failure answers the same 401 with the same message.** "Expired"
versus "revoked" versus "never existed" is precisely the feedback someone
working through a stolen list wants. `POST /auth/logout` returns 204 even for
a token that never existed, for the same reason.

**A refresh re-reads the account.** A token issued thirty days ago says
nothing about whether the account still exists or is still enabled. A refresh
is the right moment to ask — it is the cheap, infrequent call, unlike the
access token's per-request path.

### What logout still cannot do

The access token issued minutes ago stays valid until it expires. Nothing
recalls it; the client must discard it. The residual window is the
access-token lifetime, which is exactly why that lifetime is 15 minutes and
not a day. Killing a specific access token needs a deny-list, and that is
recorded as deferred rather than quietly implied to work.

### Verify

The migration is yours to run:

```bash
npx nx run auth:migrate
```

Then, in Postman folder `1 · Auth`: **Login** → **Refresh** (200, and note the
token in the response is different) → **Refresh again — the OLD token** (401)
→ **Refresh** (401 now too — the family is gone). Log in again to continue.

### Delivered — pass 4

The dead-letter path, and with it the end of known gap #3: _"a failed handler
loses its message"_.

Nest's RMQ transport defaults to `noAck: true` — the broker considers a
message delivered the instant it is handed over. A handler that threw
produced a log line and nothing else; the message was already gone. Fine for
`product.price_changed`, where the next price change repairs it. Not fine for
`order.confirmed`, where it means a paid order whose cart is never converted
and whose customer is never emailed, with no artefact anyone can act on.

**The three options, and why the middle one is a trap:**

| | What happens | Why not |
| --- | --- | --- |
| **Drop** (`noAck: true`) | message vanishes | the failure leaves nothing to act on |
| **Requeue** (`nack`, requeue=true) | back to the head of the queue | **poison-message loop** — redelivered instantly, fails again, consumer spins at full speed forever |
| **Park** (`nack`, requeue=false + DLX) | broker moves it to a parking queue | nothing spins, nothing is lost, and "messages parked" is a number you can alert on |

We park.

**Topology.** The main exchange stays a **topic** — publishers do not know who
is listening. The dead-letter exchange is **direct**, because a parked message
goes to exactly one place: the parking queue of the service that failed it.
Each service queue carries `x-dead-letter-exchange` and, critically,
`x-dead-letter-routing-key` set to its own name — without the rewrite the
message keeps its original key (`order.confirmed`), which nothing is bound to
on a direct exchange, and it is **dropped silently**. Dead-lettering that
loses messages is worse than none, because you believe you are covered.

```text
ecommerce.events (topic)
  ├── cart_service          ──fail──►  ecommerce.events.dlx (direct)
  ├── order_service         ──fail──►        │
  └── notification_service  ──fail──►        ├── cart_service.parked
                                             ├── order_service.parked
                                             └── notification_service.parked
```

One parking queue per service, not one shared. A shared queue mixes the Cart
Service's failures with the Notification Service's, and replaying it replays
both.

**Manual acknowledgement.** `noAck: false`, and Nest then does *nothing* on a
handler's behalf — it neither acks on success nor nacks on failure. A handler
that forgets leaves the message unacknowledged forever: not redelivered, not
parked, silently consuming one slot of the prefetch budget. Enough of those
and the consumer stops receiving anything at all, with no error anywhere.
That failure is quiet, cumulative and very hard to diagnose, which is why
acking lives in one shared `ackOrPark` rather than being written out eight
times. `prefetchCount: 10` bounds the in-flight window, which matters far
more with manual acks than without.

**Ack means "I am done with this", not "it succeeded".** A duplicate delivery
whose conditional UPDATE matched no rows is finished and must be acked. Only
a handler that *threw* is parked. There is a test for exactly that, because
it is the distinction people get wrong.

**The replay path**, because a dead-letter queue without one is a landfill —
it stops you losing messages and gives you nothing to do about them, so
nobody looks and the parked count grows until it is ignored on principle.

```bash
node tools/replay-parked.mjs                        # what is parked?
node tools/replay-parked.mjs --peek cart_service    # read without consuming
node tools/replay-parked.mjs --replay cart_service  # put them back
```

The order of operations is the part that is easy to get wrong: each message
is **republished first, with publisher confirms, and acked from the parking
queue only after the broker confirms it holds the copy**. Ack-then-publish
loses the message permanently on a crash in between — from the one queue
whose entire job was not losing it.

Replaying before the cause is fixed simply parks the message again. That is
the loop working. What you must not do is replay on a cron, which turns
parking into requeueing with extra latency.

### Deliberately not built

**Retry with backoff.** A transient failure — a two-second database blip —
parks the message and needs a human to replay it. The refinement is a retry
queue with a TTL that dead-letters back to the main queue, giving N delayed
attempts before parking. It doubles the moving parts, and parking-plus-replay
is already the difference between losing an order and delaying one. Trigger:
the first time the parking queue fills with failures that would have
succeeded on a second attempt.

**Alerting.** Nobody is told when something parks. The count is visible at
`:15672` and via the replay tool, and no one is watching either. Trigger: the
first parked message discovered late.

### Verify

RabbitMQ has to be running. The first command is **destructive** — see below.

```bash
node tools/setup-broker.mjs --recreate
```

Then start the services and check the exchanges and queues at
<http://localhost:15672>. To see a message actually park: stop PostgreSQL,
place an order, and watch `cart_service.parked` go to 1 — the cart handler
cannot reach its database, so the message is preserved instead of lost. Start
PostgreSQL, run the replay, and the cart converts.

---

## ⬜ Milestone 13 — Testing

**SKIPPED for now**, on 2026-09-23. A full version was built and removed at
Rashid's request: unit, application (HTTP-level, no infrastructure),
integration against real `*_test_db` databases, and a whole-journey E2E
script.

What it had found before being removed is worth keeping, because it is the
argument for bringing it back:

- an ADMIN's successful catalogue write and the refresh-token
  rotate/replay lifecycle were both covered for the first time — neither had
  ever been demonstrated running, because one needs a hand-made admin and the
  other needs a migration that is still pending;
- two Milestone 12 bugs (`HealthModule` registered as a provider,
  `serve.options.env` breaking every `nx serve`) are exactly the wiring
  class of failure that only an application-level test catches.

Trigger to revisit: the first regression that reaches a running system, or
Milestone 15, where CI has nothing to run without it.

---

## ✅ Milestone 14 — Docker and Local Infrastructure

**Complete.** Full reference: the [Docker chapter](../README.md#docker).

### The question this answers

> "How do I run this?"

Until now the answer was three pages: install PostgreSQL, create seven roles
and seven databases by hand, start Redis and RabbitMQ, run seven migration
commands, then eleven terminals — and afterwards kill the Node processes that
outlived `nx serve`.

Now it is two commands, and the second one is separate on purpose.

```bash
npm run docker:up
npm run docker:migrate
```

**Migrations do not run at startup.** A service that migrates as it boots
runs three migrations at once with three replicas, and a failing schema
change takes the deploy down in a way nobody can see. It stays a deliberate
step with a human behind it.

### Delivered

**One Dockerfile for all eight services**, parameterised by `--build-arg APP`.
Eight near-identical files drift: one gets a base-image update, one keeps
running as root, one forgets `--omit=dev`. The only real difference between
these services is which entry point runs.

**Multi-stage**, so the toolchain does not ship. The builder holds the Nx
workspace, TypeScript, every devDependency and the source — around 1.5GB, all
of it attack surface someone has to patch forever. The runtime image gets the
compiled bundle, its production dependencies and nothing else. A compiler
that is not in the image cannot be used by whoever gets in.

Three details that are easy to get wrong:

- **`npm ci` before `COPY . .`.** Docker caches by layer inputs, so an
  unchanged lockfile reuses the whole install. Copying source first
  invalidates it on every edit — a twenty-second rebuild becomes three
  minutes, and then nobody rebuilds.
- **`bcrypt` is native.** Builder and runtime are both Alpine deliberately: a
  binary compiled against musl will not load on glibc, and the error
  (`invalid ELF header`) reads like a corrupt file rather than a base-image
  mismatch.
- **`tini` as PID 1.** Node neither reaps zombies nor forwards signals, so
  without an init process `docker stop` ends in a SIGKILL — throwing away the
  graceful shutdown built in Milestone 12. 30KB to make
  `enableShutdownHooks()` mean something.

Images run as the unprivileged `node` user, because containers run as root by
default and that is a default worth changing rather than explaining.

**`docker-compose.yml`** — eleven containers: PostgreSQL 18, Redis 7,
RabbitMQ 3 with the management UI, MailHog, and the eight services.

Only the **gateway publishes a port**. The other seven publish nothing, which
is the topology this design has claimed since Milestone 2 and never actually
had — on a laptop they all listen on `127.0.0.1` and anything on the machine
can reach them.

Postgres is published on **5433, not 5432**, because a developer machine
usually has its own Postgres on 5432 and publishing there either fails to
bind or, worse, silently points your tools at the wrong database.

**Health checks make the startup order work.** Services wait for
`condition: service_healthy`, not `service_started`. Without it compose only
waits for the container to *start*, and a Postgres container is up for
several seconds before it accepts a connection — so every service crashes,
restarts, and eventually works. That is not a stack that starts; it is one
that recovers, and it looks like a minute of frightening logs every time.

The application containers also carry a `HEALTHCHECK` against `/health/live`
— the Milestone 12 probe that checks nothing but the event loop, so a
database blip cannot get a container killed.

**`docker/postgres-init.sh`** creates the seven roles and seven databases on
first start, with `REVOKE CONNECT … FROM PUBLIC` so one service's credentials
cannot open another's database. Database-per-service stops being a promise
about the code and becomes a fact about the deployment. It runs **once**, on
an empty data directory — editing it later does nothing until
`npm run docker:reset`, which is the most common confusion with this image.

**A `migrator` service** built from the *builder* stage, because migrations
run through sequelize-cli against the TypeScript workspace and the runtime
images contain one bundled `main.js` and no CLI. It sits behind a
`profiles: [tools]` so `docker compose up` ignores it: it is a task, and a
task that restarts forever is a failure mode rather than a feature.

**`.dockerignore`**, which is a security control as much as a speed one.
`.env` and `keys/` are excluded — a private signing key baked into an image
is a key published to everyone who can pull it. The keypair is **mounted
read-only** instead, and the gateway gets only the public half: it verifies
tokens and must not be able to mint them.

### One code change this forced

Every internal service bound to `127.0.0.1`. Inside a container that is the
*container's* own loopback, so the service is unreachable from the gateway
next door — ECONNREFUSED from a service that is demonstrably running, which
is a genuinely confusing hour.

`BIND_HOST` now defaults to `127.0.0.1` and compose sets `0.0.0.0`. The
principle is unchanged; the boundary moves from the loopback interface to the
network namespace, one layer out.

### Verify

```bash
npm run docker:up && npm run docker:ps
```

Every container should reach `healthy`. Then `npm run docker:migrate`, and
the Postman collection works unchanged against `localhost:3000`.

### Deliberately not built

- **A production deployment.** This stack is one host, no replication, no TLS
  between services, no secret manager, guest credentials on the broker. The
  images are production-shaped; the orchestration is not, and pretending
  otherwise is how a compose file ends up in production.
- **Hot reload in containers.** A bind-mounted source tree and `nx serve`
  inside a container is possible and is a worse experience than running on
  the host. Develop on the host; use compose to check it really works.
- **Image scanning and pinned digests.** `node:24-alpine` is a moving tag.
  Pinning by digest belongs with CI, which is Milestone 15.

---

## ✅ Milestone 15 — CI/CD

**Complete.** The last milestone.

### The question this answers

> "It works on my machine. Does it work?"

Every check in the pipeline already exists on a laptop. The difference is
that CI runs them on a machine with **nothing** — no `.env`, no keys, no
`node_modules`, no database, no "it works because I ran that migration last
Tuesday". That is the whole value: it proves the REPOSITORY is sufficient,
not that the author's machine is.

### Delivered

**`.github/workflows/ci.yml`** — three jobs, ordered by what they cost:

| Job | What it does | Why in that order |
| --- | --- | --- |
| `verify` | lint, unit tests, build | ~2 min, needs nothing, catches almost everything |
| `images` | eight Docker builds, in a matrix | only worth starting once the code compiles |
| `smoke` | the whole stack up, migrated, answering | the only job that catches wiring between containers |

The **smoke job is the interesting one**, and it is what makes this milestone
more than a formality. It builds a `.env` from `.env.example` with freshly
generated random passwords, generates a signing keypair, brings the whole
compose stack up, waits for every container to report `healthy`, runs the
migrations and the broker setup, then asserts two things:

- `GET /health/ready` answers **200** — checked from inside the gateway
  container, so it means the database, Redis and the broker are all genuinely
  reachable;
- `POST /api/auth/register` answers **201**.

That second number covers a lot of ground: the image built, the container
started, the migration applied, PostgreSQL accepted credentials that the init
script created, the RS256 key was readable at its mounted path, and the
gateway found the Auth Service by its compose hostname. One assertion, most
of Milestone 14.

It also means **`.env.example` is now tested**. If the repository cannot
produce a working configuration from it, the build fails — which is the right
place for that to be discovered, rather than by the next person to clone it.

Decisions worth knowing:

- **`npm ci`, never `npm install`.** `ci` installs exactly the lockfile and
  fails if `package.json` disagrees; `install` would quietly resolve
  something newer, so the thing CI tested is not the thing the lockfile
  describes.
- **The npm cache, not `node_modules`.** Restoring `node_modules` across an
  OS or Node version gives you native modules built for the wrong platform,
  and it fails in ways that look nothing like a cache problem.
- **`run-many`, not `affected`.** Affected is the reason people choose Nx,
  and it turns "CI was green" into "CI was green for the part it decided to
  look at". At twelve projects and two minutes, determinism wins. Trigger to
  switch: when `verify` passes ten minutes.
- **Node pinned to `24`, not `lts/*`.** "Works on the runner's default" is
  how a build starts failing on a Tuesday because GitHub moved the default.
- **Concurrency cancellation on branches, never on `main`** — those runs are
  the record of what was green.

**`.github/workflows/audit.yml`** — dependency and image scanning, on a
weekly schedule and on any PR that touches the dependencies.

Separate from CI **on purpose**: these fail for reasons that have nothing to
do with the commit in front of them, because an advisory published overnight
turns yesterday's green build red today. Mixed into CI, that teaches people
that a red build is normal, which is the most expensive thing a pipeline can
teach.

Two gates, each chosen so it can actually be satisfied:

- `npm audit --omit=dev --audit-level=high`. A vulnerability in a test runner
  is real and is not shipped; gating on it produces a queue nobody can
  prioritise. What ships is the production tree.
- Trivy on the gateway image, **CRITICAL only**. A base image routinely
  carries HIGH findings with no fix available, and a gate that cannot be
  satisfied is one people learn to bypass. HIGH and MEDIUM are still printed,
  where they can be read and judged.

**`.github/dependabot.yml`** — npm, Docker and the Actions themselves, grouped
by family so that `@nestjs/common` never arrives without `@nestjs/core`. The
point is not to be current; it is to keep the cost of being current low
enough that it always happens.

### Two bugs this found

Writing the smoke job is what surfaced them, which is the argument for the
smoke job:

- **RabbitMQ's `guest` user only accepts LOOPBACK connections.** Every
  service would have been refused with `ACCESS_REFUSED`, which reads like a
  wrong password rather than a policy. Compose now creates a real user.
- **Nothing declared the dead-letter topology.** Nest declares the queue it
  consumes and nothing else — so the DLX did not exist, and RabbitMQ silently
  drops messages dead-lettered to a missing exchange. Exactly the failure
  Milestone 12 pass 4 warned about, reintroduced by containerising. There is
  now a `broker-setup` one-shot alongside `migrator`.

### Verify

```bash
npm run verify
```

The same command the `verify` job runs, so "it passes locally" means the same
thing. The rest needs the workflows to run on GitHub.

### Deliberately not built — and this one is a decision, not an omission

**There is no deployment job.** No image is pushed to a registry and nothing
touches a server. That is not laziness: a deploy needs a registry, an
environment, credentials with real blast radius, and an answer to "who may
release". Those are decisions with owners, and a pipeline that guesses at
them is worse than one that stops short.

What a deployment job would need first, in order:

1. a registry, and a decision about whether images are public;
2. **digest-pinned base images** — `node:24-alpine` is a moving tag today;
3. secrets from a manager rather than `.env`;
4. an environment to deploy *to*, with approval gates;
5. **the test suite from Milestone 13**, which was skipped. CI currently runs
   unit tests and one smoke check; there is no coverage of the wiring between
   services, and a deployment pipeline enforcing a suite that thin is a
   formality rather than a gate.

Also absent: `nx affected` with a remote cache, a release/versioning scheme,
and SBOM generation.

---

## Removed on purpose

| Removed                                           | When       | Why                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Swagger / OpenAPI** (`@nestjs/swagger`)         | 2026-09-01 | ~290 decorators across 24 files, adding three or four annotation lines to every route and DTO. The noise was getting in the way of reading the code, which is the point of a learning project. The Postman collection is the executable reference instead. |
| **Custom messaging framework** (`libs/messaging`) | 2026-09-01 | Replaced with NestJS's built-in `@nestjs/microservices` + `Transport.RMQ`. Keep it simple until a lesson needs more.                                                                                                                                       |

Both can come back when there is a reason. Swagger earns its place when
external consumers need a contract they can generate a client from.

---

## Deferred, with triggers

Things consciously left out, and what should bring each one back. This list
exists so that "not yet" never quietly becomes "never".

| Item                               | Trigger                                                                                                                                              | Milestone       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Auth on catalogue writes**       | Before anything is exposed beyond localhost. Currently **anyone reaching the gateway can create, edit and delete products.**                         | M4 candidate    |
| **RS256 signing keys**             | The moment a second service must verify tokens. An HS256 key that verifies can also mint.                                                            | with the above  |
| **RBAC role guards**               | Same trigger — `role` is already a claim and a column.                                                                                               | with the above  |
| **Login rate limiting**            | Before any internet exposure. Brute force is currently bounded only by bcrypt's cost.                                                                | M4              |
| **Refresh tokens + logout**        | When 15-minute sessions become unacceptable UX.                                                                                                      | M12             |
| **Global exception filter**        | When the standard error envelope (`code`, `traceId`, `path`) is needed — i.e. alongside correlation IDs.                                             | M11–12          |
| **Correlation IDs**                | With the first multi-hop debugging problem.                                                                                                          | M11             |
| **Helmet, CORS policy**            | Before a browser client exists.                                                                                                                      | M12             |
| **Health checks**                  | Before containers need liveness/readiness probes.                                                                                                    | M12/M14         |
| **`pg_trgm` GIN index for search** | Measurable latency on `GET /products?search=` — not a hunch. `ILIKE '%x%'` is a sequential scan today.                                               | when measured   |
| **Elasticsearch**                  | Facets, relevance ranking or typo tolerance. Not before.                                                                                             | post-M15        |
| **Category nesting**               | An actual requirement for subtrees. The migration is additive.                                                                                       | on demand       |
| **Category pagination**            | Hundreds of categories, or nesting.                                                                                                                  | on demand       |
| **Integer minor units for money**  | Done — `@ecommerce/money`, shared by Cart and Order. Storage stays DECIMAL; the arithmetic never leaves integers.                                    | delivered       |
| **Stock reservation at checkout**  | Two customers can both order the last unit today. Reserving is a write into another service's database, so it needs an undo when a later step fails. | when it bites   |
| **Saga + compensation**            | With stock reservation, or with the Payment Service — whichever forces it first.                                                                     | M9 candidate    |
| **Transactional outbox**           | A lost event costs something real — an unsent email, an unpicked warehouse order. Today the worst case is a cart left full.                          | M10             |
| **Idempotency-Key on checkout**    | A double-clicked checkout is seen creating two orders. The window is small — the second click usually finds an empty cart.                           | when observed   |
| **Idempotent inventory commands**  | A retried `reserve` double-reserves. Key the command on its `reference`.                                                                             | M9/M12          |
| **Ledger retention**               | Disk pressure. `processed_events` keeps one row per event forever.                                                                                   | when measured   |
| **Retry of a failed email**        | A send that fails is recorded and left. Nothing tries again — and the claim stays taken, so redelivery will not either.                              | when it matters |
| **Notification preferences**       | Anything beyond strictly transactional email needs opt-outs before it is sent.                                                                       | before launch   |
| **Event envelope**                 | With the outbox — an `eventId` is what deduplication needs. Correlation ids follow in M11.                                                           | with the outbox |
| **Payment reconciliation**         | A payment stuck PENDING blocks its order and nobody is told. Ask the provider what happened to it.                                                   | when one sticks |
| **Refunds**                        | A cancelled order that was paid for. Today the log says a refund is needed and a human arranges it.                                                  | M10 candidate   |
| **Secret manager**                 | Before any shared or hosted environment — and before a real payment provider, whose key is not a password reset if it leaks.                         | M14             |

---

## Known gaps, stated plainly

1. ~~**Catalogue write endpoints are unauthenticated.**~~ **CLOSED in
   Milestone 12 pass 2.** Every catalogue and inventory write now requires an
   authenticated ADMIN; reads stay public. It stood open for nine milestones
   because of a real dependency rather than neglect — under HS256 the gateway
   could not check a token without holding a key that could also mint one.
2. **Internal services still trust `X-User-Id`.** The gateway authenticates
   the caller and forwards the id; the Cart, Order and Payment services
   believe the header. Safe only because they bind to loopback. RS256 makes
   the fix available — hand each service the public key and have it verify
   the token itself — and that is now a choice rather than a blocker.
3. **Service-to-service calls have no identity.** `reserve`, `release` and
   `fulfil` are marked ADMIN, which is correct while only an operator calls
   them and wrong the moment the Order Service does. Trigger: the first time
   a service rather than a person needs one of these.
4. **Rate limiting is per-IP only**, and fails open when Redis is down. It
   raises the cost of credential stuffing; it does not stop a distributed
   attack. Per-account lockout and MFA are still absent.
5. **No audit logging** of authentication or catalogue mutations. An ADMIN
   deleting a product is now authorised and still unrecorded.
6. **A specific ACCESS token cannot be killed.** Sessions are now revocable
   — logout and reuse detection end them — but the access token already
   issued stays valid for up to 15 minutes. A deny-list keyed on a `jti`
   claim is the fix; the trigger is the first time someone has to respond to
   a confirmed token theft rather than a suspected one.
   Also still absent: an absolute cap on session length. Each rotation
   extends the refresh token by another 30 days, so an active session never
   ends on its own.
7. **`.env` secrets are development values** that have appeared in a terminal
   transcript. Rotate before any shared environment. The signing keypair is
   generated locally and git-ignored; regenerate it for any shared
   environment.

---

## Database inventory

Every PostgreSQL database **and role** is prefixed `ecommerce_`. Databases are
per-cluster; roles are cluster-wide, so the prefix is what keeps `\du`
readable on a server shared with other projects.

| Service      | Database                    | Role                             | Status               |
| ------------ | --------------------------- | -------------------------------- | -------------------- |
| Auth         | `ecommerce_auth_db`         | `ecommerce_auth_service`         | ✅ created, migrated |
| Product      | `ecommerce_product_db`      | `ecommerce_product_service`      | ✅ created, migrated |
| Inventory    | `ecommerce_inventory_db`    | `ecommerce_inventory_service`    | ✅ created, migrated |
| Cart         | `ecommerce_cart_db`         | `ecommerce_cart_service`         | ✅ created, migrated |
| Order        | `ecommerce_order_db`        | `ecommerce_order_service`        | ⏳ migration written |
| Payment      | `ecommerce_payment_db`      | `ecommerce_payment_service`      | ⏳ migration written |
| Notification | `ecommerce_notification_db` | `ecommerce_notification_service` | ⏳ migration written |

## Port inventory

| Service          | HTTP | Node inspector |
| ---------------- | ---- | -------------- |
| API Gateway      | 3000 | 9229           |
| Auth             | 3001 | 9230           |
| Product          | 3002 | 9231           |
| Inventory        | 3003 | 9232           |
| Cart             | 3004 | 9233           |
| Order            | 3005 | 9234           |
| Payment          | 3006 | 9235           |
| Notification     | 3007 | 9236           |
| _(next service)_ | 3008 | 9237           |

Each service needs its own inspector port. `@nx/js:node` defaults every one of
them to 9229, and the collision stops the second service booting with an error
that reads like a warning.
