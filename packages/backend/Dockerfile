# ── Needy backend ─────────────────────────────────────────────────────────────
# Built from the REPO ROOT, not from this directory:
#   docker build -f packages/backend/Dockerfile .
# The workspace protocol means @needy/shared resolves through the root node_modules, so the
# build context has to include the whole monorepo or npm cannot link it.

FROM node:22-alpine AS build
WORKDIR /repo

# Copy manifests first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
# Ignore scripts during install: nothing here needs a postinstall, and running arbitrary
# dependency scripts in an image build is avoidable attack surface.
RUN npm ci --ignore-scripts

COPY packages/shared packages/shared
COPY packages/backend packages/backend

# shared emits the .d.ts files backend typechecks against, so it must build first.
RUN npm run build --workspace @needy/shared \
 && npm run build --workspace @needy/backend

# Re-resolve with dev dependencies dropped, so the runtime layer carries only what it runs.
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /repo/packages/backend/node_modules

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Alpine's node image ships an unprivileged `node` user; use it rather than running as root.
COPY --from=build --chown=node:node /repo/node_modules node_modules
COPY --from=build --chown=node:node /repo/package.json package.json
COPY --from=build --chown=node:node /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/backend/package.json packages/backend/package.json
COPY --from=build --chown=node:node /repo/packages/backend/dist packages/backend/dist
COPY --from=build --chown=node:node /repo/packages/backend/node_modules packages/backend/node_modules

USER node
EXPOSE 4000

# GET /health really probes Redis (PING) and Postgres (SELECT 1) and returns 503 when either
# is unreachable, so this reflects "can serve traffic", not merely "process is alive" — a
# backend that cannot reach Redis cannot match anyone and should be pulled from rotation.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node directly, no npm wrapper: npm swallows signals, and the graceful shutdown path
# (drain sockets, close Redis, close the pool) depends on SIGTERM reaching the process.
CMD ["node", "packages/backend/dist/index.js"]
