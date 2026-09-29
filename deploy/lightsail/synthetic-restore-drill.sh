#!/usr/bin/env bash
# Opt-in, synthetic-only recovery exercise for a host with the prebuilt app image.
set -euo pipefail

if [[ ${1:-} != --execute || $# != 1 ]]; then
  echo 'Opt-in only: synthetic-restore-drill.sh --execute' >&2
  exit 2
fi

image='workout-manager/app:ext-hosting-prelive-20260929'
docker image inspect "$image" >/dev/null
docker image inspect postgres:17.6-bookworm >/dev/null
run_id="wm-restore-$(openssl rand -hex 12)"
directory=$(mktemp -d "/tmp/${run_id}.XXXXXX")
source_net="${run_id}-source"
restore_net="${run_id}-restore"
source_db="${run_id}-source-db"
restore_db="${run_id}-restore-db"
app="${run_id}-app"
source_volume="${run_id}-source-pg"
restore_volume="${run_id}-restore-pg"
checks=()

cleanup() {
  docker rm -f "$app" "$source_db" "$restore_db" >/dev/null 2>&1 || true
  docker network rm "$source_net" "$restore_net" >/dev/null 2>&1 || true
  docker volume rm "$source_volume" "$restore_volume" >/dev/null 2>&1 || true
  rm -rf -- "$directory"
}
trap cleanup EXIT

password() { openssl rand -hex 24; }
postgres_password=$(password)
owner_password=$(password)
runtime_password=$(password)
cleanup_password=$(password)
thumbnail_password=$(password)
ingestion_password=$(password)

mkdir -p "$directory/private-source" "$directory/private-restored"
chmod 0700 "$directory"
chown 1000:1000 "$directory/private-restored"
chmod 0700 "$directory/private-restored"
printf 'synthetic-private-object-v1\n' > "$directory/private-source/object.txt"
cp "$directory/private-source/object.txt" "$directory/private-restored/object.txt"
chown 1000:1000 "$directory/private-restored/object.txt"
object_hash=$(sha256sum "$directory/private-source/object.txt" | cut -d ' ' -f 1)

docker network create --internal "$source_net" >/dev/null
docker network create --internal "$restore_net" >/dev/null
docker volume create "$source_volume" >/dev/null
docker volume create "$restore_volume" >/dev/null

start_db() {
  local name=$1 network=$2 volume=$3
  docker run -d --name "$name" --network "$network" --network-alias wm-postgres \
    --label 'workout.synthetic-restore=1' \
    -e POSTGRES_DB=workout -e "POSTGRES_PASSWORD=$postgres_password" \
    -v "$volume:/var/lib/postgresql/data" postgres:17.6-bookworm >/dev/null
  for _ in {1..60}; do
    if docker exec "$name" pg_isready -U postgres -d workout >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'ISOLATED_POSTGRES_NOT_READY' >&2
  exit 1
}

setup_db() {
  local network=$1
  docker run --rm --network "$network" --label 'workout.synthetic-restore=1' \
    -e NODE_ENV=production \
    -e "POSTGRES_BOOTSTRAP_URL=postgresql://postgres:${postgres_password}@wm-postgres/workout" \
    -e "MIGRATION_DATABASE_URL=postgresql://workout_owner:${owner_password}@wm-postgres/workout" \
    -e "WORKOUT_RUNTIME_DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
    -e "RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout" \
    -e "COURSE_THUMBNAIL_DATABASE_URL=postgresql://workout_course_thumbnail_worker:${thumbnail_password}@wm-postgres/workout" \
    -e "RESOURCE_URL_INGESTION_DATABASE_URL=postgresql://workout_resource_ingestion_worker:${ingestion_password}@wm-postgres/workout" \
    "$image" node --import tsx /app/deploy/lightsail/bootstrap-db.mjs | grep -x DATABASE_SETUP_COMPLETE
}

psql_admin() {
  local name=$1 sql=$2
  docker exec -u postgres "$name" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d workout -c "$sql"
}

psql_runtime() {
  local name=$1 sql=$2
  docker exec -e "PGPASSWORD=$runtime_password" "$name" \
    psql -X -v ON_ERROR_STOP=1 -qAt -h 127.0.0.1 -U workout_runtime -d workout -c "$sql"
}

start_db "$source_db" "$source_net" "$source_volume"
setup_db "$source_net"
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-retained'; INSERT INTO consent VALUES ('synthetic-retained','app',true,1); COMMIT;" >/dev/null
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-erased'; INSERT INTO consent VALUES ('synthetic-erased','app',true,1); COMMIT;" >/dev/null
docker exec -u postgres "$source_db" pg_dump -Fc -U postgres -d workout > "$directory/synthetic.dump"
docker exec -i "$source_db" pg_restore --list < "$directory/synthetic.dump" >/dev/null
checks+=(synthetic_dump_readable)

# Simulate a post-backup erasure. The independently captured ledger here contains only
# the fixed synthetic tenant name. Replay must precede any restored runtime access.
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-erased'; SELECT erase_account('synthetic-erased'); COMMIT;" >/dev/null
[[ $(psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-erased'; SELECT count(*) FROM tenant_erasure; COMMIT;") == *1* ]]
checks+=(post_backup_erasure_captured)

start_db "$restore_db" "$restore_net" "$restore_volume"
psql_admin "$restore_db" "CREATE ROLE workout_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${owner_password}'; ALTER DATABASE workout OWNER TO workout_owner; ALTER SCHEMA public OWNER TO workout_owner;" >/dev/null
docker exec -i -e "PGPASSWORD=$owner_password" "$restore_db" \
  pg_restore --exit-on-error --no-owner --no-acl -h 127.0.0.1 -U workout_owner -d workout \
  < "$directory/synthetic.dump" >/dev/null
setup_db "$restore_net"
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='synthetic-retained';") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='synthetic-erased';") == 1 ]]
checks+=(owner_restore_and_setup)

psql_runtime "$restore_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-erased'; SELECT erase_account('synthetic-erased'); COMMIT;" >/dev/null
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='synthetic-erased';") == 0 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_erasure WHERE athlete_id='synthetic-erased';") == 1 ]]
[[ $(psql_runtime "$restore_db" "BEGIN; SET LOCAL app.athlete_id='synthetic-retained'; SELECT count(*) FROM consent; COMMIT;") == *1* ]]
checks+=(erasure_replayed_before_runtime_rls)

