# ── Needy frontend ────────────────────────────────────────────────────────────
# Built from the REPO ROOT: docker build -f packages/frontend/Dockerfile .
#
# Vite inlines VITE_* variables at BUILD time, so the API origin is a build argument, not a
# runtime environment variable. An image built for staging cannot be re-pointed at production
# by changing an env var — that is a property of the bundler, worth stating plainly so nobody
# ships a broken deploy expecting otherwise.

FROM node:22-alpine AS build
WORKDIR /repo

ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --ignore-scripts

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

RUN npm run build --workspace @needy/shared \
 && npm run build --workspace @needy/frontend

# ── Serve ─────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
