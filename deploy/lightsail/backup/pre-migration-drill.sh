#!/usr/bin/env bash
# Opt-in, DB-only rollback capture and isolated migration rehearsal. Install as root:0700.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
# Keep command diagnostics (which can contain SQL or URLs) off the operator channel.
exec 3>&2 2>/dev/null

node_bin=/srv/workout-manager/backup-runtime/20261001-9babcea-node24/node
checker=/srv/workout-manager/admin/backup/check-fence.mjs
backup_root=/srv/workout-manager/backups/pre-migration
private_root=/srv/workout-manager/data/private
lock_root=/run/lock/workout-manager
staged_image=workout-manager/app:fa29723-staged
staged_image_id=sha256:e117f1042c3d7d9eed24ef830f3611260c0738bb5a595234589b1468d4399977
postgres_version=170006
phase=GUARD
archive=
clone_db=
clone_app=
clone_setup=
clone_net=
clone_volume=
scratch=
db_created=0
app_created=0
net_created=0
volume_created=0
app_stopped=0
graph_stopped=0
cleanup_failed=0

fail() { return 1; }
root_file() {
  [[ -f $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]
}
root_directory() {
  [[ -d $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]
}
quiet() { "$@" >/dev/null 2>&1; }
live_docker() {
  /usr/bin/timeout --signal=TERM --kill-after=30s 60s \
    /usr/bin/docker --host unix:///var/run/docker.sock "$@"
}
long_docker() {
  /usr/bin/timeout --signal=TERM --kill-after=30s 35m \
    /usr/bin/docker --host unix:///var/run/docker.sock "$@"
}
check_fence() {
  [[ $("$node_bin" "$checker" 2>/dev/null) == BACKUP_FENCE_CHECKED ]]
}
private_empty() {
  local first
  first=$(find "$private_root" -mindepth 1 -print -quit) || return 1
  [[ -z $first ]]
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if (( app_created || db_created || net_created || volume_created || app_stopped || graph_stopped )); then
    quiet live_docker info || cleanup_failed=1
  fi
  if (( app_created )) && live_docker container inspect "$clone_app" >/dev/null 2>&1; then
    quiet live_docker rm -f "$clone_app" || cleanup_failed=1
  fi
  if [[ -n $clone_setup ]]; then
    if live_docker container inspect "$clone_setup" >/dev/null 2>&1; then
      quiet live_docker rm -f "$clone_setup" || cleanup_failed=1
    fi
  fi
  if (( db_created )) && live_docker container inspect "$clone_db" >/dev/null 2>&1; then
    quiet live_docker rm -f "$clone_db" || cleanup_failed=1
  fi
  if (( net_created )) && live_docker network inspect "$clone_net" >/dev/null 2>&1; then
    quiet live_docker network rm "$clone_net" || cleanup_failed=1
  fi
  if (( volume_created )) && live_docker volume inspect "$clone_volume" >/dev/null 2>&1; then
    quiet live_docker volume rm "$clone_volume" || cleanup_failed=1
  fi
  if [[ -n $scratch ]]; then rm -rf -- "$scratch" || cleanup_failed=1; fi
  if [[ -n ${partial:-} && -f $partial ]]; then rm -f -- "$partial" || cleanup_failed=1; fi
  if (( app_stopped )); then
    quiet live_docker start "$app_id" || cleanup_failed=1
    [[ $(live_docker inspect -f '{{.State.Running}}' "$app_id") == true ]] || cleanup_failed=1
  fi
  if (( graph_stopped )); then
    quiet live_docker start "$graph_id" || cleanup_failed=1
    [[ $(live_docker inspect -f '{{.State.Running}}' "$graph_id") == true ]] || cleanup_failed=1
  fi
  if (( app_stopped && !cleanup_failed )); then
    local original_health=
    for ((i=0; i<90; i++)); do
      original_health=$(live_docker inspect -f '{{.State.Health.Status}}' "$app_id")
      [[ $original_health == healthy ]] && break
      [[ $original_health != unhealthy ]] || break
      sleep 1
    done
    [[ $original_health == healthy ]] || cleanup_failed=1
  fi
  if (( cleanup_failed )); then
    printf 'PRE_MIGRATION_CLEANUP_FAILED\n' >&3
    status=1
  fi
  if (( status != 0 )); then printf 'PRE_MIGRATION_%s_FAILED\n' "$phase" >&3; fi
  if [[ -n $archive && -f $archive ]]; then printf 'PRE_MIGRATION_RETAINED_ARCHIVE=%s\n' "$archive"; fi
  if (( status == 0 )); then printf 'PRE_MIGRATION_REHEARSAL_PASSED\n'; fi
  exit "$status"
}
trap cleanup EXIT
trap 'phase=INTERRUPTED; exit 1' INT TERM HUP

[[ $# == 1 && $1 == --execute && $EUID == 0 ]] || fail
[[ $(realpath -e "$0") == /srv/workout-manager/admin/pre-migration-drill.sh ]] || fail
root_file "$0" 700 || fail
root_file "$node_bin" 700 || fail
root_file "$checker" 700 || fail
root_directory "$lock_root" 700 || fail
root_file "$lock_root/backup.lock" 600 || fail
root_file "$lock_root/maintenance.lock" 600 || fail
[[ -d $private_root && ! -L $private_root ]] || fail
[[ ${WORKOUT_BACKUP_FENCE_CONFIG:-} == /srv/workout-manager/admin/backup/fence.json ]] || fail
root_file "$WORKOUT_BACKUP_FENCE_CONFIG" 600 || fail
for path in /srv /srv/workout-manager; do
  [[ -d $path && ! -L $path && $(stat -c %u "$path") == 0 ]] || fail
done
if [[ ! -e /srv/workout-manager/backups ]]; then
  mkdir -m 0700 -- /srv/workout-manager/backups
fi
root_directory /srv/workout-manager/backups 700 || fail
if [[ ! -e $backup_root ]]; then mkdir -m 0700 -- "$backup_root"; fi
root_directory "$backup_root" 700 || fail
[[ $(live_docker image inspect -f '{{.Id}}' "$staged_image" 2>/dev/null) == "$staged_image_id" ]] || fail
[[ -x /usr/bin/flock && -x /usr/bin/docker && -x /usr/bin/openssl && -x /usr/bin/timeout ]] || fail
private_empty || fail

exec 8>"$lock_root/backup.lock"
flock -n 8 || fail
exec 9>"$lock_root/maintenance.lock"
flock -n 9 || fail

# Read exact, root-pinned full IDs. The installed checker independently validates them.
app_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.app)' "$WORKOUT_BACKUP_FENCE_CONFIG")
graph_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.graphhopper)' "$WORKOUT_BACKUP_FENCE_CONFIG")
pg_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.postgres)' "$WORKOUT_BACKUP_FENCE_CONFIG")
for id in "$app_id" "$graph_id" "$pg_id"; do [[ $id =~ ^[a-f0-9]{64}$ ]] || fail; done
for service in app graphhopper postgres; do
  case $service in
    app) id=$app_id ;;
    graphhopper) id=$graph_id ;;
    postgres) id=$pg_id ;;
  esac
  identity=$(live_docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id") || fail
  [[ $identity == "workout-manager|${service}|/srv/workout-manager/source/deploy/lightsail/compose.yml" ]] || fail
done
[[ $(live_docker inspect -f '{{.State.Running}}' "$app_id" 2>/dev/null) == true ]] || fail
[[ $(live_docker inspect -f '{{.State.Running}}' "$graph_id" 2>/dev/null) == true ]] || fail
[[ $(live_docker inspect -f '{{.State.Running}}' "$pg_id" 2>/dev/null) == true ]] || fail

phase=QUIESCE
graph_stopped=1
quiet live_docker stop --time 30 "$graph_id"
app_stopped=1
quiet live_docker stop --time 30 "$app_id"
check_fence && private_empty || fail

phase=CAPTURE
run_id=$(openssl rand -hex 12)
archive="$backup_root/${run_id}.dump"
partial="$archive.partial"
[[ ! -e $archive && ! -e $partial ]] || fail
[[ $(df -Pk "$backup_root" | awk 'END {print $4}') -ge 2097152 ]] || fail
check_fence || fail
long_docker exec --user postgres "$pg_id" pg_dump --format=custom --no-owner --no-acl --dbname=workout > "$partial" || fail
[[ $(head -c 5 "$partial") == PGDMP ]] || fail
sync -f "$partial" || fail
check_fence && private_empty || fail
quiet long_docker exec -i "$pg_id" pg_restore --list < "$partial" || fail
quiet long_docker exec -i "$pg_id" pg_restore --file=/dev/null < "$partial" || fail
before_hash=$(sha256sum "$partial" | awk '{print $1}')
check_fence && private_empty || fail
[[ $(sha256sum "$partial" | awk '{print $1}') == "$before_hash" ]] || fail
mv -- "$partial" "$archive" || fail
sync -f "$backup_root" || fail
root_file "$archive" 600 || fail

phase=ISOLATED_RESTORE
scratch=$(mktemp -d /tmp/wm-pre-migration.XXXXXXXX) || fail
chmod 0700 "$scratch"
mkdir -m 0700 "$scratch/private"
chown 1000:1000 "$scratch/private"
clone_net="wm-pre-migration-${run_id}-net"
clone_volume="wm-pre-migration-${run_id}-pg"
clone_db="wm-pre-migration-${run_id}-db"
clone_app="wm-pre-migration-${run_id}-app"
clone_setup="wm-pre-migration-${run_id}-setup"
pg_image_id=$(live_docker inspect -f '{{.Image}}' "$pg_id" 2>/dev/null)
[[ $pg_image_id =~ ^sha256:[a-f0-9]{64}$ ]] || fail
admin_password=$(openssl rand -hex 24)
owner_password=$(openssl rand -hex 24)
runtime_password=$(openssl rand -hex 24)
cleanup_password=$(openssl rand -hex 24)
thumbnail_password=$(openssl rand -hex 24)
ingestion_password=$(openssl rand -hex 24)
printf 'POSTGRES_DB=workout\nPOSTGRES_PASSWORD=%s\n' "$admin_password" > "$scratch/postgres.env"
cat > "$scratch/setup.env" <<EOF
NODE_ENV=production
POSTGRES_BOOTSTRAP_URL=postgresql://postgres:${admin_password}@wm-postgres/workout
MIGRATION_DATABASE_URL=postgresql://workout_owner:${owner_password}@wm-postgres/workout
WORKOUT_RUNTIME_DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout
RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout
COURSE_THUMBNAIL_DATABASE_URL=postgresql://workout_course_thumbnail_worker:${thumbnail_password}@wm-postgres/workout
RESOURCE_URL_INGESTION_DATABASE_URL=postgresql://workout_resource_ingestion_worker:${ingestion_password}@wm-postgres/workout
EOF
net_created=1
quiet live_docker network create --internal "$clone_net" || fail
volume_created=1
quiet live_docker volume create "$clone_volume" || fail
db_created=1
quiet live_docker run -d --name "$clone_db" --network "$clone_net" --network-alias wm-postgres \
  --label workout.pre-migration-rehearsal=1 --env-file "$scratch/postgres.env" \
  -v "$clone_volume:/var/lib/postgresql/data" "$pg_image_id" || fail
ready=0
for ((i=0; i<90; i++)); do
  if [[ $(live_docker exec "$clone_db" cat /proc/1/comm 2>/dev/null) == postgres ]] && \
    quiet live_docker exec "$clone_db" pg_isready -U postgres -d workout; then ready=1; break; fi
  sleep 1
done
(( ready )) || fail
[[ $(live_docker exec --user postgres "$clone_db" psql -X -qAt -d workout -c 'SHOW server_version_num' 2>/dev/null) == "$postgres_version" ]] || fail

# Policies in the archive refer to these roles; create them before restricted restore.
live_docker exec -i --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -q -d workout >/dev/null 2>&1 <<EOF
CREATE ROLE workout_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${owner_password}';
CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${runtime_password}';
CREATE ROLE workout_resource_cleanup_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${cleanup_password}';
CREATE ROLE workout_course_thumbnail_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${thumbnail_password}';
CREATE ROLE workout_resource_ingestion_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${ingestion_password}';
ALTER DATABASE workout OWNER TO workout_owner;
ALTER SCHEMA public OWNER TO workout_owner;
EOF
[[ $(sha256sum "$archive" | awk '{print $1}') == "$before_hash" ]] || fail
quiet long_docker exec -i -e "PGPASSWORD=$owner_password" "$clone_db" \
  pg_restore --exit-on-error --no-owner --no-acl -h 127.0.0.1 -U workout_owner -d workout < "$archive" || fail
[[ $(sha256sum "$archive" | awk '{print $1}') == "$before_hash" ]] || fail
check_fence && private_empty || fail

phase=MIGRATE_CLONE
setup_result=$(long_docker run --rm --name "$clone_setup" --network "$clone_net" --env-file "$scratch/setup.env" \
  --label workout.pre-migration-rehearsal=1 "$staged_image_id" \
  node --import tsx /app/deploy/lightsail/bootstrap-db.mjs 2>/dev/null) || fail
[[ $setup_result == DATABASE_SETUP_COMPLETE ]] || fail
clone_sql() {
  live_docker exec --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -qAt -d workout -c "$1" 2>/dev/null
}
[[ $(clone_sql "SELECT count(*)=93 AND min(version)=1 AND max(version)=93 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations") == t ]] || fail
[[ $(clone_sql "SELECT count(*)=5 AND bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole) FROM pg_roles WHERE rolname IN ('workout_owner','workout_runtime','workout_resource_cleanup_worker','workout_course_thumbnail_worker','workout_resource_ingestion_worker')") == t ]] || fail
[[ $(clone_sql "SELECT count(*) >= 16 AND bool_and(relforcerowsecurity) FROM pg_class WHERE relkind IN ('r','p') AND relrowsecurity AND relnamespace='public'::regnamespace") == t ]] || fail
[[ $(clone_sql "SELECT has_table_privilege('workout_runtime','public.consent','SELECT') AND NOT has_schema_privilege('workout_runtime','public','CREATE')") == t ]] || fail

phase=HEALTH_CLONE
app_created=1
quiet live_docker run -d --name "$clone_app" --network "$clone_net" \
  --label workout.pre-migration-rehearsal=1 \
  -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
  -e PUBLIC_ORIGIN=https://restore.invalid -e OIDC_ISSUER=https://idp.invalid \
  -e OIDC_CLIENT_ID=isolated -e OIDC_CLIENT_SECRET=isolated -e NODE_ENV=production \
  -e API_ORIGIN=http://127.0.0.1:4300 -e PORT=4300 \
  -e PRIVATE_RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
  -v "$scratch/private:/var/lib/workout/private" "$staged_image_id" || fail
healthy=0
for ((i=0; i<90; i++)); do
  state=$(live_docker inspect -f '{{.State.Health.Status}}' "$clone_app" 2>/dev/null) || fail
  if [[ $state == healthy ]]; then healthy=1; break; fi
  [[ $state != unhealthy ]] || fail
  sleep 1
done
(( healthy )) || fail
[[ $(sha256sum "$archive" | awk '{print $1}') == "$before_hash" ]] || fail
check_fence && private_empty || fail
