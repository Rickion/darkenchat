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
COPY --from=be-builder /build/be/dist         ./dist
COPY --from=be-builder /build/be/node_modules ./node_modules
COPY --from=fe-builder /build/fe/dist         ./public
COPY config.yaml .
EXPOSE 3000
CMD ["node", "dist/index.js"]
