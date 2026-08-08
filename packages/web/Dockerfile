FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Only the manifests, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not read from the
# environment at runtime. They must therefore arrive as build args — passing them to the
# runner stage would silently leave the compiled bundle pointing at the default origin.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# shared must be compiled first: web imports @needy/shared for the task/authz/eligibility
# contracts, and its dist/ is what the type resolution and the runtime import both point at.
RUN npm run build --workspace @needy/shared && npm run build --workspace @needy/web

FROM base AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/packages/web/public ./public
# `output: 'standalone'` emits a self-contained server bundle with only the node_modules it
# actually reached, so the whole workspace node_modules tree is deliberately NOT copied.
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/static ./packages/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT 3000
CMD ["node", "packages/web/server.js"]
