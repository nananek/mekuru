# ==========================================
# Multi-stage Dockerfile for Mekuru Croquis
# ==========================================

# 1. Build Frontend (Vite + TypeScript PWA)
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app

COPY package*.json ./
RUN npm ci || npm install

COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public/ ./public/
COPY src/ ./src/
RUN npm run build

# 2. Build Backend (Rust + Axum + WebAuthn)
FROM rust:1-bookworm AS backend-builder
WORKDIR /app/server

# Cache dependencies
COPY server/Cargo.toml server/Cargo.lock* ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

COPY server/src ./src
# Touch main to invalidate dummy build
RUN touch src/main.rs && cargo build --release

# 3. Minimal Runtime Stage
FROM debian:bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    sqlite3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=backend-builder /app/server/target/release/server /usr/local/bin/mekuru
COPY --from=frontend-builder /app/dist /app/dist

# Create persistent storage directory for SQLite database & uploaded sketches
RUN mkdir -p /app/data && chmod 777 /app/data

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_URL=/app/data/mekuru.db \
    STATIC_DIR=/app/dist \
    RP_ID=localhost \
    RP_ORIGIN=http://localhost:3000

EXPOSE 3000

VOLUME ["/app/data"]

ENTRYPOINT ["/usr/local/bin/mekuru"]
CMD ["serve"]
