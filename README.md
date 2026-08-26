# E-Commerce Microservices Backend

A production-oriented e-commerce backend, built incrementally as a learning
project. Each milestone introduces one architectural concern at a time and
explains why it exists before it is added.

> **Current status: Milestone 2 — API Gateway + Auth Foundation.**
> Two services, one PostgreSQL database, registration, login, JWT
> authentication and Swagger. No products, cart, orders, Redis or RabbitMQ yet.

---

## Table of contents

- [Target architecture](#target-architecture)
- [What exists today](#what-exists-today)
- [Technology stack](#technology-stack)
- [Repository layout](#repository-layout)
- [Local setup](#local-setup)
- [Database and migrations](#database-and-migrations)
- [API](#api)
- [Postman](#postman)
- [Everyday commands](#everyday-commands)
- [Environment variables](#environment-variables)
- [Architecture decisions](#architecture-decisions)
- [Milestone progress](#milestone-progress)
- [Troubleshooting](#troubleshooting)

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

## What exists today

```text
   Client
     │  POST /api/auth/register
     │  POST /api/auth/login
     │  GET  /api/auth/me           Authorization: Bearer <jwt>
     ▼
┌──────────────────────┐
│  API Gateway :3000   │  public · validates DTOs · Swagger · routes
└──────────┬───────────┘
           │ HTTP (axios, 5s timeout)
           ▼
┌──────────────────────┐
│  Auth Service :3001  │  internal · bound to 127.0.0.1 · issues JWTs
└──────────┬───────────┘
           │ Sequelize
           ▼
┌──────────────────────┐
│  PostgreSQL auth_db  │  owner: auth_service · schema from migrations only
└──────────────────────┘
```

Inside the Auth Service the request path is fixed:

```text
AuthController → AuthService → UsersRepository → User model → PostgreSQL
```

Sequelize appears in exactly one layer. A controller never queries.

---

## Technology stack

| Concern              | Choice                                           | Introduced in                          |
| -------------------- | ------------------------------------------------ | -------------------------------------- |
| Monorepo tooling     | Nx                                               | Milestone 1                            |
| Framework            | NestJS 11                                        | Milestone 1                            |
| Language             | TypeScript (strict)                              | Milestone 1                            |
| Linting / formatting | ESLint (flat config) + Prettier                  | Milestone 1                            |
| Bundling             | webpack via `@nx/webpack`                        | Milestone 1                            |
| Configuration        | `@nestjs/config` + Joi validation                | Milestone 1                            |
| Database             | PostgreSQL 18                                    | Milestone 2                            |
| ORM / migrations     | Sequelize + sequelize-typescript + sequelize-cli | Milestone 2                            |
| Password hashing     | bcrypt (cost 12)                                 | Milestone 2                            |
| Tokens               | JWT (HS256) via `@nestjs/jwt`                    | Milestone 2                            |
| Authentication       | Passport + `passport-jwt` strategy + guard       | Milestone 2                            |
| Request validation   | class-validator / class-transformer              | Milestone 2                            |
| Service-to-service   | HTTP via `@nestjs/axios`                         | Milestone 2                            |
| API docs             | Swagger / OpenAPI                                | Milestone 2                            |
| Cache                | Redis                                            | Milestone 4                            |
| Messaging            | RabbitMQ                                         | Milestone 7                            |
| Email                | Nodemailer + MailHog                             | Milestone 10                           |
| Logging / tracing    | Pino, OpenTelemetry, SigNoz                      | Milestone 11                           |
| Testing              | Jest + Supertest                                 | throughout, formalised in Milestone 13 |
| Containers           | Docker + Docker Compose                          | Milestone 14                           |
| CI                   | GitHub Actions                                   | Milestone 15                           |

---

## Repository layout

```text
ecommerce/
├── apps/
│   ├── api-gateway/                    PUBLIC · port 3000
│   │   └── src/
│   │       ├── app/app.module.ts       config + feature modules
│   │       ├── auth/
│   │       │   ├── auth.controller.ts  public routes, validated DTOs
│   │       │   ├── auth-proxy.service.ts  forwards to Auth, maps failures
│   │       │   └── auth.module.ts      HttpModule baseURL + timeout
│   │       ├── config/env.validation.ts
│   │       └── main.ts                 ValidationPipe + Swagger
│   │
│   └── auth/                           INTERNAL · port 3001 · 127.0.0.1 only
│       ├── .sequelizerc                absolute paths for sequelize-cli
│       └── src/
│           ├── app/app.module.ts
│           ├── auth/
│           │   ├── auth.controller.ts
│           │   ├── auth.service.ts     hashing, login, token issuance
│           │   ├── auth.module.ts      JwtModule.registerAsync
│           │   ├── jwt.strategy.ts     Passport strategy
│           │   ├── jwt-auth.guard.ts
│           │   ├── current-user.decorator.ts
│           │   └── auth.service.spec.ts
│           ├── users/
│           │   ├── user.model.ts       sequelize-typescript model
│           │   ├── users.repository.ts ONLY place that touches Sequelize
│           │   └── users.module.ts
│           ├── database/
│           │   ├── database.module.ts  connection, synchronize: false
│           │   ├── sequelize-cli.config.js
│           │   ├── migrations/
│           │   │   └── 20260825120000-create-users-table.js
│           │   └── seeders/
│           ├── config/env.validation.ts
│           └── main.ts
│
├── libs/
│   └── contracts/                      @ecommerce/contracts · type:lib
│       └── src/lib/auth/               DTOs shared by gateway and auth
│
├── postman/                            collection + local environment
├── .env.example                        committed template, no real secrets
├── .env                                local values, git-ignored
├── eslint.config.mjs                   module boundary rules
├── nx.json · tsconfig.base.json · package.json
└── README.md
```

---

## Local setup

Prerequisites: Node.js 20+, npm 10+, PostgreSQL 13+ running locally.

**1. Install dependencies**

```bash
npm install
```

**2. Create the environment file**

```bash
cp .env.example .env
```

Fill in `AUTH_DB_PASSWORD` and generate a signing key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**3. Create the database and role** — see the next section.

**4. Run migrations**

```bash
npm run auth:migrate
```

**5. Start both services**

```bash
npm start
```

---

## Database and migrations

The Auth Service owns `auth_db` and connects as the `auth_service` role. That
role has no rights over any other service's database — the same separation
Docker or a managed Postgres would give you, done with roles instead.

Create the role and database once, from `psql` as a superuser:

```sql
CREATE ROLE auth_service WITH LOGIN PASSWORD 'your-password-from-dotenv';
CREATE DATABASE auth_db OWNER auth_service;
```

**Schema changes only ever happen through migrations.** `synchronize` is
hardcoded to `false` in `database.module.ts` with no environment toggle, so
Sequelize is never permitted to issue DDL. The schema in any environment is
exactly the sum of the migration files in git.

| Command                                                   | What it does                        |
| --------------------------------------------------------- | ----------------------------------- |
| `npm run auth:migrate`                                    | Apply every pending migration       |
| `npm run auth:migrate:status`                             | Show which migrations have run      |
| `npm run auth:migrate:undo`                               | Roll back the most recent migration |
| `npm run auth:migration:generate -- --name add-something` | Scaffold a new migration            |

Applied migrations are recorded in the `SequelizeMeta` table. Every migration
in this project wraps its statements in a single transaction, because
PostgreSQL supports transactional DDL and sequelize-cli does not add one for
you — without it a failure halfway through leaves a half-applied schema that
`SequelizeMeta` does not know about.

Models and migrations are **separate concerns**, kept in sync by hand. The
migration is the authoritative history; the model is one process's view of it.
If they disagree, the migration is right.

---

## API

Swagger UI:

- Gateway (public): <http://localhost:3000/docs>
- Auth Service (internal): <http://127.0.0.1:3001/docs>

| Method | Path                 | Auth   | Returns                   |
| ------ | -------------------- | ------ | ------------------------- |
| `POST` | `/api/auth/register` | —      | 201 · user + access token |
| `POST` | `/api/auth/login`    | —      | 200 · user + access token |
| `GET`  | `/api/auth/me`       | Bearer | 200 · user profile        |

Status codes you should expect:

| Code | When                                                                 |
| ---- | -------------------------------------------------------------------- |
| 400  | Body failed validation, or contained an unknown property             |
| 401  | Missing, expired, tampered or unknown-subject token; bad credentials |
| 409  | Email already registered                                             |
| 503  | Auth Service is not running                                          |
| 504  | Auth Service did not answer within `HTTP_CLIENT_TIMEOUT_MS`          |

Example:

```bash
curl -s -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{"email":"ada@example.com","password":"correct-horse-Battery9","firstName":"Ada","lastName":"Lovelace"}'
```

```bash
curl -s http://localhost:3000/api/auth/me -H "Authorization: Bearer PASTE_TOKEN_HERE"
```

---

## Postman

Two files in [`postman/`](postman), both committed:

| File                                       | What it is                                 |
| ------------------------------------------ | ------------------------------------------ |
| `ecommerce.postman_collection.json`        | Requests, assertions and per-request notes |
| `ecommerce.local.postman_environment.json` | URLs, ports and test credentials           |

**Import both**: Postman → _Import_ → drag both files in. Then select
**`ecommerce · local`** in the environment picker (top right) — a collection-level
pre-request script fails loudly with a clear message if you forget.

The collection is kept in step with the API as milestones land. It is
organised so that the failures are as instructive as the successes:

| Folder                      | Contents                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1 · Happy path`            | Register → Login → Me. Chains state, re-runnable.                                                                                                           |
| `2 · Validation & security` | Seven requests that are _supposed_ to fail: malformed body, mass assignment, duplicate email, wrong password, unknown email, missing token, tampered token. |
| `3 · Auth Service directly` | The same calls on `:3001`, bypassing the gateway.                                                                                                           |
| `4 · Downstream failure`    | Requires the Auth Service to be stopped on purpose.                                                                                                         |

Every request carries assertions, so **Run collection** doubles as a smoke
test. Folder 1's register step generates a unique `ada+<timestamp>@example.com`
each run, so it never trips the unique index.

Variables that hold a credential (`password`, `accessToken`) are typed
`secret`, so Postman masks them in the UI. The environment file contains **no
production data and no signing key** — `JWT_ACCESS_SECRET` lives only in
`.env`, which is git-ignored.

---

## Everyday commands

| Command                 | What it does                          |
| ----------------------- | ------------------------------------- |
| `npm start`             | Serve gateway **and** auth together   |
| `npm run start:gateway` | Serve the gateway only                |
| `npm run start:auth`    | Serve the auth service only           |
| `npm run build`         | Build every project into `dist/`      |
| `npm run lint`          | ESLint across every project           |
| `npm test`              | Jest across every project             |
| `npm run format`        | Rewrite files with Prettier           |
| `npm run graph`         | Open the interactive Nx project graph |
| `npx nx show projects`  | List every project Nx knows about     |

---

## Environment variables

Each service validates **its own** variables with Joi at startup and refuses to
boot if any are missing or malformed. Database variables are prefixed per
service (`AUTH_DB_*`) because every service owns its own database and an
unprefixed `DB_HOST` would collide as soon as the second one appears.

| Variable                 | Service | Default       | Description                             |
| ------------------------ | ------- | ------------- | --------------------------------------- |
| `NODE_ENV`               | both    | `development` | `development` \| `test` \| `production` |
| `API_GATEWAY_PORT`       | gateway | `3000`        | Public listening port                   |
| `API_GLOBAL_PREFIX`      | gateway | `api`         | Prefix on all gateway routes            |
| `AUTH_SERVICE_URL`       | gateway | _required_    | Where to forward auth calls             |
| `HTTP_CLIENT_TIMEOUT_MS` | gateway | `5000`        | Deadline for outbound calls             |
| `AUTH_SERVICE_PORT`      | auth    | `3001`        | Internal listening port                 |
| `AUTH_DB_HOST`           | auth    | _required_    | PostgreSQL host                         |
| `AUTH_DB_PORT`           | auth    | _required_    | PostgreSQL port                         |
| `AUTH_DB_USERNAME`       | auth    | _required_    | Role that owns `auth_db`                |
| `AUTH_DB_PASSWORD`       | auth    | _required_    | Role password                           |
| `AUTH_DB_DATABASE`       | auth    | _required_    | Database name                           |
| `AUTH_DB_LOGGING`        | auth    | `false`       | Log emitted SQL — off in production     |
| `AUTH_DB_SSL`            | auth    | `false`       | Must be true off-loopback               |
| `JWT_ACCESS_SECRET`      | auth    | _required_    | HS256 key, min 32 characters            |
| `JWT_ACCESS_TTL_SECONDS` | auth    | `900`         | Access token lifetime                   |
| `BCRYPT_COST`            | auth    | `12`          | bcrypt work factor (10–15)              |

Rules:

- `.env.example` is committed and documents every variable. It contains no
  real values.
- `.env` and `.env.local` are git-ignored.
- Bind parameter logging is hardcoded off, so hashes and personal data never
  reach the application log.
- Real secrets belong in a secret manager. A `.env` file is a local-development
  convenience, not a production mechanism.

---

## Architecture decisions

**Monorepo (Nx) over polyrepo.** Nine services sharing contracts, config
conventions and lint rules would otherwise mean nine repositories and nine CI
pipelines. Nx keeps one repository and an accurate project graph, so only
affected projects rebuild. The cost is that boundaries must be enforced with
tooling rather than by physics.

**Project boundary tags.** Apps are tagged `type:app`, libraries `type:lib`.
`eslint.config.mjs` enforces that apps may only depend on libraries and that
nothing may depend on an app. An attempt to import `apps/auth` from
`apps/api-gateway` fails lint.

**`libs/contracts` exists; shared models never will.** The gateway and the auth
service exchange the same request and response bodies, so those DTOs are a
genuine shared concern and live in one place. The `User` Sequelize model is
the opposite — it is the Auth Service's private persistence detail, and sharing
it is how a microservice repository becomes a distributed monolith.

**API Gateway as a NestJS app, not nginx.** A reverse proxy forwards bytes
quickly and understands nothing about the API. The gateway validates bodies,
maps downstream failures to honest status codes and will later aggregate
responses, apply rate limiting and attach correlation IDs. In production the
two stack: a load balancer terminates TLS in front of this.

**HTTP between services, not RabbitMQ.** "Log me in" is genuinely synchronous —
the caller cannot proceed without an answer. Messaging arrives when there is
work that truly does not need an answer now (Milestone 7).

**JWT with a 15-minute lifetime, and a database lookup per request.** A signed
token cannot be revoked before it expires, so the lifetime is the blast radius
of a stolen one. `JwtStrategy.validate()` re-reads the user on every request so
that disabling an account takes effect immediately, at the cost of one
primary-key SELECT — precisely the kind of hot, rarely-changing read Redis will
absorb in Milestone 4.

**HS256 today, RS256 when a second verifier appears.** One shared secret is
correct while a single service both signs and verifies. The moment another
service must verify tokens itself, it would need the signing key — and a key
that verifies can also mint. That is the trigger to switch to asymmetric keys.

**Uniqueness is enforced by the database, not by a lookup.** `UsersRepository`
does not SELECT before INSERT. Two concurrent registrations would both pass
such a check and both insert; only the unique index makes the second one fail.
The repository catches the constraint violation and translates it.

**`synchronize: false`, hardcoded.** No environment toggle. Sequelize is never
allowed to emit DDL, so the migration history cannot become a lie.

**`useDefineForClassFields: false`.** Required for decorator-based ORMs. With
ES2022 class-field semantics, a declared field is defined on the instance and
shadows the accessor sequelize-typescript installs, so every property silently
reads `undefined`.

---

## Milestone progress

- [x] **1 — Nx workspace and project foundation**
- [x] **2 — API Gateway + Auth foundation** (PostgreSQL, Sequelize, JWT, Swagger)
- [ ] 3 — Product Service (CRUD, pagination, filtering, sorting)
- [ ] 4 — Redis and caching
- [ ] 5 — Inventory Service (transactions, locking, concurrency)
- [ ] 6 — Cart Service
- [ ] 7 — RabbitMQ messaging
- [ ] 8 — Order Service and distributed workflow (Saga)
- [ ] 9 — Payment Service
- [ ] 10 — Notification Service
- [ ] 11 — Observability (Pino, OpenTelemetry, SigNoz)
- [ ] 12 — Production hardening
- [ ] 13 — Testing
- [ ] 14 — Docker and local infrastructure
- [ ] 15 — CI/CD

Deferred deliberately, with a trigger rather than a vague "later": refresh
tokens and logout, RBAC role guards, a global exception filter with the
project's standard error envelope, correlation IDs, rate limiting, Helmet and
CORS, and health checks.

---

## Troubleshooting

**`Config validation error: ...` on startup** — a variable in `.env` is missing
or malformed. The message names the key. This is the validation working.

**`503 Auth service is unavailable`** — the gateway is up but the Auth Service
is not. Start it with `npm run start:auth`, or use `npm start` for both.

**`SequelizeConnectionError: password authentication failed`** — `AUTH_DB_*` in
`.env` does not match the role you created in PostgreSQL.

**`relation "users" does not exist`** — migrations have not been applied. Run
`npm run auth:migrate`.

**`Unknown authentication strategy "jwt"`** — `JwtStrategy` is missing from a
module's `providers`. Instantiation is what registers it with Passport.

**Every model property reads `undefined`** — `useDefineForClassFields` is true
somewhere. It must be false for sequelize-typescript.

**`Projects cannot be imported by a relative or absolute path`** — a project
imported across a boundary. Fix the dependency direction; do not relax the rule.

**`Starting inspector on localhost:9229 failed: address already in use`** — two
services tried to attach a Node debugger to the same port, and the second one
never boots. Each serve target pins its own inspector port in `project.json`
(gateway 9229, auth 9230); a new service needs the next free one.

**Postman: `Missing environment variable(s)`** — the `ecommerce · local`
environment is not selected in the top-right picker.

**Nx returns a stale result** — clear the local cache with `npx nx reset`.
