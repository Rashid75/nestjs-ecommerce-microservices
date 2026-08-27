# Project Plan & Progress

The 15-milestone plan for this backend, with what is actually built as of
**2026-08-27**.

This file is the source of truth for progress. It is updated at the end of
every milestone — completed work moves from _Planned_ to _Delivered_, and
anything deliberately deferred is recorded with the **trigger** that should
bring it back, rather than a vague "later".

|                         |                                             |
| ----------------------- | ------------------------------------------- |
| **Milestones complete** | 3 of 15                                     |
| **Services running**    | API Gateway, Auth, Product                  |
| **Databases**           | `ecommerce_auth_db`, `ecommerce_product_db` |
| **Next milestone**      | 4 — Redis and caching                       |

```text
M1 ██ M2 ██ M3 ██ M4 ░░ M5 ░░ M6 ░░ M7 ░░ M8 ░░
M9 ░░ M10 ░░ M11 ░░ M12 ░░ M13 ░░ M14 ░░ M15 ░░
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

---

## Current architecture

```text
   Client
     ▼
┌──────────────────────┐
│  API Gateway :3000   │  public · /api · DTO validation · Swagger
└──────────┬───────────┘
           │ HTTP (axios, 5s timeout, honest failure mapping)
     ┌─────┴──────┐
     ▼            ▼
┌──────────┐  ┌─────────────┐
│Auth :3001│  │Product :3002│   both bound to 127.0.0.1
└────┬─────┘  └──────┬──────┘
     ▼               ▼
 ecommerce_      ecommerce_
  auth_db        product_db
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
- Swagger at `/docs`

**API Gateway** (`:3000`, public)

- Forwards `/api/auth/*` over HTTP with a 5s timeout
- Honest failure mapping: pass-through status · 503 · 504 · 502
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`)
- Swagger at `/docs`

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
- Swagger at `/docs`

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

## ⬜ Milestone 4 — Redis and Caching

**Next up.** Product caching with cache-aside, TTL, explicit invalidation on
write, and rate limiting where it actually matters (the login endpoint, which
is currently the most significant open security gap).

Learn: cache-aside, hit/miss, TTL, invalidation, cache stampede,
write-through vs write-behind, distributed locks.

Rule: do not cache everything. Cache what is read far more often than written.

---

## ⬜ Milestone 5 — Inventory Service

Concurrency-safe stock: increase, decrease, reserve, release. Transactions,
isolation levels, row locking (`SELECT ... FOR UPDATE`), and the overselling
race condition demonstrated before it is fixed.

---

## ⬜ Milestone 6 — Cart Service

Cart lifecycle, and a genuine evaluation of PostgreSQL vs Redis for cart
storage rather than reaching for Redis because it is in the stack.

---

## ⬜ Milestone 7 — RabbitMQ Messaging

Exchanges, queues, bindings, routing keys, acknowledgements, prefetch, retry
and dead-letter queues. Events: `UserRegistered`, `OrderCreated`,
`OrderConfirmed`, `PaymentSucceeded`, `InventoryReserved`, and the rest.

---

## ⬜ Milestone 8 — Order Service and Distributed Workflow

The central workflow: validate cart → reserve inventory → process payment →
confirm order → publish. Saga pattern, compensation, eventual consistency,
idempotency.

---

## ⬜ Milestone 9 — Payment Service

A realistic mock provider: success, decline, timeout, duplicate request,
provider unavailable. Idempotency keys, retryable vs non-retryable errors.

---

## ⬜ Milestone 10 — Notification Service

RabbitMQ consumers, Nodemailer, MailHog, templates. Business services publish
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

## Deferred, with triggers

Things consciously left out, and what should bring each one back. This list
exists so that "not yet" never quietly becomes "never".

| Item                               | Trigger                                                                                                                      | Milestone      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Auth on catalogue writes**       | Before anything is exposed beyond localhost. Currently **anyone reaching the gateway can create, edit and delete products.** | M4 candidate   |
| **RS256 signing keys**             | The moment a second service must verify tokens. An HS256 key that verifies can also mint.                                    | with the above |
| **RBAC role guards**               | Same trigger — `role` is already a claim and a column.                                                                       | with the above |
| **Login rate limiting**            | Before any internet exposure. Brute force is currently bounded only by bcrypt's cost.                                        | M4             |
| **Refresh tokens + logout**        | When 15-minute sessions become unacceptable UX.                                                                              | M12            |
| **Global exception filter**        | When the standard error envelope (`code`, `traceId`, `path`) is needed — i.e. alongside correlation IDs.                     | M11–12         |
| **Correlation IDs**                | With the first multi-hop debugging problem.                                                                                  | M11            |
| **Helmet, CORS policy**            | Before a browser client exists.                                                                                              | M12            |
| **Health checks**                  | Before containers need liveness/readiness probes.                                                                            | M12/M14        |
| **`pg_trgm` GIN index for search** | Measurable latency on `GET /products?search=` — not a hunch. `ILIKE '%x%'` is a sequential scan today.                       | when measured  |
| **Elasticsearch**                  | Facets, relevance ranking or typo tolerance. Not before.                                                                     | post-M15       |
| **Category nesting**               | An actual requirement for subtrees. The migration is additive.                                                               | on demand      |
| **Category pagination**            | Hundreds of categories, or nesting.                                                                                          | on demand      |
| **Integer minor units for money**  | Revisit when the Payment Service does real arithmetic.                                                                       | M9             |
| **Secret manager**                 | Before any shared or hosted environment. `.env` is a local-development convenience.                                          | M14            |

---

## Known gaps, stated plainly

1. **Catalogue write endpoints are unauthenticated.** Deliberate — closing it
   properly requires the RS256 decision above — but it means this stack must
   not be exposed beyond localhost.
2. **No rate limiting anywhere.** `POST /api/auth/login` is protected only by
   bcrypt's cost.
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
| Product   | `ecommerce_product_db`   | `ecommerce_product_service`   | ⏳ awaiting creation |
| Inventory | `ecommerce_inventory_db` | `ecommerce_inventory_service` | M5                   |
| Cart      | `ecommerce_cart_db`      | `ecommerce_cart_service`      | M6                   |
| Order     | `ecommerce_order_db`     | `ecommerce_order_service`     | M8                   |
| Payment   | `ecommerce_payment_db`   | `ecommerce_payment_service`   | M9                   |

## Port inventory

| Service          | HTTP | Node inspector |
| ---------------- | ---- | -------------- |
| API Gateway      | 3000 | 9229           |
| Auth             | 3001 | 9230           |
| Product          | 3002 | 9231           |
| _(next service)_ | 3003 | 9232           |

Each service needs its own inspector port. `@nx/js:node` defaults every one of
them to 9229, and the collision stops the second service booting with an error
that reads like a warning.
