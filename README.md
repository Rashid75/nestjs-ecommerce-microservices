# E-Commerce Microservices Backend

A production-oriented e-commerce backend, built incrementally as a learning
project. Each milestone introduces one architectural concern at a time and
explains why it exists before it is added.

> **Current status: Milestone 1 — Nx Workspace and Project Foundation.**
> Only the repository foundation and a single placeholder NestJS application
> exist. There is no database, authentication, messaging or caching yet.

---

## Table of contents

- [Target architecture](#target-architecture)
- [Technology stack](#technology-stack)
- [Repository layout](#repository-layout)
- [Local setup](#local-setup)
- [Everyday commands](#everyday-commands)
- [Environment variables](#environment-variables)
- [Architecture decisions](#architecture-decisions)
- [Milestone progress](#milestone-progress)
- [Troubleshooting](#troubleshooting)

---

## Target architecture

This is where the project is heading. It is **not** what exists today.

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

Each service will own its own database (`database-per-service`). No service
reads another service's tables directly; they talk over REST or RabbitMQ.

---

## Technology stack

| Concern              | Choice                                 | Introduced in                          |
| -------------------- | -------------------------------------- | -------------------------------------- |
| Monorepo tooling     | Nx                                     | Milestone 1                            |
| Framework            | NestJS 11                              | Milestone 1                            |
| Language             | TypeScript (strict)                    | Milestone 1                            |
| Linting / formatting | ESLint (flat config) + Prettier        | Milestone 1                            |
| Bundling             | webpack via `@nx/webpack`              | Milestone 1                            |
| Configuration        | `@nestjs/config` + Joi validation      | Milestone 1                            |
| Database             | PostgreSQL + Sequelize + Sequelize CLI | Milestone 2                            |
| Auth                 | JWT + Passport                         | Milestone 2                            |
| API docs             | Swagger / OpenAPI                      | Milestone 2                            |
| Cache                | Redis                                  | Milestone 4                            |
| Messaging            | RabbitMQ                               | Milestone 7                            |
| Email                | Nodemailer + MailHog                   | Milestone 10                           |
| Logging / tracing    | Pino, OpenTelemetry, SigNoz            | Milestone 11                           |
| Testing              | Jest + Supertest                       | throughout, formalised in Milestone 13 |
| Containers           | Docker + Docker Compose                | Milestone 14                           |
| CI                   | GitHub Actions                         | Milestone 15                           |

---

## Repository layout

What exists today:

```text
ecommerce/
├── apps/
│   └── api-gateway/              # placeholder NestJS app (real gateway: M2)
│       ├── src/
│       │   ├── app/
│       │   │   ├── app.controller.ts
│       │   │   ├── app.module.ts
│       │   │   └── app.service.ts
│       │   ├── config/
│       │   │   ├── configuration.ts     # typed config object
│       │   │   └── env.validation.ts    # Joi startup validation
│       │   └── main.ts                  # bootstrap
│       ├── jest.config.cts
│       ├── project.json          # Nx targets + boundary tags
│       ├── tsconfig.*.json
│       └── webpack.config.js
├── .env.example                  # documented template (committed)
├── .env                          # your local values (git-ignored)
├── .prettierrc
├── eslint.config.mjs             # flat config + module boundary rules
├── jest.config.ts / jest.preset.js
├── nx.json                       # Nx plugins, caching inputs
├── package.json
├── tsconfig.base.json            # shared compiler options + path aliases
└── README.md
```

`libs/` does not exist yet, deliberately. Shared libraries are created when a
second consumer actually appears, not in anticipation of one.

---

## Local setup

Prerequisites: Node.js 20+ (developed on 24) and npm 10+.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Then verify:

```bash
curl http://localhost:3000/api
```

Expected response:

```json
{ "message": "Hello API" }
```

---

## Everyday commands

| Command                                 | What it does                                   |
| --------------------------------------- | ---------------------------------------------- |
| `npm start`                             | Serve `api-gateway` in watch mode              |
| `npm run build`                         | Build every project into `dist/`               |
| `npm run lint`                          | ESLint across every project                    |
| `npm test`                              | Jest across every project                      |
| `npm run format`                        | Rewrite files with Prettier                    |
| `npm run format:check`                  | Fail if formatting is wrong (used by CI later) |
| `npm run graph`                         | Open the interactive Nx project graph          |
| `npx nx show projects`                  | List every project Nx knows about              |
| `npx nx show project api-gateway --web` | Inspect one project's targets                  |

Nx caches task results. A second `npm run build` with no source changes will
report that it read the output from cache and will finish almost instantly.

---

## Environment variables

Configuration is read from `.env` (and optional `.env.local` overrides), then
validated by Joi at startup. **If a variable is missing or malformed, the
process refuses to boot.** This is intentional: a service that starts with bad
configuration fails later, in production, on a request path.

| Variable            | Required | Default       | Description                                |
| ------------------- | -------- | ------------- | ------------------------------------------ |
| `NODE_ENV`          | no       | `development` | One of `development`, `test`, `production` |
| `PORT`              | no       | `3000`        | Port the API Gateway listens on            |
| `API_GLOBAL_PREFIX` | no       | `api`         | Prefix applied to all routes               |

Rules:

- `.env.example` is committed and documents every variable.
- `.env` and `.env.local` are git-ignored and must never contain committed
  secrets.
- Real secrets belong in a secret manager, never in the repository.

---

## Architecture decisions

**Monorepo (Nx) over polyrepo.** Nine services that share event contracts,
config conventions and lint rules would otherwise mean nine repositories,
nine CI pipelines and versioned internal packages. Nx keeps one repository,
one dependency tree, and an accurate project graph so only affected projects
are rebuilt and retested. The trade-off is a larger repository and the need
for explicit boundary rules — which is why we tag projects.

**Project boundary tags.** `apps/api-gateway` is tagged `type:app` and
`scope:gateway`. `eslint.config.mjs` enforces that apps may only depend on
libraries, and libraries only on other libraries. Without this, a monorepo
degrades into a distributed monolith where every service imports every other
service's internals.

**Strict TypeScript.** `tsconfig.base.json` enables `strict`, plus
`noUnusedLocals`, `noUnusedParameters` and `noImplicitOverride`.
`strictPropertyInitialization` is disabled because NestJS DTO and entity
classes are populated by decorators and the ORM rather than by constructors.

**Configuration through `ConfigService`, not `process.env`.** Direct
`process.env` access is confined to `src/config/configuration.ts`. Everything
else reads a typed object, which makes configuration testable and its shape
discoverable.

---

## Milestone progress

- [x] **1 — Nx workspace and project foundation**
- [ ] 2 — API Gateway + Auth foundation (PostgreSQL, Sequelize, JWT, Swagger)
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

---

## Troubleshooting

**`Config validation error: "PORT" must be a valid port`** — your `.env` has a
bad value. This error is the validation working as designed.

**Port 3000 already in use** — change `PORT` in `.env`, or stop the other
process.

**Nx returns a stale result** — clear the local cache with `npx nx reset`.

**Lint reports a module boundary violation** — a project imported something its
tags do not allow. Fix the dependency direction rather than loosening the rule.
