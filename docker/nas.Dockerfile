# Registry-free NAS build: the context holds this file plus rootfs.tar, the exported filesystem of the real image
# (see scripts/nas-context.sh). Building only unpacks it, so the NAS needs no Docker Hub or npm access.
# Keep the settings below in sync with the project Dockerfile.
FROM scratch
ADD rootfs.tar /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    LIBRARY_ROOT=/library \
    STATIC_DIR=/app/web \
    TZ=Asia/Shanghai
WORKDIR /app
VOLUME ["/data", "/library"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/app/kmoesync", "--healthcheck"]
ENTRYPOINT ["/app/entrypoint.sh"]
