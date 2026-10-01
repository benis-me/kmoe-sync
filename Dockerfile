# syntax=docker/dockerfile:1
# Kmoe Sync: one self-contained binary + the built web UI. Multi-arch (linux/amd64, linux/arm64).
# The amd64 build targets x64-baseline so it also runs on NAS CPUs without AVX2 (Celeron/Atom/older Xeon).

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG TARGETARCH
RUN bun run build \
 && case "$TARGETARCH" in arm64) target=bun-linux-arm64 ;; *) target=bun-linux-x64-baseline ;; esac \
 && bun build server/index.ts --compile --minify --sourcemap --target="$target" --outfile /out/kmoesync

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/kmoesync /app/kmoesync
COPY --from=build /src/dist /app/web
COPY docker/entrypoint.sh /app/entrypoint.sh
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    LIBRARY_ROOT=/library \
    STATIC_DIR=/app/web \
    TZ=Asia/Shanghai
VOLUME ["/data", "/library"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/app/kmoesync", "--healthcheck"]
ENTRYPOINT ["/app/entrypoint.sh"]
