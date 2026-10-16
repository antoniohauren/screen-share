FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM rust:1.99-bookworm AS rust
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY web ./web
COPY --from=web /app/web/dist ./web/dist
RUN cargo build --locked --release --bin screen-share

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && useradd -u 10001 -m app && mkdir /data && chown app:app /data
COPY --from=rust /app/target/release/screen-share /usr/local/bin/screen-share
USER app
ENV DATABASE_PATH=/data/broadcasts.db BIND=0.0.0.0:8787
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s CMD curl -fsS http://localhost:8787/health || exit 1
CMD ["screen-share"]
