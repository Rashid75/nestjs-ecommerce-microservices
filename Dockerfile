# syntax=docker/dockerfile:1
#
# ONE Dockerfile for all eight services.
#
# The alternative is eight near-identical files that drift: one gets a
# security update, one keeps running as root, one forgets `--omit=dev`. The
# only thing that actually differs between these images is which entry point
# runs, and that is exactly what a build argument is for:
#
#   docker build --build-arg APP=auth -t ecommerce/auth .
#
# ─── WHY MULTI-STAGE ───────────────────────────────────────────────────────
#
# A single-stage image would ship the whole toolchain: the Nx workspace, the
# TypeScript compiler, every devDependency, the source, the git history in
# .git if you forgot .dockerignore. That is roughly 1.5GB of image, and every
# megabyte of it is attack surface that has to be patched forever.
#
# Here the build happens in one stage and is thrown away; the final image
# gets the compiled bundle, its production dependencies and nothing else. A
# compiler that is not in the image cannot be used by someone who gets in.

ARG NODE_VERSION=24-alpine

# ──────────────────────────────────────────────────────────── build stage ──
FROM node:${NODE_VERSION} AS builder

# bcrypt is a NATIVE module: it compiles against the C++ runtime at install
# time. These packages are what node-gyp needs, and they are the reason the
# builder and the runtime must share a libc — a binary built against musl
# (alpine) will not load on glibc (debian). Both stages are alpine on
# purpose; mixing them produces "invalid ELF header" at startup, which reads
# like a corrupt file rather than a base-image mismatch.
RUN apk add --no-cache python3 make g++

WORKDIR /workspace

# Dependencies first, and ONLY the manifests. Docker caches each layer by its
# inputs, so as long as package.json and the lockfile are unchanged this
# entire install is reused — which turns a code-only rebuild from three
# minutes into twenty seconds. Copying the source first would invalidate it
# on every edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG APP
RUN test -n "$APP" || (echo "build arg APP is required" && exit 1)

# `--skip-nx-cache`: the Nx cache lives outside the image and a stale hit
# would silently ship yesterday's bundle.
RUN npx nx build "$APP" --skip-nx-cache

# The build emits dist/apps/<app>/package.json listing only what that service
# actually imports (webpack's `generatePackageJson`), so this install is a
# fraction of the workspace's dependencies — the Auth Service does not carry
# ioredis, and the Cart Service does not carry bcrypt.
#
# `npm ci --omit=dev` because a production image has no use for a test
# runner, and every package in it is a package someone has to patch.
WORKDIR /workspace/dist/apps/${APP}
RUN npm ci --omit=dev

# ────────────────────────────────────────────────────────── runtime stage ──
FROM node:${NODE_VERSION} AS runtime

# `tini` as PID 1. Node does not reap zombie children and does not forward
# signals to them, so without an init process a `docker stop` can leave the
# container to be SIGKILLed after the grace period — which throws away the
# graceful shutdown built in Milestone 12. It is 30KB and it makes
# `enableShutdownHooks()` actually mean something.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# NON-ROOT. The node image ships an unprivileged `node` user; using it means
# a process that is compromised cannot write to the image, install packages
# or bind a privileged port. Containers run as root by default, which is a
# default worth changing rather than explaining.
WORKDIR /app
RUN chown node:node /app
USER node

ARG APP
COPY --from=builder --chown=node:node /workspace/dist/apps/${APP} ./

# For the log line and for OpenTelemetry's service.name.
ENV APP_NAME=${APP}

# Every service answers this since Milestone 12 — a probe that checks nothing
# but the event loop, so a database blip does not get the container killed.
# Docker's own HEALTHCHECK is coarser than an orchestrator's, but it is what
# `depends_on: condition: service_healthy` reads in compose.
#
# The port differs per service, so it comes from the environment; the
# fallback is the gateway's.
ENV PORT=3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
