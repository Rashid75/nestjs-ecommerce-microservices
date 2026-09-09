# Project Plan & Progress

The 15-milestone plan for this backend, with what is actually built as of
**2026-09-04**.

This file is the source of truth for progress. It is updated at the end of
every milestone — completed work moves from _Planned_ to _Delivered_, and
anything deliberately deferred is recorded with the **trigger** that should
bring it back, rather than a vague "later".

|                         |                                                         |
| ----------------------- | ------------------------------------------------------- |
| **Milestones complete** | 9 of 15                                                 |
| **Services running**    | Gateway, Auth, Product, Inventory, Cart, Order, Payment |
| **Infrastructure**      | PostgreSQL 18, Redis 7, RabbitMQ 3                      |
| **Databases**           | one per service, six in total                           |
| **Next milestone**      | 10 — Notification Service                               |

```text
M1 ██ M2 ██ M3 ██ M4 ██ M5 ██ M6 ██ M7 ██ M8 ██
M9 ██ M10 ░░ M11 ░░ M12 ░░ M13 ░░ M14 ░░ M15 ░░
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

RabbitMQ :5672   ecommerce_events queue
   Auth      → user.registered
   Product   → product.price_changed · product.archived
   Inventory → inventory.reserved · inventory.released
   Order     → order.confirmed · order.cancelled
   Payment   → payment.succeeded · payment.failed
   Cart      ← the catalogue events AND order.confirmed
   Order     ← payment.succeeded (hybrid app since M9)

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
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Stock reservation at checkout**   | Two customers can both order the last unit today. Reserving is a write into another service's database, so it needs an undo when a later step fails — a compensating workflow. Do it when overselling matters more than the complexity does. |
| **Stock reservation at checkout**   | Two customers can both order the last unit today. Reserving is a write into another service's database, so it needs an undo when a later step fails.                                                                                         | when it bites   |
| **Saga + compensation**             | With stock reservation, or with the Payment Service — whichever forces it first.                                                                                                                                                             | M9 candidate    |
| **Transactional outbox**            | A lost event costs something real — an unsent email, an unpicked warehouse order. Today the worst case is a cart left full.                                                                                                                  | M10             |
| **`Idempotency-Key` on checkout**   | When a double-clicked checkout is observed creating two orders. The window is already small: the second click usually finds an empty cart.                                                                                                   |
| **Event envelope**                  | With the outbox — an `eventId` is what deduplication needs. Correlation ids follow in M11.                                                                                                                                                   | with the outbox |
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

## ⬜ Milestone 10 — Notification Service

**Next up.** RabbitMQ consumers, Nodemailer, MailHog, templates. Business services publish
events; none of them contain email logic.

---

## ⬜ Milestone 11 — Observability

Pino structured logging, correlation IDs, OpenTelemetry traces and metrics,
SigNoz. The goal: understand where a request spent its time across services.

---

## ⬜ Milestone 12 — Production Hardening

Health checks (Terminus), graceful shutdown, retry policies, DLQ
improvements, rate limiting, Helmet, CORS, a global exception filter with the
project's standard error envelope.

---

## ⬜ Milestone 13 — Testing

Unit, integration and a full E2E: register → login → browse → cart → order →
inventory → payment → confirmation → email.

---

## ⬜ Milestone 14 — Docker and Local Infrastructure

Multi-stage Dockerfiles, Docker Compose for the whole stack. `docker compose
up` starts everything. This is also where the orphaned-dev-server problem
disappears.

---

## ⬜ Milestone 15 — CI/CD

GitHub Actions: install → lint → unit → integration → build → docker build.
No production deployment without explicit instruction.

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
| **Processed-events ledger**        | A consumer whose work is not naturally repeatable — sending an email, charging a card.                                                               | M10             |
| **Topic exchange with bindings**   | A second service needing its own copy of `order.confirmed`. Today one queue means consumers would COMPETE.                                           | M10             |
| **Event envelope**                 | With the outbox — an `eventId` is what deduplication needs. Correlation ids follow in M11.                                                           | with the outbox |
| **Payment reconciliation**         | A payment stuck PENDING blocks its order and nobody is told. Ask the provider what happened to it.                                                   | when one sticks |
| **Refunds**                        | A cancelled order that was paid for. Today the log says a refund is needed and a human arranges it.                                                  | M10 candidate   |
| **Secret manager**                 | Before any shared or hosted environment — and before a real payment provider, whose key is not a password reset if it leaks.                         | M14             |

---

## Known gaps, stated plainly

1. **Catalogue write endpoints are unauthenticated.** Deliberate — closing it
   properly requires the RS256 decision above — but it means this stack must
   not be exposed beyond localhost.
2. **Rate limiting is per-IP only**, and fails open when Redis is down. It
   raises the cost of credential stuffing; it does not stop a distributed
   attack. Per-account lockout and MFA are still absent.
3. **No audit logging** of authentication or catalogue mutations.
4. **`.env` secrets are development values** that have appeared in a terminal
   transcript. Rotate before any shared environment.

---

## Database inventory

Every PostgreSQL database **and role** is prefixed `ecommerce_`. Databases are
per-cluster; roles are cluster-wide, so the prefix is what keeps `\du`
readable on a server shared with other projects.

| Service   | Database                 | Role                          | Status               |
| --------- | ------------------------ | ----------------------------- | -------------------- |
| Auth      | `ecommerce_auth_db`      | `ecommerce_auth_service`      | ✅ created, migrated |
| Product   | `ecommerce_product_db`   | `ecommerce_product_service`   | ✅ created, migrated |
| Inventory | `ecommerce_inventory_db` | `ecommerce_inventory_service` | ✅ created, migrated |
| Cart      | `ecommerce_cart_db`      | `ecommerce_cart_service`      | ✅ created, migrated |
| Order     | `ecommerce_order_db`     | `ecommerce_order_service`     | ⏳ migration written |
| Payment   | `ecommerce_payment_db`   | `ecommerce_payment_service`   | ⏳ migration written |

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
| _(next service)_ | 3007 | 9236           |

Each service needs its own inspector port. `@nx/js:node` defaults every one of
them to 9229, and the collision stops the second service booting with an error
that reads like a warning.
