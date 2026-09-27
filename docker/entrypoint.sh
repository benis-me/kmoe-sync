#!/bin/sh
# Runs the server as PUID:PGID when given (usual NAS convention), so files in /library belong to your NAS user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
LIBRARY_ROOT="${LIBRARY_ROOT:-/library}"
[ -n "$UMASK" ] && umask "$UMASK"

if [ -n "$PUID" ] && [ "$(id -u)" = "0" ]; then
  PGID="${PGID:-$PUID}"
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "kmoesync: cannot change the owner of $DATA_DIR, starting anyway" >&2
  # A library folder Docker just created (root-owned and empty) is handed over; an existing library is never re-owned.
  if [ -d "$LIBRARY_ROOT" ] && [ "$(stat -c %u "$LIBRARY_ROOT")" = "0" ] && [ -z "$(ls -A "$LIBRARY_ROOT")" ]; then
    chown "$PUID:$PGID" "$LIBRARY_ROOT" 2>/dev/null || true
  fi
  # Keep supplementary groups from `docker run --group-add` (NAS share groups), but never root's group 0.
  groups=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, - || true)
  if [ -n "$groups" ]; then set_groups="--groups=$groups"; else set_groups="--clear-groups"; fi
  if [ -d "$LIBRARY_ROOT" ] && ! setpriv --reuid="$PUID" --regid="$PGID" "$set_groups" test -w "$LIBRARY_ROOT"; then
    echo "kmoesync: WARNING: $LIBRARY_ROOT is not writable for UID $PUID / GID $PGID; downloads to the local library will fail." >&2
    echo "kmoesync: 警告：$LIBRARY_ROOT 对 UID $PUID / GID $PGID 不可写，下载到本地书库会失败。请在 NAS 上给该用户写权限，或改用目录属主的 PUID/PGID。" >&2
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" "$set_groups" /app/kmoesync "$@"
fi

exec /app/kmoesync "$@"
