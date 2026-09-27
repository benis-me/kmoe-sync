#!/bin/sh
# Packs a registry-free build context for a NAS: dist-nas/kmoesync-context-<arch>.tar.gz.
# Build it on the NAS with Portainer (Images → Build a new image → URL, served e.g. by
# `python3 -m http.server -d dist-nas`) or `docker build -t kmoesync:latest - < kmoesync-context-<arch>.tar.gz`.
# Usage: scripts/nas-context.sh [amd64|arm64]   (default amd64; needs Docker with buildx)
set -eu
arch="${1:-amd64}"
case "$arch" in amd64|arm64) ;; *) echo "usage: $0 [amd64|arm64]" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."
docker buildx build --platform "linux/$arch" -t "kmoesync:$arch" --load .
work=$(mktemp -d)
trap 'rm -rf "$work"; docker rm -f kmoesync-nas-export >/dev/null 2>&1 || true' EXIT
docker create --platform "linux/$arch" --name kmoesync-nas-export "kmoesync:$arch" >/dev/null
docker export kmoesync-nas-export -o "$work/rootfs.tar"
cp docker/nas.Dockerfile "$work/Dockerfile"
mkdir -p dist-nas
tar -czf "dist-nas/kmoesync-context-$arch.tar.gz" -C "$work" Dockerfile rootfs.tar
echo "dist-nas/kmoesync-context-$arch.tar.gz"
