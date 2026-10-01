#!/bin/sh
set -eu

fail() {
  printf 'BACKUP_WINDOW_LAUNCH_FAILED\n' >&2
  exit 1
}

[ "$#" -eq 0 ] || fail
[ "$(/usr/bin/id -u)" -eq 0 ] || fail
case "$0" in
  /*) ;;
  *) fail ;;
esac

no_symlink_components() {
  current=$1
  while [ "$current" != / ]; do
    [ ! -L "$current" ] || fail
    current=${current%/*}
    [ -n "$current" ] || current=/
  done
}

# Refuse aliases for the reviewed release or runtime, including parent symlinks.
no_symlink_components "$0"
node=/srv/workout-manager/backup-runtime/20261001-9babcea-node24/node
no_symlink_components "$node"

release=${0%/*}
[ "$(CDPATH= cd "$release" && pwd -P)" = "$release" ] || fail
[ "$(/usr/bin/stat -c '%u:%a' -- "$0")" = '0:700' ] || fail
[ "$(/usr/bin/stat -c '%u:%a' -- "$release")" = '0:700' ] || fail
[ -f "$release/backup-window.mjs" ] || fail
[ ! -L "$release/backup-window.mjs" ] || fail
[ "$(/usr/bin/stat -c '%u:%a' -- "$release/backup-window.mjs")" = '0:700' ] || fail
[ -f "$node" ] || fail
[ "$(/usr/bin/stat -c '%u:%a' -- "$node")" = '0:700' ] || fail

umask 077
exec /usr/bin/env -i \
  PATH=/srv/workout-manager/backup-runtime/20261001-9babcea-node24:/usr/bin:/bin \
  HOME=/root \
  LANG=C.UTF-8 \
  TMPDIR=/tmp \
  DOCKER_HOST=unix:///var/run/docker.sock \
  WORKOUT_BACKUP_FENCE_CONFIG=/srv/workout-manager/admin/backup/fence.json \
  "$node" \
  "$release/backup-window.mjs"
