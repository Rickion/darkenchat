# Stage 1: Build frontend
FROM --platform=$BUILDPLATFORM node:24-alpine AS fe-builder
WORKDIR /fe
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Build signaling server
FROM --platform=$BUILDPLATFORM node:24-alpine AS be-builder
WORKDIR /be
COPY signaling/package*.json ./
RUN npm ci
COPY signaling/ .
RUN npm run build

# Stage 3: Final image
FROM node:24-alpine
WORKDIR /app
ENV APP_ROOT=/app
COPY --from=be-builder /be/dist       ./dist
COPY --from=be-builder /be/node_modules ./node_modules
COPY --from=fe-builder /fe/dist       ./public
COPY config.yaml .
EXPOSE 3000
CMD ["node", "dist/index.js"]
