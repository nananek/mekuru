# ==========================================
# Multi-stage Dockerfile for Mekuru Croquis
# Distroless Nonroot Runtime
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
RUN touch src/main.rs && cargo build --release

# Prepare data directory owned by nonroot (65532:65532)
RUN mkdir -p /app/data && chown -R 65532:65532 /app/data

# 3. Distroless Nonroot Runtime Stage
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app

# Copy SSL libraries to ensure runtime compatibility with OpenSSL 3
COPY --from=backend-builder /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=backend-builder /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3

# Copy binary and static assets
COPY --from=backend-builder /app/server/target/release/server /usr/local/bin/mekuru
COPY --from=backend-builder --chown=65532:65532 /app/data /app/data
COPY --from=frontend-builder /app/dist /app/dist

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_URL=/app/data/mekuru.db \
    STATIC_DIR=/app/dist \
    RP_ID=localhost \
    RP_ORIGIN=http://localhost:3000

EXPOSE 3000

VOLUME ["/app/data"]

USER nonroot:nonroot

ENTRYPOINT ["/usr/local/bin/mekuru"]
CMD ["serve"]
