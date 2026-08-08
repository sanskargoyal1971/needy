FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Copy the root package.json and lockfile, plus workspaces
COPY package.json package-lock.json ./
COPY packages/landing/package.json packages/landing/
COPY packages/shared/package.json packages/shared/
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build shared first if needed by landing, though landing is standalone
RUN npm run build --workspace @needy/shared && npm run build --workspace @needy/landing

FROM base AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/packages/landing/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/packages/landing/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/landing/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
ENV PORT 3000
CMD ["node", "server.js"]
