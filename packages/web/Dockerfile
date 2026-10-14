FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Only the manifests, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
# Ignore scripts during install: nothing here needs a postinstall, and running arbitrary
# dependency scripts in an image build is avoidable attack surface.
RUN npm ci --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not read from the
# environment at runtime. They must therefore arrive as build args — passing them to the
# runner stage would silently leave the compiled bundle pointing at the default origin.
# No default: a bundle silently built against localhost works on the developer's machine and
# nowhere else, because every visitor's browser then calls their own computer.
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL build arg is required" >&2 && exit 1)
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SUPPORT_PHONE=
ENV NEXT_PUBLIC_SUPPORT_PHONE=$NEXT_PUBLIC_SUPPORT_PHONE
ENV NEXT_TELEMETRY_DISABLED=1

# shared must be compiled first: web imports @needy/shared for the task/authz/eligibility
# contracts, and its dist/ is what the type resolution and the runtime import both point at.
RUN npm run build --workspace @needy/shared && npm run build --workspace @needy/web

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Beside the standalone server, which is where it looks: the server runs from
# packages/web/, so a copy at the image root is never served and every image 404s.
COPY --from=builder /app/packages/web/public ./packages/web/public
# `output: 'standalone'` emits a self-contained server bundle with only the node_modules it
# actually reached, so the whole workspace node_modules tree is deliberately NOT copied.
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/static ./packages/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "packages/web/server.js"]
