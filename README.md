# E-Commerce Microservices Backend

A production-oriented e-commerce backend, built incrementally as a learning
project. Each milestone introduces one architectural concern at a time and
explains why it exists before it is added.

> **Current status: the 15-milestone plan is complete** (M13, testing, skipped).
> Eight services over HTTP and RabbitMQ. A customer can register, browse,
> fill a cart, place an order, pay for it against a mock provider, and be
> emailed about all of it. Events now go through a **topic exchange**, so two
> services can react to the same event — the limitation M7 wrote down and
> M10 had to fix. Emails are deduplicated, because an email is the first
> thing in this system that cannot simply be done twice. Every line of every
> log is JSON carrying a **correlation id**, so one customer's journey across
> eight services is a single `grep` — and OpenTelemetry traces show where the
> time went. Every service now answers `/health/live` and `/health/ready`,
> shuts down gracefully, and funnels every error through one filter that tells
> a customer nothing an attacker could use. Tokens are **RS256**, so the
> gateway can verify one without being able to mint one — which is what
> finally closed the unauthenticated catalogue and inventory writes that had
> stood open since M3. Sessions are **revocable**: a 30-day refresh token,
> rotated on every use, that revokes the entire session if an already-used
> one is ever replayed. And a message a consumer cannot process is **parked**
> in a dead-letter queue with a replay path, rather than silently dropped.
> The whole stack — eight services, PostgreSQL, Redis, RabbitMQ and MailHog —
> starts with one `docker compose up`, and GitHub Actions proves on every
> push that a machine with nothing on it can build, start and use the whole
> thing.

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
- [Signing keys](#signing-keys)
- [Database and migrations](#database-and-migrations)
- [Caching and rate limiting](#caching-and-rate-limiting)
- [Messaging](#messaging)
- [API](#api)
- [Postman](#postman)
- [Docker](#docker)
- [CI](#ci)
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
     │  POST /api/auth/login      ·   POST /api/cart/items
     │  GET  /api/auth/me         ·   POST /api/orders
     ▼
┌──────────────────────┐
│  API Gateway :3000   │  public · /api · DTO validation · auth guard · routing
└──────────┬───────────┘
           │ HTTP (axios, 5s timeout, honest failure mapping, X-User-Id)
   ┌──────┼────────┬─────────┬────────┬─────────┬──────────┐
   ▼      ▼        ▼         ▼        ▼         ▼          ▼
┌─────┐┌───────┐┌─────────┐┌──────┐┌───────┐┌───────┐┌────────────┐
│Auth ││Product││Inventory││Cart  ││Order  ││Payment││Notification│
│:3001││:3002  ││:3003    ││:3004 ││:3005  ││:3006  ││:3007       │
└──┬──┘└───┬───┘└────┬────┘└──┬───┘└───┬───┘└───┬───┘└─────┬──────┘
   ▼       ▼         ▼        ▼        ▼        ▼          ▼
ecommerce_ ecommerce_ ecommerce_ ecommerce_ ecommerce_ ecommerce_ ecommerce_
 auth_db   product_db inventory  cart_db    order_db  payment_db notification
                       _db                                          _db
                          schema from migrations only

Checkout and payment are two calls, each retryable on its own:
   POST /orders   read cart → write order + lines in ONE transaction →
                  order.confirmed → the Cart Service converts that cart
   POST /payments read the order's amount → write PENDING → charge the
                  provider → payment.succeeded → the order marks itself PAID
   No stock is reserved yet — reserving needs an undo, and that workflow is
   deferred with a trigger written down.

      RabbitMQ :5672  ·  TOPIC EXCHANGE ecommerce.events
  user.registered · product.price_changed · product.archived
  inventory.reserved · inventory.released
  order.confirmed · order.cancelled
  payment.succeeded · payment.failed

  One durable queue per consuming service, bound to the keys it wants:
    cart_service          ← product.* · order.confirmed
    order_service         ← payment.succeeded · payment.failed
    notification_service  ← user.registered · order.confirmed
                            · payment.succeeded
  `order.confirmed` reaches TWO of them, each with its own copy.

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
| Money                | `DECIMAL(12,2)`, exposed as an exact string      | M3                         |
| Cache                | Redis                                            | M4                         |
| Messaging            | RabbitMQ                                         | M7                         |
| Email                | Nodemailer + MailHog                             | M10                        |
| Logging / tracing    | Pino, OpenTelemetry, SigNoz                      | M11                        |
| Testing              | Jest                                             | unit specs throughout; M13 skipped |
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
│   │       └── main.ts               ValidationPipe + bootstrap
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
│   ├── inventory/                    INTERNAL · 3003 · inspector 9232
│   │   └── src/
│   │       ├── inventory/            models, repository, service, controller
│   │       │   └── inventory.repository.ts   the atomic reserve statement
│   │       ├── database/             migrations: items + ledger
│   │       ├── config/
│   │       └── main.ts
│   │
│   ├── cart/                         INTERNAL · 3004 · inspector 9233
│   │   └── src/
│   │       ├── cart/                 models, repository, service, controller
│   │       ├── catalog/              product lookup + catalogue event handlers
│   │       ├── orders/               order.confirmed → cart CONVERTED
│   │       ├── database/             migrations: carts + lines
│   │       └── main.ts               HYBRID: HTTP + RabbitMQ listener
│   │
│   ├── order/                        INTERNAL · 3005 · inspector 9234
│   │   └── src/
│   │       ├── orders/               models, repository, service, controller
│   │       │                         publishes order.confirmed / .cancelled
│   │       ├── cart/                 reads the cart it builds the order from
│   │       ├── payments/             payment.succeeded → order PAID
│   │       ├── database/             migrations: orders + items
│   │       └── main.ts               HYBRID: HTTP + RabbitMQ listener
│   │
│   ├── payment/                      INTERNAL · 3006 · inspector 9235
│   │   └── src/
│   │       ├── payments/             model, repository, service, controller
│   │       ├── provider/             the mock provider and its test tokens
│   │       ├── orders/               reads the amount it is allowed to charge
│   │       ├── database/             migrations: payments
│   │       └── main.ts
│   │
│   └── notification/                 INTERNAL · 3007 · inspector 9236
│       └── src/
│           ├── notifications/        models, repository, service, read API
│           ├── events/               the three consumers
│           ├── mailer/               Nodemailer, log or SMTP
│           ├── templates/            welcome · confirmation · receipt
│           ├── database/             migrations: contacts + notifications
│           └── main.ts               HYBRID, and mostly a consumer
│
├── libs/
│   ├── contracts/                    @ecommerce/contracts · type:lib
│   │   └── src/lib/
│   │       ├── auth/                 register, login, tokens, roles
│   │       ├── catalog/              product, category, query DTOs
│   │       ├── inventory/            stock DTOs and movement types
│   │       ├── cart/                 cart and line DTOs
│   │       ├── orders/               order DTOs and statuses
│   │       ├── payments/             payment DTOs, statuses, test tokens
│   │       ├── notifications/        notification DTOs and types
│   │       ├── events/               event patterns and payloads
│   │       └── common/               pagination envelope
│   ├── money/                        @ecommerce/money · type:lib
│   │   └── src/lib/money.ts          exact decimals in integer minor units
│   ├── observability/                @ecommerce/observability · type:lib
│   │   ├── src/tracing.ts            the side-effect entry point, imported FIRST
│   │   └── src/lib/
│   │       ├── correlation.ts        AsyncLocalStorage, and why not a variable
│   │       ├── correlation.middleware.ts  adopt or mint, per request
│   │       ├── pino-logger.service.ts     Pino behind Nest's LoggerService
│   │       └── tracing.ts            OpenTelemetry, lazily loaded and off by default
│   └── redis/                        @ecommerce/redis · type:lib
│       └── src/lib/
│           ├── redis.module.ts       lazily-connected client, key prefix
│           └── cache.service.ts      cache-aside, TTL, invalidation
│
├── docs/
│   ├── PROJECT-PLAN.md               milestones, progress, deferred items
│   ├── SCHEMA.md                     every table, and why it looks like that
│   └── OBSERVABILITY.md              logs, traces, metrics — and which to reach for
├── postman/                          collection + local environment
├── tools/
│   ├── free-ports.mjs                kills orphaned dev servers
│   ├── oversell-demo.mjs             concurrent reservation proof
│   └── messaging-demo.mjs            an event travelling Product → Cart
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

> **The short way:** `npm run docker:up` starts everything — services and
> infrastructure — and creates the seven databases for you. See
> [Docker](#docker). The rest of this section is the manual route, which is
> still the better one for day-to-day development.

Start Redis and RabbitMQ — the simplest route is containers:

```bash
docker run -d --name ecommerce-redis -p 6379:6379 redis:7-alpine
```

```bash
docker run -d --name ecommerce-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

Then declare the topology — exchanges, service queues with their
dead-letter arguments, and the parking queues:

```bash
node tools/setup-broker.mjs
```

⚠️ **Upgrading an existing broker** (queues created before M12 pass 4) needs
`--recreate`, which **deletes the three service queues and discards any
messages in them**. A queue's arguments are fixed when it is declared, so a
queue that already exists without `x-dead-letter-exchange` makes the service
refuse to start with `PRECONDITION_FAILED`:

```bash
node tools/setup-broker.mjs --recreate
```

The RabbitMQ management UI is at <http://localhost:15672> (guest / guest) —
the best way to see exchanges, bindings, queue depths and what is parked.

```bash
cp .env.example .env
```

Fill in the `*_DB_PASSWORD` values, then generate the RS256 keypair (see
[Signing keys](#signing-keys)):

```bash
node tools/generate-jwt-keys.mjs
```

Create the databases (next section), then:

```bash
npm run db:migrate
```

```bash
npm start
```

---

## Signing keys

The Auth Service signs access tokens with **RS256**, so before anything will
boot:

```bash
node tools/generate-jwt-keys.mjs
```

That writes `keys/jwt-private.pem` and `keys/jwt-public.pem`, both
git-ignored, and `.env` already points at them.

| Key | Who holds it | What it does |
| --- | --- | --- |
| private | Auth Service, only | **signs**. Never leaves that process |
| public | everyone, including the gateway | **verifies**. Forges nothing |

That asymmetry is the point. Under the old HS256 secret, any process that
could CHECK a token could also MINT one — which is why the gateway could not
verify tokens at all, and why the catalogue writes stayed open for nine
milestones.

Tokens carry a `kid`. Nothing reads it yet; it is there so a future rotation
can keep accepting the old key until the last token issued under it expires.

### Making an admin

There is deliberately no API for it — an endpoint that creates its own
administrators is a privilege-escalation hole waiting to be found. Register
normally, then promote the account:

```bash
psql -U postgres -d ecommerce_auth_db -c "UPDATE users SET role = 'ADMIN' WHERE email = 'you@example.test';"
```

Log in again afterwards. The role is read from the database on every
introspection, but the token has to be re-issued for `/auth/me` to report it.

---

## Database and migrations

### Naming convention

Every PostgreSQL object this project creates is prefixed **`ecommerce_`** —
both the database and the login role:

| Service   | Database                 | Owning role                   | Status |
| --------- | ------------------------ | ----------------------------- | ------ |
| Auth      | `ecommerce_auth_db`      | `ecommerce_auth_service`      | ✅     |
| Product   | `ecommerce_product_db`   | `ecommerce_product_service`   | ✅     |
| Inventory | `ecommerce_inventory_db` | `ecommerce_inventory_service` | ✅     |
| Cart      | `ecommerce_cart_db`      | `ecommerce_cart_service`      | ✅     |
| Order     | `ecommerce_order_db`     | `ecommerce_order_service`     | ✅     |
| Payment   | `ecommerce_payment_db`   | `ecommerce_payment_service`   | ✅     |

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

### Publishing after the commit, and what that costs

There is no transaction that spans PostgreSQL and RabbitMQ, so a service that
changes state and announces it has exactly two orderings to choose from, and
both can fail:

| Order                    | The failure it admits                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| publish, **then** commit | the commit fails and the world has been told about an order that does not exist |
| commit, **then** publish | the process dies in between; the row exists and nobody is ever told             |

Every publisher here takes the second. For orders that means a cart that
stays full after a successful order — visible, harmless, and fixable by the
customer. The other failure invents orders, which is not.

The proper fix is a **transactional outbox**: write the event into the same
transaction as the row, and let a separate relay publish it. It is deferred
until a lost event costs something real, and the trigger is written down in
[docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md).

### Consumers must survive being told twice

RabbitMQ delivers **at-least-once**, so every handler will eventually run
twice for the same message. There are two defences, and the cheap one is
almost always right:

**1. Be naturally repeatable.** A conditional UPDATE does nothing the second
time, and the consumer never needs to know it has seen the message before:

```sql
UPDATE carts  SET status = 'CONVERTED' WHERE id = :cartId AND status = 'ACTIVE'
UPDATE orders SET status = 'PAID'      WHERE id = :orderId AND status = 'CONFIRMED'
```

**2. Recognise the repeat.** Some work cannot be made repeatable — there is
no WHERE clause that un-sends an email. Those consumers claim the event id in
a ledger before acting:

```ts
// an INSERT that FAILS, not a SELECT that races
const claimed = await repo.claimEvent(event.eventId, pattern);
if (!claimed) return;
```

Every event payload carries an `eventId`, stamped by the publisher and the
same on every delivery. Only the Notification Service keeps a ledger: a row
per event forever, plus a write on the hot path, is a real cost and buying it
where a conditional UPDATE already works is paying twice.

Claiming **before** the work is a deliberate trade — a crash in between costs
one missed email, where claiming afterwards would cost a duplicate on every
crash.

### The world when the message arrives, not when it was sent

`order.confirmed` carries the `cartId`. The consumer converts **that** cart,
not "the user's active cart" — because if the broker was down for a minute,
the customer may already have started a new one, and emptying it would take
away a basket they are still filling. That is what eventual consistency
actually asks of a consumer.

### Events are facts, not instructions

`user.registered`, never `send.welcome.email`. A command says "do this" and
is addressed to one handler; an event says "this happened" and is addressed
to nobody in particular. The second name would couple Auth to the existence
of an email system.

### The topic exchange, and why it arrived in M10

Through M7–M9 every event went to one queue and one service read it. That
was simple, and it had a limitation: **RabbitMQ delivers each message in a
queue to exactly one consumer.** A second service reading the same queue does
not get a copy — it competes, and roughly half of every event goes to the
wrong place.

The Notification Service needs `order.confirmed`, and so does the Cart
Service. There is no arrangement of one queue that gives both the same
message. So publishers now publish to a **topic exchange**, and every
consuming service declares its own durable queue bound to the routing keys it
wants:

```ts
// publisher — knows nothing about who is listening
{ exchange: 'ecommerce.events', exchangeType: 'topic', wildcards: true }

// consumer — its own queue, bound once per @EventPattern() in the app
{ queue: ServiceQueue.Notification, exchange: 'ecommerce.events',
  exchangeType: 'topic', wildcards: true, queueOptions: { durable: true } }
```

`wildcards: true` is what tells Nest to use the event pattern as the
**routing key** rather than as a queue name. **No publisher code changed** —
only its configuration.

Two replicas of one service still share that service's queue and still
compete for its messages, which is exactly what you want when scaling out.
Competing consumers _within_ a service is a feature; competing _across_
services was the bug.

A binding outlives the code that asked for it: deleting a handler does not
remove its binding, so messages pile up in that queue until someone unbinds
it by hand.

### A message that cannot be processed is PARKED, not lost

Until M12 pass 4 a handler that threw lost its message: Nest's RMQ transport
defaults to `noAck: true`, so the broker considers a message delivered the
moment it is handed over.

Three things you can do with a failure, and the middle one is a trap:

| | What happens | Why not |
| --- | --- | --- |
| **Drop** (`noAck: true`) | message vanishes | the failure leaves nothing to act on |
| **Requeue** (requeue=true) | back to the head of the queue | **poison-message loop** — redelivered instantly, fails again, consumer spins forever |
| **Park** (requeue=false + DLX) | broker moves it to a parking queue | nothing spins, nothing is lost, and the parked count is alertable |

```text
ecommerce.events (topic)
  ├── cart_service          ──fail──►  ecommerce.events.dlx (direct)
  ├── order_service         ──fail──►        │
  └── notification_service  ──fail──►        ├── cart_service.parked
                                             ├── order_service.parked
                                             └── notification_service.parked
```

The DLX is **direct** while the main exchange is topic: a published event
does not know who is listening, but a parked one goes to exactly one place.
Each queue also sets `x-dead-letter-routing-key` to its own name — without
that rewrite the message keeps `order.confirmed`, nothing is bound to that
on a direct exchange, and it is dropped silently.

Handlers acknowledge manually through `ackOrPark`. With `noAck: false`
Nest does nothing on the handler's behalf, and a handler that forgets leaves
the message unacknowledged forever — not redelivered, not parked, quietly
eating a slot of the prefetch budget until the consumer stops receiving
anything at all.

**Ack means "I am done with this", not "it succeeded."** A duplicate delivery
whose conditional UPDATE matched no rows is finished. Only a handler that
*threw* is parked.

#### Replaying

```bash
node tools/replay-parked.mjs                        # what is parked?
node tools/replay-parked.mjs --peek cart_service    # read without consuming
node tools/replay-parked.mjs --replay cart_service  # put them back
```

Each message is republished **first**, with publisher confirms, and acked
from the parking queue only once the broker confirms it holds the copy.
Ack-then-publish loses the message on a crash in between — from the one queue
whose whole job was not losing it.

Replay before fixing the cause and it parks again. That is the loop working;
replaying on a cron is requeueing with extra latency.

### What is still deliberately not built

**Retry with backoff.** A two-second database blip parks a message a second
attempt would have handled. The refinement is a retry queue with a TTL that
dead-letters back to the main queue. **Alerting** on the parked count is also
absent — the number is visible at `:15672` and nobody is watching it.

A transactional outbox and an event envelope remain absent too; see
[the deferred table](docs/PROJECT-PLAN.md) for the trigger on each.

## API

There is no generated API documentation in this project — no Swagger, no
OpenAPI. The [Postman collection](postman) is the executable reference: every
endpoint, with worked examples and assertions that run.

That is a deliberate choice for a learning project. Decorator-driven docs add
three or four lines of annotation to every route and DTO, which is noise while
you are trying to read what the code actually _does_. A collection you can run
is a better teacher than a page you can only look at.

### Health

On **each service's own port**, not behind the gateway — a probe that reaches
the Order Service through the gateway tells you about the gateway.

| Method | Path            | Auth | Returns                                     |
| ------ | --------------- | ---- | ------------------------------------------- |
| `GET`  | `/health/live`  | —    | 200 if the process can answer. Nothing else |
| `GET`  | `/health/ready` | —    | 200 / 503 · every dependency, named         |

Two endpoints because an orchestrator asks two questions and reacts to them
very differently:

| Probe    | Asks                                | A failure means             |
| -------- | ----------------------------------- | --------------------------- |
| liveness | "is this process wedged?"           | **kill and restart** it     |
| readiness | "should this instance get traffic?" | **take it out of the pool** |

So **liveness checks nothing**. A liveness probe that touches the database
restarts every replica during a database blip — turning a brief dependency
outage into a total application outage, with the restart storm then keeping
the database down. Dependencies belong in readiness, where a failure removes
the instance from the load balancer and leaves it running to recover.

Each check carries a **2-second timeout**: a health endpoint that hangs is
worse than one that fails, because the probe times out too and takes longer
to notice. A dependency a service does not have reports `up` with
`detail: "not configured"` — never silently skipped. The broker is reported
as `degraded` rather than down in services that still work without it.

### Auth

| Method | Path                 | Auth   | Returns                   |
| ------ | -------------------- | ------ | ------------------------- |
| `POST` | `/api/auth/register` | —      | 201 · user + token pair   |
| `POST` | `/api/auth/login`    | —      | 200 · user + token pair   |
| `POST` | `/api/auth/refresh`  | —      | 200 · a NEW token pair    |
| `POST` | `/api/auth/logout`   | —      | 204 · always              |
| `GET`  | `/api/auth/me`       | Bearer | 200 · user profile        |

**Two tokens, two jobs.** The `accessToken` is a ~15-minute JWT, checked by
signature and sent on every request — short because nothing can revoke it.
The `refreshToken` is an opaque ~30-day string checked against a database
row, sent only to `/auth/refresh` — long because it *is* revocable.

`/auth/refresh` and `/auth/logout` take the refresh token **in the body**,
not the `Authorization` header: it is the subject of the request rather than
a credential for it, and mixing the two invites middleware to treat a 30-day
credential like a 15-minute one. Neither requires an access token — you call
refresh precisely because yours expired.

**Rotation and reuse detection.** Every refresh retires the token presented.
Replaying a retired one means two parties hold it, so the whole session is
revoked and both go back to the password. Blunt on purpose.

Logout cannot recall an access token already issued. The client must discard
it; the residual window is 15 minutes.

### Catalogue

**Reads are public. Writes require an authenticated ADMIN** — 401 without a
token, 403 with a customer's. Send `Authorization: Bearer <admin token>`.

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

### Cart

Every route is authenticated and always operates on **your** cart — there is
no `:cartId` to tamper with.

| Method   | Path                         | Returns                     |
| -------- | ---------------------------- | --------------------------- |
| `GET`    | `/api/cart`                  | 200 · your cart with totals |
| `POST`   | `/api/cart/items`            | 201 · the whole cart        |
| `PATCH`  | `/api/cart/items/:productId` | 200 · the whole cart        |
| `DELETE` | `/api/cart/items/:productId` | 200 · the whole cart        |
| `DELETE` | `/api/cart`                  | 200 · the emptied cart      |

### Orders

| Method | Path                     | Returns                               |
| ------ | ------------------------ | ------------------------------------- |
| `POST` | `/api/orders`            | 201 · the order, built from your cart |
| `GET`  | `/api/orders`            | 200 · paginated, newest first         |
| `GET`  | `/api/orders/:id`        | 200 · the order                       |
| `POST` | `/api/orders/:id/cancel` | 200 · the cancelled order             |

`POST /api/orders` takes an **empty body**. The lines, the prices and the
owner all come from the server — from the cart, and from the verified token.

Placing an order publishes `order.confirmed`, and the Cart Service marks that
cart `CONVERTED` when it arrives — so the cart empties itself a moment later,
not instantly. **Stock is still not reserved at checkout**, which is a real
gap recorded with its trigger in
[docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md).

### Payments

| Method | Path                | Returns                                                     |
| ------ | ------------------- | ----------------------------------------------------------- |
| `POST` | `/api/payments`     | 201 · the payment · 402 declined · 503 provider unreachable |
| `GET`  | `/api/payments`     | 200 · paginated, newest first                               |
| `GET`  | `/api/payments/:id` | 200 · one payment                                           |

```json
POST /api/payments
{ "orderId": "…", "paymentMethodToken": "tok_ok" }
```

**No card number, no CVV, no amount.** The amount comes from the order; the
card comes from a provider token. The test tokens are `tok_ok`,
`tok_declined`, `tok_fraud`, `tok_timeout`, `tok_unavailable` and
`tok_flaky` — see `libs/contracts/src/lib/payments/payment.dto.ts`.

Send an `Idempotency-Key` header. A repeat of the same request replays the
first attempt's answer — **200** with `Idempotent-Replay: true` instead of
201 — and charges nothing. A second payment for an order that already has one
is refused with **409 before the provider is called**, so nothing is charged
there either. Those are two different protections: the 409 stops a double
charge, the key tells a client that timed out what actually happened.

**402 vs 503** is the distinction worth learning here. A 402 means the card
was declined: the request was fine, and retrying it identically will fail
identically. A 503 means we never got an answer, the outcome is genuinely
unknown, and a retry is the right response — the body carries `retryable` so
a client does not have to keep its own table of which codes are worth
repeating.

### Notifications

| Method | Path                 | Returns                         |
| ------ | -------------------- | ------------------------------- |
| `GET`  | `/api/notifications` | 200 · your emails, newest first |

**There is deliberately no `POST`.** Nobody asks the Notification Service to
send an email — it decides for itself what an event implies. An endpoint here
would invite a business service back into issuing instructions, which is the
coupling the service exists to remove.

Emails go nowhere by default (`MAIL_TRANSPORT=log` prints the subject and
recipient). To see real messages, start MailHog and switch the transport:

```bash
docker run -d --name ecommerce-mailhog -p 1025:1025 -p 8025:8025 mailhog/mailhog
```

Then set `MAIL_TRANSPORT=smtp` and read the mail at http://localhost:8025.

### Following one request across eight services

Every request and every event carries a **correlation id**. It is minted at
the gateway (or adopted from an `X-Correlation-Id` header you supply), comes
back on the response, and travels on to every hop — HTTP headers between
services, a `correlationId` field on every event payload.

```bash
npm start | grep 9f2c1a7e
```

```text
[gateway]      POST /api/orders 201 84ms
[order]        order ORD-00000042: 2 line(s), 48.24 USD
[cart]         cart 3f9…: marked CONVERTED
[notification] ORDER_CONFIRMED → ada@example.test
```

Logs are JSON by default; set `LOG_PRETTY=true` for the colourised form
above, and `LOG_LEVEL` to turn the volume up during an incident without a
deploy. Authorization headers, passwords, tokens and anything card-shaped are
redacted on every line.

For **traces** — where the time actually went — set `OTEL_ENABLED=true`. With
`OTEL_EXPORTER=console` (the default) spans print to stdout and nothing needs
installing; with `otlp` they go to SigNoz or any OTLP collector. Every log
line then also carries `trace_id`, so an error is one click from its
waterfall.

Full reference: **[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)**.

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

| Code      | When                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400       | Validation failed, unknown property, bad UUID, inverted price range, empty patch                                                                        |
| 401       | Missing, expired, tampered token; bad credentials                                                                                                       |
| 404       | Product, category, cart line or order not found                                                                                                         |
| 409       | Email, SKU, category name or slug in use; category still has products; insufficient stock; cart changed under the customer; order no longer cancellable |
| 500       | Something nobody anticipated. The body carries the correlation id and **nothing else** — the cause is in the log                                        |
| 503 / 504 | Downstream service unavailable / timed out; `/health/ready` with a dependency down                                                                      |

Every error — including a 500 — leaves in the same envelope:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Order not found",
  "correlationId": "9f2c1a7e-...",
  "path": "/api/orders/6e1…",
  "timestamp": "2026-09-15T11:04:22.517Z"
}
```

The `correlationId` is the one thing a customer can usefully quote, and the
one thing you grep for.

---

## Postman

Two files in [`postman/`](postman), both committed:

| File                                       | What it is                              |
| ------------------------------------------ | --------------------------------------- |
| `ecommerce.postman_collection.json`        | The requests, with a short note on each |
| `ecommerce.local.postman_environment.json` | URLs, ports and test credentials        |

**Import both**: Postman → _Import_ → drag both files in. Then select
**`ecommerce · local`** in the environment picker — a collection-level
pre-request script fails loudly with a clear message if you forget.

| Folder              | Contents                                                          |
| ------------------- | ----------------------------------------------------------------- |
| `0 · Health`        | Liveness and readiness, on each service's own port. Run any time.  |
| `1 · Auth`          | Register → login → me. Saves the token the rest of them use.      |
| `2 · Catalogue`     | Category → product → publish → read, filter, patch.               |
| `3 · Inventory`     | Receive, reserve, release, fulfil, adjust, and the ledger.        |
| `4 · Cart`          | Get or create, add, upsert, set quantity, remove, empty.          |
| `5 · Orders`        | Place, read, list, cancel.                                        |
| `6 · Payments`      | Charge, replay the idempotency key, decline, refund, list.        |
| `7 · Notifications` | What was sent, and the dedupe ledger behind it.                   |
| `8 · Cleanup`       | Deletes the product. Run last, or not at all.                     |

Requests are plain — **no assertions**, and only three small scripts that
hand the token and a couple of ids to the requests that follow. The
assertion-heavy version (deliberately-failing requests, cache and rate-limit
checks, the messaging walkthrough) was taken out while the order workflow is
being built, and is in git history if it is wanted back.

Run the folders **top to bottom on a fresh start**: folder 1 saves a token,
folder 2 saves a product id, and folders 3–5 use them.

---

## Docker

The whole system — eleven containers — on one command.

```bash
npm run docker:up
```

```bash
npm run docker:migrate
```

The second one is separate on purpose: **migrations are not run at startup.**
A service that migrates as it boots will, with three replicas, run three
migrations at once; and a schema change that fails takes the deploy with it
in a way nobody can see. Migrations are a deliberate step with a human behind
them.

| Command | What it does |
| --- | --- |
| `npm run docker:up` | Build and start everything |
| `npm run docker:migrate` | Run every service's migrations |
| `npm run docker:ps` | What is running, and whether it is healthy |
| `npm run docker:logs` | Follow all logs (`docker compose logs -f order` for one) |
| `npm run docker:down` | Stop, **keep** the data |
| `npm run docker:reset` | Stop and **delete** the databases and queues |

You still need `.env` (the containers read it) and the signing keypair
(`node tools/generate-jwt-keys.mjs`), which is mounted read-only rather than
baked into an image.

### What is published, and what is not

| | Host | Why |
| --- | --- | --- |
| API Gateway | `3000` | the only public entry point |
| PostgreSQL | **5433** | not 5432 — see below |
| Redis | `6379` | so you can `redis-cli` against it |
| RabbitMQ | `5672`, UI `15672` | queue depths and the parked messages |
| MailHog | SMTP `1025`, UI `8025` | read the emails the system sends |
| The other seven services | **nothing** | they are internal |

Postgres is on **5433** because a developer machine usually has its own
Postgres on 5432. Publishing there either fails to bind or — much worse —
silently points your tools at the wrong database. Inside the compose network
the services still use 5432; the mapping only affects the host.

The seven internal services publish **no port at all**. That is the topology
this design has claimed since Milestone 2 and never actually had: running on
a laptop, they all listen on `127.0.0.1` and anything on the machine can
reach them. In compose, the network namespace is the boundary.

### One Dockerfile, eight images

```bash
docker build --build-arg APP=auth -t ecommerce/auth .
```

Eight near-identical Dockerfiles drift: one gets a base-image update, one
keeps running as root, one forgets `--omit=dev`. The only real difference
between these services is which entry point runs.

**Multi-stage**, so the toolchain does not ship. The builder holds the Nx
workspace, TypeScript, every devDependency and the source — roughly 1.5GB,
all of it attack surface that would have to be patched forever. The runtime
image gets the compiled bundle, its production dependencies and nothing
else. A compiler that is not in the image cannot be used by whoever gets in.

Three details worth knowing:

- **`npm ci` before `COPY . .`** — Docker caches layers by their inputs, so
  an unchanged lockfile means the whole install is reused. Copying source
  first would invalidate it on every edit and turn a twenty-second rebuild
  into three minutes.
- **`bcrypt` is native**, compiled at install time. The builder and the
  runtime are both Alpine deliberately: a binary built against musl will not
  load on glibc, and the error (`invalid ELF header`) reads like a corrupt
  file rather than a base-image mismatch.
- **`tini` as PID 1** — Node does not reap zombies or forward signals, so
  without an init process `docker stop` can end in a SIGKILL, throwing away
  the graceful shutdown built in Milestone 12.

The images run as the unprivileged `node` user. Containers run as root by
default; that is a default worth changing rather than explaining.

### Startup order actually works

Every infrastructure container has a **health check**, and the services wait
for `condition: service_healthy` rather than `service_started`. Without it
compose only waits for the container to *start* — and a Postgres container is
up for several seconds before it will accept a connection, so every service
crashes on boot, restarts, and eventually works. That is not a stack that
starts; it is one that recovers, and the difference shows up as a minute of
frightening logs every time.

The application containers carry a `HEALTHCHECK` too, hitting the
`/health/live` endpoint from Milestone 12 — the probe that checks nothing but
the event loop, so a database blip cannot get a container killed.

### The seven databases create themselves

`docker/postgres-init.sh` runs on first start and creates one role and one
database per service, with `REVOKE CONNECT … FROM PUBLIC` so a service's
credentials cannot open another service's database. Database-per-service
stops being a promise about the code and becomes a fact about the deployment.

It runs **once**, on an empty data directory. Editing it later does nothing
until you `npm run docker:reset` — that is the single most common confusion
with the Postgres image.

### Host or containers?

Both work, and they are for different things.

| | `npm start` on the host | `npm run docker:up` |
| --- | --- | --- |
| Start-up | seconds | a few minutes on the first build |
| Debugging | attach a debugger, edit, reload | rebuild the image |
| Realism | eight processes sharing your machine | eight containers, real network boundaries |
| Orphaned processes | a known annoyance | gone — `docker compose down` |

Develop on the host; use compose to check it really works, to demo it, and
for anything where the network boundaries matter.

---

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to
`main`, every pull request, and on demand.

| Job | What it proves |
| --- | --- |
| `verify` | lint, unit tests and build, on a machine with nothing on it |
| `images` | all eight Docker images build (matrix, layer cache shared) |
| `smoke` | the whole compose stack starts, migrates, and answers |

Run the first one yourself, with the same command CI uses:

```bash
npm run verify
```

### What the smoke job actually checks

It builds a `.env` from `.env.example` with freshly generated passwords,
generates a signing keypair, brings the stack up, waits for every container
to report `healthy`, runs the migrations and the broker setup, and then
asserts two things:

- `GET /health/ready` → **200**, checked from inside the gateway container,
  so it means PostgreSQL, Redis and RabbitMQ are all genuinely reachable;
- `POST /api/auth/register` → **201**.

That second number covers the image building, the container starting, the
migration applying, PostgreSQL accepting credentials the init script created,
the RS256 key being readable at its mounted path, and the gateway resolving
the Auth Service by its compose hostname. One assertion, most of the
containerisation.

It also means **`.env.example` is tested**: if the repository cannot produce
a working configuration from it, the build fails — which is a much better
place to find that out than the next person to clone it.

### Audit

[`.github/workflows/audit.yml`](.github/workflows/audit.yml) runs weekly, and
on any PR that changes dependencies:

- `npm audit --omit=dev --audit-level=high` — gating on the **production**
  tree, because a vulnerability in a test runner is real and is not shipped;
- **Trivy** on the gateway image, gating on **CRITICAL only** — a base image
  routinely carries HIGH findings with no fix available, and a gate that
  cannot be satisfied is one people learn to bypass. HIGH and MEDIUM are
  still printed.

It is a separate workflow deliberately. These checks fail for reasons that
have nothing to do with the commit in front of them, and mixing them into CI
teaches people that a red build is normal.

[`.github/dependabot.yml`](.github/dependabot.yml) keeps npm packages, the
base image and the Actions themselves moving, grouped by family so
`@nestjs/common` never arrives without `@nestjs/core`.

### There is no deploy job, on purpose

Nothing is pushed to a registry and nothing touches a server. A deployment
needs a registry, an environment, credentials with real blast radius, and an
answer to "who may release" — decisions with owners, not lines of YAML.

What it would need first, in order:

1. a registry, and a decision about whether images are public;
2. digest-pinned base images (`node:24-alpine` is a moving tag);
3. secrets from a manager rather than `.env`;
4. an environment to deploy to, with approval gates;
5. **the test suite from Milestone 13**, which was skipped — CI currently
   runs unit tests and one smoke check, with nothing covering the wiring
   between services.

---

## Everyday commands

| Command                                                  | What it does                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm start`                                              | Serve all seven services, with streamed logs                                                             |
| `npm run start:gateway` / `start:auth` / `start:product` | One service (also `start:inventory`, `start:cart`, `start:order`, `start:payment`, `start:notification`) |
| `npm run stop`                                           | Kill anything left holding 3000–3006 / 9229–9235                                                         |
| `npm run db:migrate`                                     | Migrate every service's database                                                                         |
| `npm run build`                                          | Build every project into `dist/`                                                                         |
| `npm run lint`                                           | ESLint across every project                                                                              |
| `npm run verify`                                         | Lint, test and build — the same command CI runs                                                          |
| `npm test`                                               | Jest across every project                                                                                |
| `npm run format`                                         | Rewrite files with Prettier                                                                              |
| `npm run graph`                                          | Open the interactive Nx project graph                                                                    |
| `npm run demo:messaging`                                 | Watch an event travel from Product to Cart                                                               |
| `npm run docker:up`                                       | Build and start the whole stack in containers                                                            |
| `npm run docker:migrate`                                  | Run every migration against the containerised Postgres                                                   |
| `docker compose run --rm broker-setup`                     | Declare the exchanges, queues and dead-letter topology                                                   |
| `npm run docker:down` / `docker:reset`                     | Stop, keeping / deleting the data                                                                        |

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
| `CORS_ALLOWED_ORIGINS`   | gateway | _empty_       | Comma-separated browser origins. Empty means **none** |
| `AUTH_SERVICE_PORT`      | auth    | `3001`        | Internal listening port                  |
| `AUTH_DB_*`              | auth    | _required_    | Host, port, username, password, database |
| `AUTH_DB_LOGGING`        | auth    | `false`       | Log emitted SQL — off in production      |
| `AUTH_DB_SSL`            | auth    | `false`       | Must be true off-loopback                |
| `JWT_PRIVATE_KEY_PATH`   | auth    | _required_    | RS256 private key. SIGNS. Auth only      |
| `JWT_PUBLIC_KEY_PATH`    | auth, gateway | _required_ | RS256 public key. VERIFIES. Not a secret |
| `JWT_ACCESS_TTL_SECONDS` | auth    | `900`         | Access token lifetime. Short: unrevocable |
| `REFRESH_TOKEN_TTL_SECONDS` | auth  | `2592000`     | Refresh token lifetime (30d). Max 90d    |
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
- `CORS_ALLOWED_ORIGINS` defaults to empty, so no browser origin is allowed
  until one is named. `origin: true` reflects whatever origin asked, which
  is not a policy — with credentials enabled it is the absence of one.

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

1. ~~**Catalogue AND inventory write endpoints are unauthenticated.**~~
   **CLOSED in M12 pass 2.** Every catalogue and inventory write requires an
   authenticated ADMIN; reads stay public.
2. **Internal services trust `X-User-Id`.** The Cart, Order and Payment
   services do not verify tokens; they believe a header the gateway sets,
   safe only because they bind to loopback. RS256 makes the fix available —
   hand each service the public key — so this is now a choice, not a blocker.
   Related: `reserve`/`release`/`fulfil` are marked ADMIN, which is right
   while only an operator calls them and wrong once the Order Service does.
   Service identities are the proper answer.
3. ~~**Messaging has no dead-letter queue.**~~ **CLOSED in M12 pass 4** — a
   failed handler nacks without requeue and the broker parks the message in
   `<service>.parked`, replayable with `tools/replay-parked.mjs`.
   Still absent: **retry with backoff** (a two-second database blip parks a
   message that a second attempt would have handled) and **alerting** on the
   parked count — nobody is told when something parks.
4. **The dual-write problem is unsolved.** A publish can fail after its
   database commit, losing the event with only a log line.
5. **Rate limiting is per-IP only** and fails open when Redis is down. It
   raises the cost of credential stuffing; it does not stop a distributed
   attack. Per-account lockout and MFA are still absent.
6. ~~**No RBAC.**~~ **CLOSED in M12 pass 2** — `@Roles(UserRole.Admin)` and
   `RolesGuard` at the gateway, checked against the introspected profile
   rather than the token's claim. Still coarse: two roles, no per-resource
   permissions and no ownership checks.
7. **No audit logging** of authentication or catalogue mutations.
8. **No correlation IDs** — a request cannot yet be traced across services.
9. **Reservations never expire.** An abandoned cart holds stock indefinitely.
   Needs per-order reservation records with a TTL (M6/M8).
10. **Stock operations are not idempotent.** Retrying a reserve after a
    timeout double-reserves (M8).
11. **`.env` holds development secrets** that have appeared in a terminal
    transcript. Rotate before any shared environment. The RS256 keypair in
    `keys/` is generated locally and git-ignored; generate a fresh one for
    any shared environment and keep the private half in a secret manager.
12. **A specific ACCESS token cannot be killed.** Sessions became revocable
    in pass 3, but an access token already issued stays valid for up to 15
    minutes after logout or reuse detection. Needs a deny-list keyed on a
    `jti` claim.
13. **A session never ends on its own.** Each rotation extends the refresh
    token by another 30 days, so there is no absolute cap on session length.
14. **Expired refresh tokens are never deleted.** The table only grows. It
    needs a cleanup job; the index on `expires_at` is there for it.

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
