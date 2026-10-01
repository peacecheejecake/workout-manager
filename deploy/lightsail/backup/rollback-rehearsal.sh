#!/usr/bin/env bash
# Opt-in, DB-only isolated rehearsal against the retained pre-migration archive.
# Install as /srv/workout-manager/admin/rollback-rehearsal.sh, root:0700.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
# Docker, PostgreSQL, and shell diagnostics may contain health data or credentials.
exec 3>&2 2>/dev/null

archive=/srv/workout-manager/backups/pre-migration/792017f9cac82695fb69e6c8.dump
archive_sha=04870962d6fbe147d49856ea507885b0735ecf9a08f87d0f8d1e99f67c555517
app_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c
pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
lock_root=/run/lock/workout-manager
phase=GUARD
scratch=
clone_db=
clone_app=
clone_setup=
clone_net=
clone_volume=
db_created=0
app_created=0
net_created=0
volume_created=0
cleanup_failed=0

fail() { return 1; }
root_file() { [[ -f $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
root_directory() { [[ -d $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
quiet() { "$@" >/dev/null 2>&1; }
docker_short() {
  /usr/bin/timeout --signal=TERM --kill-after=30s 60s \
    /usr/bin/docker --host unix:///var/run/docker.sock "$@"
}
docker_long() {
  /usr/bin/timeout --signal=TERM --kill-after=30s 35m \
    /usr/bin/docker --host unix:///var/run/docker.sock "$@"
}
archive_intact() {
  root_file "$archive" 600 &&
    [[ $(stat -c '%d:%i:%s' "$archive") == "$archive_identity" ]] &&
    [[ $(sha256sum "$archive" | awk '{print $1}') == "$archive_sha" ]]
}
cleanup_object() {
  local kind=$1 name=$2 expected=$3 label
  label=$(docker_short "$kind" inspect -f '{{index .Labels "workout.rollback-rehearsal"}}' "$name" 2>/dev/null)
  if [[ $label == "$expected" ]]; then
    quiet docker_short "$kind" rm "$name" || cleanup_failed=1
  elif [[ -n $label ]]; then
    cleanup_failed=1
  fi
}
cleanup_container() {
  local name=$1 expected=$2 label
  label=$(docker_short container inspect -f '{{index .Config.Labels "workout.rollback-rehearsal"}}' "$name" 2>/dev/null)
  if [[ $label == "$expected" ]]; then
    quiet docker_short rm -f "$name" || cleanup_failed=1
  elif [[ -n $label ]]; then
    cleanup_failed=1
  fi
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if (( app_created || db_created || net_created || volume_created )); then
    quiet docker_short info || cleanup_failed=1
  fi
  if (( app_created )); then cleanup_container "$clone_app" "$run_id"; fi
  if [[ -n $clone_setup ]]; then cleanup_container "$clone_setup" "$run_id"; fi
  if (( db_created )); then cleanup_container "$clone_db" "$run_id"; fi
  if (( net_created )); then cleanup_object network "$clone_net" "$run_id"; fi
  if (( volume_created )); then cleanup_object volume "$clone_volume" "$run_id"; fi
  if [[ -n $scratch ]]; then rm -rf -- "$scratch" || cleanup_failed=1; fi
  if (( cleanup_failed )); then
    printf 'ROLLBACK_REHEARSAL_CLEANUP_FAILED\n' >&3
    status=1
  fi
  if (( status != 0 )); then
    printf 'ROLLBACK_REHEARSAL_%s_FAILED\n' "$phase" >&3
  else
    printf 'ROLLBACK_REHEARSAL_PASSED\n'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'phase=INTERRUPTED; exit 1' INT TERM HUP

[[ $# == 1 && $1 == --execute && $EUID == 0 ]] || fail
[[ $(realpath -e "$0") == /srv/workout-manager/admin/rollback-rehearsal.sh ]] || fail
root_file "$0" 700 || fail
for dir in /srv /srv/workout-manager /srv/workout-manager/admin /srv/workout-manager/backups; do
  [[ -d $dir && ! -L $dir && $(stat -c %u "$dir") == 0 ]] || fail
done
root_directory /srv/workout-manager/backups/pre-migration 700 || fail
root_file "$archive" 600 || fail
root_directory "$lock_root" 700 || fail
root_file "$lock_root/backup.lock" 600 || fail
root_file "$lock_root/maintenance.lock" 600 || fail
for bin in docker timeout openssl sha256sum flock stat mktemp; do
  [[ -x /usr/bin/$bin ]] || fail
done
[[ $(docker_short image inspect -f '{{.Id}}' "$app_image") == "$app_image" ]] || fail
[[ $(docker_short image inspect -f '{{.Id}}' "$pg_image") == "$pg_image" ]] || fail
# Refuse to inspect or alter live containers. Locks only serialize with the host backup writer.
exec 8<"$lock_root/backup.lock"
flock -n 8 || fail
exec 9<"$lock_root/maintenance.lock"
flock -n 9 || fail
archive_identity=$(stat -c '%d:%i:%s' "$archive") || fail
archive_intact || fail

phase=CLONE
scratch=$(mktemp -d /tmp/wm-rollback-rehearsal.XXXXXXXX) || fail
chmod 0700 "$scratch"
mkdir -m 0700 "$scratch/private"
chown 1000:1000 "$scratch/private"
run_id=$(openssl rand -hex 12) || fail
clone_net="wm-rollback-${run_id}-net"
clone_volume="wm-rollback-${run_id}-pg"
clone_db="wm-rollback-${run_id}-db"
clone_app="wm-rollback-${run_id}-app"
clone_setup="wm-rollback-${run_id}-setup"
admin_password=$(openssl rand -hex 24)
owner_password=$(openssl rand -hex 24)
runtime_password=$(openssl rand -hex 24)
cleanup_password=$(openssl rand -hex 24)
thumbnail_password=$(openssl rand -hex 24)
ingestion_password=$(openssl rand -hex 24)
printf 'POSTGRES_DB=workout\nPOSTGRES_PASSWORD=%s\n' "$admin_password" > "$scratch/postgres.env"
cat > "$scratch/setup.env" <<SETUP
NODE_ENV=production
POSTGRES_BOOTSTRAP_URL=postgresql://postgres:${admin_password}@wm-postgres/workout
MIGRATION_DATABASE_URL=postgresql://workout_owner:${owner_password}@wm-postgres/workout
WORKOUT_RUNTIME_DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout
RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout
COURSE_THUMBNAIL_DATABASE_URL=postgresql://workout_course_thumbnail_worker:${thumbnail_password}@wm-postgres/workout
RESOURCE_URL_INGESTION_DATABASE_URL=postgresql://workout_resource_ingestion_worker:${ingestion_password}@wm-postgres/workout
SETUP
net_created=1
quiet docker_short network create --internal --label "workout.rollback-rehearsal=$run_id" "$clone_net" || fail
volume_created=1
quiet docker_short volume create --label "workout.rollback-rehearsal=$run_id" "$clone_volume" || fail
db_created=1
quiet docker_short run -d --name "$clone_db" --network "$clone_net" --network-alias wm-postgres \
  --label "workout.rollback-rehearsal=$run_id" --env-file "$scratch/postgres.env" \
  -v "$clone_volume:/var/lib/postgresql/data" "$pg_image" || fail
ready=0
for ((i=0; i<90; i++)); do
  if [[ $(docker_short exec "$clone_db" cat /proc/1/comm 2>/dev/null) == postgres ]] && \
    quiet docker_short exec "$clone_db" pg_isready -U postgres -d workout; then ready=1; break; fi
  sleep 1
done
(( ready )) || fail
[[ $(docker_short exec --user postgres "$clone_db" psql -X -qAt -d workout -c 'SHOW server_version_num') == 170006 ]] || fail

# The dump omits cluster roles; policies reference these bounded role names.
quiet docker_short exec -i --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -q -d workout <<ROLES
CREATE ROLE workout_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${owner_password}';
CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${runtime_password}';
CREATE ROLE workout_resource_cleanup_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${cleanup_password}';
CREATE ROLE workout_course_thumbnail_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${thumbnail_password}';
CREATE ROLE workout_resource_ingestion_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${ingestion_password}';
ALTER DATABASE workout OWNER TO workout_owner;
ALTER SCHEMA public OWNER TO workout_owner;
ROLES
archive_intact || fail
phase=RESTORE
quiet docker_long exec -i -e "PGPASSWORD=$owner_password" "$clone_db" \
  pg_restore --exit-on-error --no-owner --no-acl -h 127.0.0.1 -U workout_owner -d workout < "$archive" || fail
archive_intact || fail

phase=OLD_SETUP
setup_result=$(docker_long run --rm --name "$clone_setup" --network "$clone_net" \
  --label "workout.rollback-rehearsal=$run_id" --env-file "$scratch/setup.env" "$app_image" \
  node --import tsx /app/deploy/lightsail/bootstrap-db.mjs) || fail
[[ $setup_result == DATABASE_SETUP_COMPLETE ]] || fail
clone_sql() {
  docker_short exec --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -qAt -d workout -c "$1"
}
[[ $(clone_sql "SELECT count(*)=65 AND min(version)=1 AND max(version)=65 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations") == t ]] || fail
[[ $(clone_sql "SELECT count(*)=5 AND bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole) FROM pg_roles WHERE rolname IN ('workout_owner','workout_runtime','workout_resource_cleanup_worker','workout_course_thumbnail_worker','workout_resource_ingestion_worker')") == t ]] || fail
[[ $(clone_sql "SELECT has_table_privilege('workout_runtime','public.consent','SELECT') AND NOT has_schema_privilege('workout_runtime','public','CREATE')") == t ]] || fail

phase=OLD_HEALTH
app_created=1
quiet docker_short run -d --name "$clone_app" --network "$clone_net" \
  --label "workout.rollback-rehearsal=$run_id" \
  -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
  -e PUBLIC_ORIGIN=https://restore.invalid -e OIDC_ISSUER=https://idp.invalid \
  -e OIDC_CLIENT_ID=isolated -e OIDC_CLIENT_SECRET=isolated -e NODE_ENV=production \
  -e API_ORIGIN=http://127.0.0.1:4300 -e PORT=4300 \
  -e PRIVATE_RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
  -v "$scratch/private:/var/lib/workout/private" "$app_image" || fail
healthy=0
for ((i=0; i<90; i++)); do
  state=$(docker_short inspect -f '{{.State.Health.Status}}' "$clone_app") || fail
  if [[ $state == healthy ]]; then healthy=1; break; fi
  [[ $state != unhealthy ]] || fail
  sleep 1
done
(( healthy )) || fail
archive_intact || fail
