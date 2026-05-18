# Stage 1: Build frontend
FROM --platform=$BUILDPLATFORM node:24-alpine AS fe-builder
# Shared sources sit next to the package (../shared/ from the package root)
# so the prebuild script — `node ../shared/copy-into.mjs` — resolves them.
COPY shared/ /build/shared/
WORKDIR /build/fe
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Build signaling server
FROM --platform=$BUILDPLATFORM node:24-alpine AS be-builder
COPY shared/ /build/shared/
WORKDIR /build/be
COPY signaling/package*.json ./
RUN npm ci
COPY signaling/ .
RUN npm run build

# Stage 3: Final image
FROM node:24-alpine
WORKDIR /app
ENV APP_ROOT=/app
# `wget` is part of busybox in alpine — used by HEALTHCHECK below.
COPY --from=be-builder --chown=node:node /build/be/dist         ./dist
COPY --from=be-builder --chown=node:node /build/be/node_modules ./node_modules
COPY --from=fe-builder --chown=node:node /build/fe/dist         ./public
COPY --chown=node:node config.yaml .
# Run as the unprivileged built-in `node` user (uid 1000) — never root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ice >/dev/null || exit 1
CMD ["node", "dist/index.js"]