start_app() {
  docker run -d --name "$app" --network "$restore_net" \
    --label 'workout.synthetic-restore=1' \
    -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
    -e PUBLIC_ORIGIN=https://restore.invalid \
    -e OIDC_ISSUER=https://idp.invalid -e OIDC_CLIENT_ID=synthetic \
    -e OIDC_CLIENT_SECRET=synthetic -e NODE_ENV=production \
    -e API_ORIGIN=http://127.0.0.1:4300 -e PORT=4300 \
    -e PRIVATE_RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
    -v "$directory/private-restored:/var/lib/workout/private" \
    "$image" >/dev/null
  for _ in {1..90}; do
    if [[ $(docker inspect -f '{{.State.Health.Status}}' "$app") == healthy ]]; then return; fi
    if [[ $(docker inspect -f '{{.State.Status}}' "$app") == exited ]]; then break; fi
    sleep 1
  done
  echo 'ISOLATED_APP_NOT_HEALTHY' >&2
  exit 1
}

start_app
checks+=(restored_app_http_and_database_health)
[[ $(sha256sum "$directory/private-restored/object.txt" | cut -d ' ' -f 1) == "$object_hash" ]]
checks+=(restored_private_object_exact_bytes)
docker rm -f "$app" >/dev/null
docker restart "$restore_db" >/dev/null
for _ in {1..60}; do
  if docker exec "$restore_db" pg_isready -U postgres -d workout >/dev/null 2>&1; then break; fi
  sleep 1
done
start_app
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_erasure WHERE athlete_id='synthetic-erased';") == 1 ]]
[[ $(sha256sum "$directory/private-restored/object.txt" | cut -d ' ' -f 1) == "$object_hash" ]]
checks+=(restored_database_restart_app_health_erasure_and_object)

docker run --rm --network "$restore_net" --label 'workout.synthetic-restore=1' \
  -e "RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout" \
  -e RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
  -v "$directory/private-restored:/var/lib/workout/private" \
  "$image" node --import tsx /app/apps/worker/src/resource-cleanup.ts \
  | grep -q 'resource_cleanup_result'
checks+=(empty_queue_worker_one_shot)

printf '{"schemaVersion":1,"outcome":"passed","scope":"isolated synthetic Docker restore; no production backup or data","checks":['
for index in "${!checks[@]}"; do
  (( index == 0 )) || printf ','
  printf '"%s"' "${checks[$index]}"
done
printf '],"checkCount":%s}\n' "${#checks[@]}"
