#!/bin/sh
# Host-side runner for the two reviewed, bounded maintenance timers.
set -eu

case "${1-}" in
  resource_cleanup|course_thumbnails) service=$1 ;;
  *) echo 'WORKOUT_MAINTENANCE_INVALID_SERVICE' >&2; exit 64 ;;
esac

cd /srv/workout-manager/source
umask 077
mkdir -p /run/lock/workout-manager

# The host lock serializes timer invocations. A fixed Docker container name also
# fails closed if a killed Compose client leaves a worker running in Docker.
exec 9>/run/lock/workout-manager/maintenance.lock
if ! flock -n 9; then
  echo 'WORKOUT_MAINTENANCE_BUSY' >&2
  exit 75
fi

echo "WORKOUT_MAINTENANCE_START service=$service"
set +e
timeout --signal=TERM --kill-after=30s 20m \
  docker compose --env-file /srv/workout-manager/compose.env \
  -f deploy/lightsail/compose.yml --profile maintenance \
  run --rm --no-deps --name wm-maintenance-one-shot "$service"
status=$?
set -e
echo "WORKOUT_MAINTENANCE_END service=$service status=$status"
exit "$status"
