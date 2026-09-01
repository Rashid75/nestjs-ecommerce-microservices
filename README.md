# E-Commerce Microservices Backend

A production-oriented e-commerce backend, built incrementally as a learning
project. Each milestone introduces one architectural concern at a time and
explains why it exists before it is added.

> **Current status: Milestone 7 — RabbitMQ Messaging.**
> Five services talking both synchronously (HTTP) and asynchronously
> (RabbitMQ topic exchange, with retries, dead-lettering and idempotent
> consumers). No orders or payments yet.

📋 **[Project plan and progress](docs/PROJECT-PLAN.md)** — all 15 milestones,
what is delivered, what is deferred and the trigger that brings each deferred
item back.

---

## Table of contents

- [What exists today](#what-exists-today)
- [Target architecture](#target-architecture)
- [Technology stack](#technology-stack)
- [Repository layout](#repository-layout)
- [Local setup](#local-setup)
- [Database and migrations](#database-and-migrations)
- [Caching and rate limiting](#caching-and-rate-limiting)
- [Messaging](#messaging)
- [API](#api)
- [Postman](#postman)
- [Everyday commands](#everyday-commands)
- [Environment variables](#environment-variables)
- [Architecture decisions](#architecture-decisions)
- [Known gaps](#known-gaps)
- [Troubleshooting](#troubleshooting)

---

## What exists today

```text
   Client
     │  POST /api/auth/register   ·   GET  /api/products?search=&page=
     │  POST /api/auth/login      ·   POST /api/products
     │  GET  /api/auth/me         ·   GET  /api/categories
     ▼
┌──────────────────────┐
│  API Gateway :3000   │  public · /api · DTO validation · Swagger · routing
└──────────┬───────────┘
           │ HTTP (axios, 5s timeout, honest failure mapping)
     ┌─────┴───────────────┐
     ▼                     ▼
┌──────────────┐ ┌────────────────┐ ┌──────────────────┐
│  Auth :3001  │ │ Product :3002  │ │ Inventory :3003  │  all 127.0.0.1
└──────┬───────┘ └───────┬────────┘ └────────┬─────────┘
       │ Sequelize       │ Sequelize         │ Sequelize
       ▼                 ▼                   ▼
┌──────────────┐ ┌────────────────┐ ┌────────────────────┐
│ ecommerce_   │ │ ecommerce_     │ │ ecommerce_         │
│   auth_db    │ │   product_db   │ │   inventory_db     │
└──────────────┘ └────────────────┘ └────────────────────┘
                          schema from migrations only

           Redis :6379
  ecom:gateway:*   rate-limit counters   REQUIRED by the gateway
  ecom:product:*   cache-aside entries   OPTIONAL — the cache fails open
```

Inside every service the request path is fixed:

```text
Controller → Service → Repository → Sequelize Model → PostgreSQL
```

Sequelize appears in exactly one layer. A controller never queries.

---

## Target architecture

Where the project is heading. This is **not** what exists today.

```text
                         ┌─────────────────┐
                         │     Client      │
                         └────────┬────────┘
                                  ▼
                         ┌─────────────────┐
                         │   API Gateway   │
                         └────────┬────────┘
          ┌───────────────┬───────┼────────┬───────────────┐
          ▼               ▼       ▼        ▼               ▼
       Auth            Users   Products Inventory         Cart
          └───────────────┴───────┴────────┴───────────────┘
                                  ▼
                               Orders
                         ┌────────┴────────┐
                         ▼                 ▼
                      Payment         Notification

Infrastructure: PostgreSQL · Redis · RabbitMQ · MailHog · OpenTelemetry · SigNoz
```

Each service owns its own database (`database-per-service`). No service reads
another service's tables directly; they talk over REST or RabbitMQ.

---

## Technology stack

| Concern              | Choice                                           | Introduced in              |
| -------------------- | ------------------------------------------------ | -------------------------- |
| Monorepo tooling     | Nx                                               | M1                         |
| Framework            | NestJS 11                                        | M1                         |
| Language             | TypeScript (strict)                              | M1                         |
| Linting / formatting | ESLint (flat config) + Prettier                  | M1                         |
| Bundling             | webpack via `@nx/webpack`                        | M1                         |
| Configuration        | `@nestjs/config` + Joi validation                | M1                         |
| Database             | PostgreSQL 18                                    | M2                         |
| ORM / migrations     | Sequelize + sequelize-typescript + sequelize-cli | M2                         |
| Password hashing     | bcrypt (cost 12)                                 | M2                         |
| Tokens               | JWT (HS256) via `@nestjs/jwt`                    | M2                         |
| Authentication       | Passport + `passport-jwt` + guard                | M2                         |
| Request validation   | class-validator / class-transformer              | M2                         |
| Service-to-service   | HTTP via `@nestjs/axios`                         | M2                         |
| API docs             | Swagger / OpenAPI                                | M2                         |
| Money                | `DECIMAL(12,2)`, exposed as an exact string      | M3                         |
| Cache                | Redis                                            | M4                         |
| Messaging            | RabbitMQ                                         | M7                         |
| Email                | Nodemailer + MailHog                             | M10                        |
| Logging / tracing    | Pino, OpenTelemetry, SigNoz                      | M11                        |
| Testing              | Jest + Supertest                                 | throughout; formalised M13 |
| Containers           | Docker + Docker Compose                          | M14                        |
| CI                   | GitHub Actions                                   | M15                        |

---

## Repository layout

```text
ecommerce/
├── apps/
│   ├── api-gateway/                  PUBLIC · 3000 · inspector 9229
│   │   └── src/
│   │       ├── auth/                 proxy to Auth
│   │       ├── catalog/              proxy to Product
│   │       ├── common/upstream-proxy.ts   shared failure mapping
│   │       ├── common/rate-limit.guard.ts global, Redis-backed
│   │       ├── config/env.validation.ts
│   │       └── main.ts               ValidationPipe + Swagger
│   │
│   ├── auth/                         INTERNAL · 3001 · inspector 9230
│   │   ├── .sequelizerc
│   │   └── src/
│   │       ├── auth/                 controller, service, strategy, guard
│   │       ├── users/                model, repository
│   │       ├── database/             connection + migrations
│   │       ├── config/
│   │       └── main.ts
│   │
│   ├── product/                      INTERNAL · 3002 · inspector 9231
│       ├── .sequelizerc
│       └── src/
│           ├── products/             model, repository, service, controller
│           │   └── products-cache.service.ts   keys + invalidation policy
│           ├── categories/           model, repository, service, controller
│           ├── common/domain-errors.ts
│           ├── database/             connection + migrations
│           ├── config/
│           └── main.ts
│   │
│   └── inventory/                    INTERNAL · 3003 · inspector 9232
│       └── src/
│           ├── inventory/            models, repository, service, controller
│           │   └── inventory.repository.ts   the atomic reserve statement
│           ├── database/             migrations: items + ledger
│           ├── config/
│           └── main.ts
│
├── libs/
│   ├── contracts/                    @ecommerce/contracts · type:lib
│   │   └── src/lib/
│   │       ├── auth/                 register, login, tokens, roles
│   │       ├── catalog/              product, category, query DTOs
│   │       └── common/               pagination envelope
│   └── redis/                        @ecommerce/redis · type:lib
│       └── src/lib/
│           ├── redis.module.ts       lazily-connected client, key prefix
│           └── cache.service.ts      cache-aside, TTL, invalidation
│
├── docs/PROJECT-PLAN.md              milestones, progress, deferred items
├── postman/                          collection + local environment
├── tools/
│   ├── free-ports.mjs                kills orphaned dev servers
│   ├── oversell-demo.mjs             concurrent reservation proof
│   └── messaging-demo.mjs            publish, duplicate, dead-letter
├── .env.example                      committed template, no real secrets
├── .env                              local values, git-ignored
├── eslint.config.mjs                 module boundary rules
└── nx.json · tsconfig.base.json · package.json
```

---

## Local setup

Prerequisites: Node.js 20+, npm 10+, PostgreSQL 13+ and Redis 7+ running
locally.

```bash
npm install
```

Start Redis and RabbitMQ — the simplest route is containers:

```bash
docker run -d --name ecommerce-redis -p 6379:6379 redis:7-alpine
```

```bash
docker run -d --name ecommerce-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

The RabbitMQ management UI is at <http://localhost:15672> (guest / guest) —
the best way to see exchanges, bindings, queue depths and the dead-letter
queue.

```bash
cp .env.example .env
```

Fill in the two `*_DB_PASSWORD` values and generate a signing key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create the databases (next section), then:

```bash
npm run db:migrate
```

```bash
npm start
```

---

## Database and migrations

### Naming convention

Every PostgreSQL object this project creates is prefixed **`ecommerce_`** —
both the database and the login role:

| Service        | Database                 | Owning role                   | Status |
| -------------- | ------------------------ | ----------------------------- | ------ |
| Auth           | `ecommerce_auth_db`      | `ecommerce_auth_service`      | ✅     |
| Product        | `ecommerce_product_db`   | `ecommerce_product_service`   | ✅     |
| Inventory      | `ecommerce_inventory_db` | `ecommerce_inventory_service` | ✅     |
| Cart _(M6)_    | `ecommerce_cart_db`      | `ecommerce_cart_service`      | —      |
| Order _(M8)_   | `ecommerce_order_db`     | `ecommerce_order_service`     | —      |
| Payment _(M9)_ | `ecommerce_payment_db`   | `ecommerce_payment_service`   | —      |

Databases are namespaced per cluster, but **roles in PostgreSQL are
cluster-wide**. A bare `auth_service` would share a namespace with every other
project on the same server, so the prefix is what keeps `\du` readable and a
misplaced `GRANT` obvious.

Environment _variable_ names keep their own per-service prefix (`AUTH_DB_*`,
`PRODUCT_DB_*`) — only the PostgreSQL object names carry `ecommerce_`.

### Creating a service database

As a superuser, once per service:

```sql
CREATE ROLE ecommerce_product_service WITH LOGIN PASSWORD 'your-password-from-dotenv';
CREATE DATABASE ecommerce_product_db OWNER ecommerce_product_service;
```

Each role owns exactly one database and has no rights over any other — the
same isolation Docker or a managed Postgres would give, done with roles.

### Migrations

**Schema changes only ever happen through migrations.** `synchronize` is
hardcoded `false` in every `database.module.ts` with no environment toggle, so
Sequelize is never permitted to issue DDL. The schema in any environment is
exactly the sum of the migration files in git.

| Command                                                      | What it does                                   |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `npm run db:migrate`                                         | Apply pending migrations for **every** service |
| `npm run auth:migrate` / `product:migrate`                   | One service                                    |
| `npm run auth:migrate:status` / `product:migrate:status`     | What has run                                   |
| `npm run auth:migrate:undo` / `product:migrate:undo`         | Roll back the last one                         |
| `npm run product:migration:generate -- --name add-something` | Scaffold a new one                             |

Applied migrations are recorded in each database's `SequelizeMeta` table.
Every migration here wraps its statements in a single transaction — PostgreSQL
supports transactional DDL and sequelize-cli does not add one for you, so
without it a mid-way failure leaves a schema `SequelizeMeta` has no record of.

Models and migrations are **separate concerns**, kept in sync by hand. The
migration is the authoritative history; the model is one process's view of it.
If they disagree, the migration is right.

---

## Caching and rate limiting

One Redis instance serves both, namespaced by key prefix. Redis has no
equivalent of a per-service database, so the prefix is the isolation.

| Prefix          | Owner           | Contents            | Required?           |
| --------------- | --------------- | ------------------- | ------------------- |
| `ecom:product:` | Product Service | Cache-aside entries | **No** — fails open |
| `ecom:gateway:` | API Gateway     | Rate-limit counters | **Yes**             |

### Cache-aside

```text
Request → Redis ──HIT──→ Response
             │
            MISS
             ↓
         PostgreSQL → Redis (SET with TTL) → Response
```

| What           | Key                 | TTL  | Why                                     |
| -------------- | ------------------- | ---- | --------------------------------------- |
| Product detail | `detail:{id}`       | 300s | Read constantly, changes rarely         |
| Product list   | `list:{gen}:{hash}` | 60s  | Expensive query; reflects many rows     |
| Categories     | _not cached_        | —    | Twenty rows, one indexed query, no JOIN |

Every read returns **`X-Cache: HIT`** or **`MISS`** — the CDN convention,
and the only way to verify caching from outside the system.

**Invalidation.** A write deletes the detail key it knows is wrong, then
`INCR`s a generation counter embedded in every list key. That makes all
cached list pages unreachable in O(1) without touching them, because the
alternative — `KEYS products:list:*` — blocks single-threaded Redis across
the entire keyspace. Superseded keys simply expire.

Two ordering rules: **write first, invalidate second** (invalidating first
lets a concurrent read repopulate from the old row), and **invalidate, do not
update** (two concurrent updates can reach the cache in the opposite order to
the database and stick).

**The cache never takes the service down.** Every operation is wrapped: on a
Redis failure, reads return a miss and writes are dropped, so the caller
falls through to PostgreSQL. Set `CACHE_ENABLED=false` to bypass it entirely
without a code change.

### Rate limiting

A **global** guard, so a new endpoint inherits a budget rather than having
none. Opt out with `@SkipRateLimit()`; tighten with `@RateLimit()`.

| Route                     | Limit        | Why                                                                                     |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `POST /api/auth/login`    | 5 / minute   | Credential stuffing. Until this existed, only bcrypt's ~250ms slowed a guessing attack. |
| `POST /api/auth/register` | 5 / 15 min   | Writes a row and burns 250ms of CPU per call                                            |
| everything else           | 100 / minute | Runaway clients and scrapers                                                            |

Counters live in Redis, not process memory — three replicas with in-memory
counters would allow three times the configured limit and reset on every
deploy. The increment is a **Lua script**, because `INCR` then `EXPIRE` as
two commands leaves a window where a crash creates a key with no TTL and a
permanently locked-out client.

Responses carry `X-RateLimit-Limit`, `-Remaining`, `-Reset`, and `Retry-After`
on a 429.

**Known limits:** keyed by socket IP only. `X-Forwarded-For` is deliberately
ignored — it is client-supplied, so trusting it without a real proxy in front
makes the limiter trivially bypassable. Behind a load balancer this needs
`app.set('trust proxy', 1)`, which is a deployment-time decision. Everyone
behind one NAT shares a counter, and a botnet gets 5 attempts per IP; per-
account lockout and MFA are the next layers.

---

## Messaging

Synchronous HTTP where the caller needs an answer now; RabbitMQ where it does
not. Built with **NestJS's built-in integration** — `@nestjs/microservices`
with `Transport.RMQ` — rather than a hand-rolled client.

```text
   Auth ─────user.registered──────┐
Product ─────product.price_changed┤
        ─────product.archived─────┤──► queue: ecommerce_events ──► Cart Service
Inventory ───inventory.reserved───┤                                @EventPattern
          ───inventory.released───┘
```

### Publishing

`ClientsModule.registerAsync()` in the feature module whose service
publishes — it is **not** global, so the provider has to live where it is
injected:

```ts
this.events.emit(EventPattern.UserRegistered, { userId, email, firstName });
```

`emit()`, not `send()`:

|          | Used for                        | Other end           |
| -------- | ------------------------------- | ------------------- |
| `emit()` | **Events** — fire and forget    | `@EventPattern()`   |
| `send()` | **Commands** — request/response | `@MessagePattern()` |

Nobody replies to "a user registered", so `emit` is correct.

### Consuming

The Cart Service is a **hybrid application**: HTTP and RabbitMQ in one
process. Message handlers live in a controller, because in Nest a controller
is simply "the thing requests arrive at" — only the decorator differs:

```ts
@EventPattern(Events.ProductPriceChanged)
async onPriceChanged(@Payload() payload: ProductPriceChangedPayload) { ... }
```

`main.ts` calls `app.listen()` **before** `app.startAllMicroservices()`.
That order matters: `startAllMicroservices()` waits for the broker and
retries indefinitely, so awaiting it first means a down RabbitMQ takes the
whole HTTP API down with it.

### Events are facts, not instructions

`user.registered`, never `send.welcome.email`. A command says "do this" and
is addressed to one handler; an event says "this happened" and is addressed
to nobody in particular. The second name would couple Auth to the existence
of an email system.

### One queue, and its limitation

Nest's RMQ transport is **queue-centric**: publishers send to a named queue
and a consuming service reads from it. Simple — and it means a second
consuming service would **compete** for the same messages rather than each
receiving a copy. Exchanges and bindings are the answer to that, and they
arrive when there is a second consumer that needs them.

### What is deliberately not built yet

Retry, dead-letter queues, idempotency, a transactional outbox and an event
envelope are all absent. Each solves a real problem, and each arrives in the
milestone that meets that problem — see
[the deferred table](docs/PROJECT-PLAN.md).

Today a failed handler loses its message and a duplicate delivery flags a
cart line twice. Both are harmless for these events; neither would be once an
event means an order.

## API

Swagger UI:

|                    |                              |
| ------------------ | ---------------------------- |
| Gateway (public)   | <http://localhost:3000/docs> |
| Auth (internal)    | <http://127.0.0.1:3001/docs> |
| Product (internal) | <http://127.0.0.1:3002/docs> |

### Auth

| Method | Path                 | Auth   | Returns                   |
| ------ | -------------------- | ------ | ------------------------- |
| `POST` | `/api/auth/register` | —      | 201 · user + access token |
| `POST` | `/api/auth/login`    | —      | 200 · user + access token |
| `GET`  | `/api/auth/me`       | Bearer | 200 · user profile        |

### Catalogue

⚠️ **Write endpoints are currently unauthenticated** — see [Known gaps](#known-gaps).

| Method   | Path                  | Returns                         |
| -------- | --------------------- | ------------------------------- |
| `GET`    | `/api/products`       | 200 · paginated list            |
| `GET`    | `/api/products/:id`   | 200 · product with its category |
| `POST`   | `/api/products`       | 201 · created product           |
| `PATCH`  | `/api/products/:id`   | 200 · updated product           |
| `DELETE` | `/api/products/:id`   | 204 · soft-deleted              |
| `GET`    | `/api/categories`     | 200 · list                      |
| `GET`    | `/api/categories/:id` | 200 · category                  |
| `POST`   | `/api/categories`     | 201 · created category          |
| `PATCH`  | `/api/categories/:id` | 200 · updated category          |
| `DELETE` | `/api/categories/:id` | 204 · soft-deleted              |

### Listing query parameters

| Parameter               | Values                                 | Notes                                              |
| ----------------------- | -------------------------------------- | -------------------------------------------------- |
| `page`                  | ≥ 1, default 1                         | Offset pagination                                  |
| `limit`                 | 1–100, default 20                      | Capped, so a client cannot request the whole table |
| `search`                | text                                   | Case-insensitive substring on name and SKU         |
| `categoryId`            | uuid                                   |                                                    |
| `status`                | `DRAFT` `ACTIVE` `ARCHIVED`            |                                                    |
| `minPrice` / `maxPrice` | number                                 | Inverted range is a 400, not an empty page         |
| `sortBy`                | `name` `price` `createdAt` `updatedAt` | Allow-list — `ORDER BY` cannot be parameterised    |
| `sortOrder`             | `asc` `desc`                           |                                                    |

```bash
curl -s "http://localhost:3000/api/products?search=thinkpad&status=ACTIVE&minPrice=500&sortBy=price&sortOrder=asc&page=1&limit=10"
```

Responses are enveloped:

```json
{
  "items": [{ "id": "...", "name": "...", "price": "1899.00" }],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 137,
    "totalPages": 7,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

`price` is a **string**. The column is `DECIMAL(12,2)`; JavaScript numbers are
IEEE-754 doubles and cannot hold 19.99 exactly. Do not parse it as a float to
do money arithmetic.

### Status codes

| Code      | When                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| 400       | Validation failed, unknown property, bad UUID, inverted price range, empty patch |
| 401       | Missing, expired, tampered token; bad credentials                                |
| 404       | Product or category not found                                                    |
| 409       | Email, SKU, category name or slug already in use; category still has products    |
| 503 / 504 | Downstream service unavailable / timed out                                       |

---

## Postman

Two files in [`postman/`](postman), both committed:

| File                                       | What it is                                 |
| ------------------------------------------ | ------------------------------------------ |
| `ecommerce.postman_collection.json`        | Requests, assertions and per-request notes |
| `ecommerce.local.postman_environment.json` | URLs, ports and test credentials           |

**Import both**: Postman → _Import_ → drag both files in. Then select
**`ecommerce · local`** in the environment picker — a collection-level
pre-request script fails loudly with a clear message if you forget.

| Folder                      | Contents                                                    |
| --------------------------- | ----------------------------------------------------------- |
| `1 · Happy path`            | Register → Login → Me. Chains state, re-runnable.           |
| `2 · Validation & security` | Seven requests that are _supposed_ to fail.                 |
| `3 · Auth Service directly` | The same calls on `:3001`, bypassing the gateway.           |
| `4 · Downstream failure`    | Requires a service stopped on purpose.                      |
| `5 · Catalogue`             | Category → product → list → filter → sort → patch → delete. |

Every request carries assertions, so **Run collection** doubles as a smoke
test.

---

## Everyday commands

| Command                                                  | What it does                                     |
| -------------------------------------------------------- | ------------------------------------------------ |
| `npm start`                                              | Serve all three services, with streamed logs     |
| `npm run start:gateway` / `start:auth` / `start:product` | One service                                      |
| `npm run stop`                                           | Kill anything left holding 3000–3002 / 9229–9231 |
| `npm run db:migrate`                                     | Migrate every service's database                 |
| `npm run build`                                          | Build every project into `dist/`                 |
| `npm run lint`                                           | ESLint across every project                      |
| `npm test`                                               | Jest across every project                        |
| `npm run format`                                         | Rewrite files with Prettier                      |
| `npm run graph`                                          | Open the interactive Nx project graph            |

---

## Environment variables

Each service validates **its own** variables with Joi at startup and refuses to
boot if any are missing or malformed.

| Variable                 | Service | Default       | Description                              |
| ------------------------ | ------- | ------------- | ---------------------------------------- |
| `NODE_ENV`               | all     | `development` | `development` \| `test` \| `production`  |
| `API_GATEWAY_PORT`       | gateway | `3000`        | Public listening port                    |
| `API_GLOBAL_PREFIX`      | gateway | `api`         | Prefix on all gateway routes             |
| `AUTH_SERVICE_URL`       | gateway | _required_    | Where to forward auth calls              |
| `PRODUCT_SERVICE_URL`    | gateway | _required_    | Where to forward catalogue calls         |
| `HTTP_CLIENT_TIMEOUT_MS` | gateway | `5000`        | Deadline for outbound calls              |
| `AUTH_SERVICE_PORT`      | auth    | `3001`        | Internal listening port                  |
| `AUTH_DB_*`              | auth    | _required_    | Host, port, username, password, database |
| `AUTH_DB_LOGGING`        | auth    | `false`       | Log emitted SQL — off in production      |
| `AUTH_DB_SSL`            | auth    | `false`       | Must be true off-loopback                |
| `JWT_ACCESS_SECRET`      | auth    | _required_    | HS256 key, min 32 characters             |
| `JWT_ACCESS_TTL_SECONDS` | auth    | `900`         | Access token lifetime                    |
| `BCRYPT_COST`            | auth    | `12`          | bcrypt work factor (10–15)               |
| `PRODUCT_SERVICE_PORT`   | product | `3002`        | Internal listening port                  |
| `PRODUCT_DB_*`           | product | _required_    | Host, port, username, password, database |
| `PRODUCT_DB_LOGGING`     | product | `false`       | Log emitted SQL                          |
| `PRODUCT_DB_SSL`         | product | `false`       | Must be true off-loopback                |

Rules:

- `.env.example` is committed and documents every variable. No real values.
- `.env` and `.env.local` are git-ignored.
- Bind-parameter logging is hardcoded off, so hashes and personal data never
  reach the application log.
- Real secrets belong in a secret manager. A `.env` file is a
  local-development convenience, not a production mechanism.

---

## Architecture decisions

Full list with rationale in [docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md). The
ones that shape day-to-day work:

**Monorepo with enforced boundaries.** Apps are tagged `type:app`, libraries
`type:lib`. ESLint rejects an app importing another app. Without that rule a
monorepo becomes a distributed monolith.

**`libs/contracts` holds DTOs; models are never shared.** The message shape
between two services is a genuine shared concern. A Sequelize model is a
service's private persistence detail.

**API Gateway as a NestJS app, not nginx.** A reverse proxy forwards bytes and
understands nothing about the API. The gateway validates bodies and maps
downstream failures to honest status codes: pass-through, 503, 504, 502.

**HTTP between services, not RabbitMQ.** "Log me in" and "fetch this product"
are genuinely synchronous. Messaging arrives for work that does not need an
answer now (M7).

**Money is `DECIMAL(12,2)`, never a float, and crosses the wire as a string.**
0.1 + 0.2 !== 0.3 in IEEE-754, and rounding errors in money reach an
accountant before they reach an engineer.

**Constraints live in the database.** Unique indexes, foreign keys and CHECK
constraints hold for every writer — this service, psql, a future data-fix
script. Application validation only holds for callers that go through the
application.

**Uniqueness by unique index, never check-then-insert.** Two concurrent writes
both pass a pre-check and both insert. Only the index is atomic.

**Soft delete everywhere, `ON DELETE RESTRICT` for real deletes.** Order
history will reference products long after they stop being sold. Deleting a
category must not silently delete its products.

**A cache is an optimisation, so it must never be a hard dependency.** Redis
connects lazily and every cache operation fails open. PostgreSQL, by
contrast, is proven at boot — a service without its database cannot do its
job at all, and should refuse to start.

**The cart lives in PostgreSQL, not Redis.** It must survive a restart, be
queryable for abandonment analytics, and be transactional with order creation.
Redis is used in that flow for exactly one thing — caching token
introspection — which is the difference between picking a tool because it
fits and because it is installed.

**Money arithmetic happens in integer minor units.** Float drift appears for
some prices and not others (`16.08 * 3` is lossy, `19.99 * 3` is not), so
spot-checking a handful of values proves nothing.

**The gateway introspects tokens rather than verifying them.** An HS256 key
that can verify can also mint; handing a public-facing process that ability
to read one claim is a bad trade. RS256 is the clean fix and is still
pending.

**Events are facts, not instructions.** A publisher that emits
`send.welcome.email` has decided who should react. `user.registered` lets
consumers appear and disappear without it ever changing.

**Use the framework's answer before building your own.** RabbitMQ goes
through `@nestjs/microservices` — no custom connection manager, publisher
or consumer. Complexity is added when a lesson demands it, not upfront.

**Stock is never cached.** The Inventory Service has no `REDIS_URL`. A
cached `available: 1` is not a slightly stale product name — it is a promise
the warehouse cannot keep, and the staleness window is exactly the window in
which the last unit gets sold twice.

**The availability check and the write are one statement.** A transaction
alone does not close a check-then-act race: under READ COMMITTED a plain
SELECT takes no lock, so two transactions both read "1 available" and both
proceed. Atomicity is not mutual exclusion.

**Invalidate by generation, never by scanning.** `KEYS` blocks
single-threaded Redis across the whole keyspace. Embedding a counter in the
key and incrementing it invalidates every list page in O(1).

**`synchronize: false`, hardcoded.** No environment toggle. Sequelize may
never emit DDL, so the migration history cannot become a lie.

**`useDefineForClassFields: false`.** Required for decorator-based ORMs. With
ES2022 class-field semantics, a declared field shadows the accessor
sequelize-typescript installs and every property silently reads `undefined`.

---

## Known gaps

Stated plainly, tracked with triggers in
[docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md):

1. **Catalogue AND inventory write endpoints are unauthenticated.** Anyone
   reaching the gateway can create, edit and delete products, invent or
   destroy stock via `receive` and `adjust`, or cancel someone else's
   reservation via `release`. `AuthenticatedUserGuard` now exists, so
   closing this is a small change — but until it is done, this stack **must
   not be exposed beyond localhost**.
2. **Internal services trust `X-User-Id`.** The Cart Service does not verify
   tokens; it believes a header, safe only because it binds to loopback.
   Needs a shared secret, mTLS, or RS256 internal tokens.
3. **Messaging has no retry, dead-letter queue or idempotency.** A failed
   handler loses its message; a duplicate delivery flags a line twice. Both
   are harmless for today's events and neither would be once an event means
   an order.
4. **The dual-write problem is unsolved.** A publish can fail after its
   database commit, losing the event with only a log line.
5. **Rate limiting is per-IP only** and fails open when Redis is down. It
   raises the cost of credential stuffing; it does not stop a distributed
   attack. Per-account lockout and MFA are still absent.
6. **No RBAC**, though `role` is already a claim and a column.
7. **No audit logging** of authentication or catalogue mutations.
8. **No correlation IDs** — a request cannot yet be traced across services.
9. **Reservations never expire.** An abandoned cart holds stock indefinitely.
   Needs per-order reservation records with a TTL (M6/M8).
10. **Stock operations are not idempotent.** Retrying a reserve after a
    timeout double-reserves (M8).
11. **`.env` holds development secrets** that have appeared in a terminal
    transcript. Rotate before any shared environment.

---

## Troubleshooting

**`npm start` looks like it hangs** — it is _supposed_ to keep running:
`serve` is a continuous target and only exits on Ctrl+C. A cold run rebuilds
every app with webpack (~60–90s); a warm run is ~10–15s. You are up when you
see three `listening on ...` lines and two `connected to "ecommerce_*_db"`
lines.

**`npm start` fails or stalls right after you stopped it** — stopping the
parent does not reliably kill the child node processes on Windows, so the old
servers still hold the ports. Run `npm run stop`, then start again.

**`Config validation error: ...`** — a variable in `.env` is missing or
malformed. The message names the key. This is the validation working.

**`503 <service> is unavailable`** — the gateway is up but a downstream
service is not. `npm start` runs all three.

**`SequelizeConnectionError: password authentication failed`** — the `*_DB_*`
values in `.env` do not match the role in PostgreSQL. Note that PostgreSQL
reports a _nonexistent_ role with this same message.

**`relation "products" does not exist`** — run `npm run db:migrate`.

**`409 Insufficient stock` when you expected success** — the response body
carries `requested` and `available`. Check the ledger with
`GET /api/inventory/:productId/movements` to see what consumed the stock.

**`npm run demo:oversell` reports 429s** — `reserve` is limited to 30/min.
Wait a minute, or lower `--concurrency`.

**Events are published but nothing reacts** — check the Cart Service log for
`consuming RabbitMQ queue "ecommerce_events"`. If it says
`RabbitMQ consumer did not start`, the broker is not running. Every service
still serves HTTP without it; only the catalogue flags go stale.

**`column cart_items.catalogue_price does not exist`** — run
`npm run db:migrate`.

**`401 Authentication required` on `/api/cart`** — every cart route needs
`Authorization: Bearer <token>`. Register or log in first.

**`503 Authentication is temporarily unavailable`** — the gateway could not
reach the Auth Service to introspect the token. Unlike rate limiting,
authentication fails CLOSED: failing open would be a complete bypass rather
than a degradation.

**`Unknown authentication strategy "jwt"`** — `JwtStrategy` is missing from a
module's `providers`. Instantiation is what registers it with Passport.

**Every model property reads `undefined`** — `useDefineForClassFields` is true
somewhere. It must be false for sequelize-typescript.

**`Projects cannot be imported by a relative or absolute path`** — a project
imported across a boundary. Fix the dependency direction; do not relax the
rule.

**`Starting inspector on localhost:9229 failed: address already in use`** —
two services tried to attach a Node debugger to the same port. Each serve
target pins its own in `project.json` (3000→9229, 3001→9230, 3002→9231).

**Postman: `Missing environment variable(s)`** — the `ecommerce · local`
environment is not selected in the top-right picker.

**`redis unavailable at startup — running without cache`** — Redis is not
running. The services work; every read goes to PostgreSQL and rate limiting
is inactive. Start it with `docker run -d --name ecommerce-redis -p 6379:6379 redis:7-alpine`.

**`X-Cache` is always MISS** — either Redis is down (see above) or
`CACHE_ENABLED=false` in `.env`. Check the product service log for
`connected to redis://...`.

**A stale price after an update** — invalidation failed. Confirm the write
returned 2xx: invalidation deliberately runs only after a successful commit.
`CACHE_ENABLED=false` isolates the cache from the database as a first check.

**Unexpected 429s while testing** — `/api/auth/login` allows 5 per minute.
Wait for `Retry-After`, or clear the counter with
`docker exec ecommerce-redis redis-cli --scan --pattern 'ecom:gateway:rl:*' | xargs -r docker exec -i ecommerce-redis redis-cli del`.

**Nx returns a stale result** — clear the local cache with `npx nx reset`.
