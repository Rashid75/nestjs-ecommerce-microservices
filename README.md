# E-Commerce Microservices Backend

A production-oriented e-commerce backend, built incrementally as a learning
project. Each milestone introduces one architectural concern at a time and
explains why it exists before it is added.

> **Current status: Milestone 3 — Product Service.**
> Three services, two PostgreSQL databases, JWT authentication, and a full
> catalogue API with pagination, filtering and sorting. No Redis, cart,
> orders or RabbitMQ yet.

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
┌────────────────┐  ┌──────────────────┐
│  Auth  :3001   │  │  Product  :3002  │   both bound to 127.0.0.1
└───────┬────────┘  └────────┬─────────┘
        │ Sequelize          │ Sequelize
        ▼                    ▼
┌──────────────────┐  ┌──────────────────────┐
│ ecommerce_auth_db│  │ ecommerce_product_db │  schema from migrations only
└──────────────────┘  └──────────────────────┘
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
│   └── product/                      INTERNAL · 3002 · inspector 9231
│       ├── .sequelizerc
│       └── src/
│           ├── products/             model, repository, service, controller
│           ├── categories/           model, repository, service, controller
│           ├── common/domain-errors.ts
│           ├── database/             connection + migrations
│           ├── config/
│           └── main.ts
│
├── libs/
│   └── contracts/                    @ecommerce/contracts · type:lib
│       └── src/lib/
│           ├── auth/                 register, login, tokens, roles
│           ├── catalog/              product, category, query DTOs
│           └── common/               pagination envelope
│
├── docs/PROJECT-PLAN.md              milestones, progress, deferred items
├── postman/                          collection + local environment
├── tools/free-ports.mjs              kills orphaned dev servers
├── .env.example                      committed template, no real secrets
├── .env                              local values, git-ignored
├── eslint.config.mjs                 module boundary rules
└── nx.json · tsconfig.base.json · package.json
```

---

## Local setup

Prerequisites: Node.js 20+, npm 10+, PostgreSQL 13+ running locally.

```bash
npm install
```

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

| Service          | Database                 | Owning role                   | Status |
| ---------------- | ------------------------ | ----------------------------- | ------ |
| Auth             | `ecommerce_auth_db`      | `ecommerce_auth_service`      | ✅     |
| Product          | `ecommerce_product_db`   | `ecommerce_product_service`   | ✅     |
| Inventory _(M5)_ | `ecommerce_inventory_db` | `ecommerce_inventory_service` | —      |
| Cart _(M6)_      | `ecommerce_cart_db`      | `ecommerce_cart_service`      | —      |
| Order _(M8)_     | `ecommerce_order_db`     | `ecommerce_order_service`     | —      |
| Payment _(M9)_   | `ecommerce_payment_db`   | `ecommerce_payment_service`   | —      |

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

**`synchronize: false`, hardcoded.** No environment toggle. Sequelize may
never emit DDL, so the migration history cannot become a lie.

**`useDefineForClassFields: false`.** Required for decorator-based ORMs. With
ES2022 class-field semantics, a declared field shadows the accessor
sequelize-typescript installs and every property silently reads `undefined`.

---

## Known gaps

Stated plainly, tracked with triggers in
[docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md):

1. **Catalogue write endpoints are unauthenticated.** Anyone who can reach the
   gateway can create, edit and delete products. Deliberate — closing it needs
   the RS256 decision — but this stack **must not be exposed beyond
   localhost**.
2. **No rate limiting.** `POST /api/auth/login` is bounded only by bcrypt's
   cost.
3. **No RBAC**, though `role` is already a claim and a column.
4. **No audit logging** of authentication or catalogue mutations.
5. **No correlation IDs** — a request cannot yet be traced across services.
6. **`.env` holds development secrets** that have appeared in a terminal
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

**Nx returns a stale result** — clear the local cache with `npx nx reset`.
