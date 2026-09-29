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
retained_tenant='11111111-1111-4111-8111-111111111111'
erased_tenant='22222222-2222-4222-8222-222222222222'
queued_key="private/v1/tenants/${retained_tenant}/resources/33333333-3333-4333-8333-333333333333/temporary/44444444-4444-4444-8444-444444444444"
erased_key="private/v1/tenants/${erased_tenant}/resources/55555555-5555-4555-8555-555555555555/temporary/66666666-6666-4666-8666-666666666666"
control_key="private/v1/tenants/${retained_tenant}/resources/77777777-7777-4777-8777-777777777777/temporary/88888888-8888-4888-8888-888888888888"

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
for key in "$queued_key" "$erased_key" "$control_key"; do
  mkdir -p "$(dirname "$directory/private-source/$key")"
done
printf 'synthetic-abandoned-object-v1\n' > "$directory/private-source/$queued_key"
printf 'synthetic-erased-rowless-object-v1\n' > "$directory/private-source/$erased_key"
printf 'synthetic-retained-control-v1\n' > "$directory/private-source/$control_key"
control_hash=$(sha256sum "$directory/private-source/$control_key" | cut -d ' ' -f 1)

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
    # The official image briefly starts a bootstrap server, then stops it before PID 1
    # execs the final postmaster. Readiness during that first window is not stable.
    if [[ $(docker exec "$name" cat /proc/1/comm 2>/dev/null) == postgres ]] && \
      docker exec "$name" pg_isready -U postgres -d workout >/dev/null 2>&1; then return; fi
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
  docker exec -e "PGPASSWORD=$postgres_password" "$name" \
    psql -X -v ON_ERROR_STOP=1 -qAt -h 127.0.0.1 -U postgres -d workout -c "$sql"
}

psql_runtime() {
  local name=$1 sql=$2
  docker exec -e "PGPASSWORD=$runtime_password" "$name" \
    psql -X -v ON_ERROR_STOP=1 -qAt -h 127.0.0.1 -U workout_runtime -d workout -c "$sql"
}

start_db "$source_db" "$source_net" "$source_volume"
setup_db "$source_net"
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='${retained_tenant}'; INSERT INTO consent VALUES ('${retained_tenant}','app',true,1); COMMIT;" >/dev/null
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='${erased_tenant}'; INSERT INTO consent VALUES ('${erased_tenant}','app',true,1); COMMIT;" >/dev/null
psql_admin "$source_db" "INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at) VALUES ('99999999-9999-4999-8999-999999999999','${queued_key}','upload_abandoned',clock_timestamp(),clock_timestamp());" >/dev/null
docker exec -e "PGPASSWORD=$postgres_password" "$source_db" \
  pg_dump -Fc -h 127.0.0.1 -U postgres -d workout > "$directory/synthetic.dump"
docker exec -i "$source_db" pg_restore --list < "$directory/synthetic.dump" >/dev/null
checks+=(synthetic_dump_readable)

cp -a "$directory/private-source/." "$directory/private-restored/"
chown -R 1000:1000 "$directory/private-restored"
chmod 0700 "$directory/private-restored"
[[ -f "$directory/private-restored/$queued_key" && -f "$directory/private-restored/$erased_key" ]]
[[ $(sha256sum "$directory/private-restored/$control_key" | cut -d ' ' -f 1) == "$control_hash" ]]
checks+=(synthetic_private_archive_restored)

# Simulate a post-backup erasure. The independently captured ledger here contains only
# the fixed synthetic tenant UUID. Replay must precede any restored runtime access.
psql_runtime "$source_db" "BEGIN; SET LOCAL app.athlete_id='${erased_tenant}'; SELECT erase_account('${erased_tenant}'); COMMIT;" >/dev/null
[[ $(psql_admin "$source_db" "SELECT count(*) FROM tenant_erasure WHERE athlete_id='${erased_tenant}';") == 1 ]]
checks+=(post_backup_erasure_captured)

start_db "$restore_db" "$restore_net" "$restore_volume"
psql_admin "$restore_db" "CREATE ROLE workout_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${owner_password}'; ALTER DATABASE workout OWNER TO workout_owner; ALTER SCHEMA public OWNER TO workout_owner;" >/dev/null
docker exec -i -e "PGPASSWORD=$owner_password" "$restore_db" \
  pg_restore --exit-on-error --no-owner --no-acl -h 127.0.0.1 -U workout_owner -d workout \
  < "$directory/synthetic.dump" >/dev/null
setup_db "$restore_net"
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='${retained_tenant}';") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='${erased_tenant}';") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM resource_object_cleanup WHERE storage_ref='${queued_key}' AND completed_at IS NULL;") == 1 ]]
checks+=(owner_restore_and_setup)

psql_runtime "$restore_db" "BEGIN; SET LOCAL app.athlete_id='${erased_tenant}'; SELECT erase_account('${erased_tenant}'); COMMIT;" >/dev/null
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='${erased_tenant}';") == 0 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_erasure WHERE athlete_id='${erased_tenant}';") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_object_purge WHERE athlete_id='${erased_tenant}' AND completed_at IS NULL AND available_at<=clock_timestamp();") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM consent WHERE athlete_id='${retained_tenant}';") == 1 ]]
checks+=(erasure_replayed_before_runtime_rls)

docker run --rm --network "$restore_net" --label 'workout.synthetic-restore=1' \
  -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
  -e "SYNTHETIC_ERASED_TENANT=$erased_tenant" "$image" \
  node --import tsx --input-type=module -e '
    import { createDatabase, TenantErasedError } from "/app/packages/server/persistence/src/database.ts";
    const database = createDatabase({ connectionString: process.env.DATABASE_URL });
    try {
      try {
        await database.tenant(process.env.SYNTHETIC_ERASED_TENANT, (tx) => tx.query("SELECT 1"));
        throw new Error("ERASED_TENANT_WAS_ACCEPTED");
      } catch (error) {
        if (!(error instanceof TenantErasedError)) throw error;
      }
    } finally {
      await database.close();
    }
  '
checks+=(restored_runtime_rejects_erased_tenant)

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
[[ $(sha256sum "$directory/private-restored/$control_key" | cut -d ' ' -f 1) == "$control_hash" ]]
checks+=(restored_private_object_exact_bytes)
docker rm -f "$app" >/dev/null
docker restart "$restore_db" >/dev/null
for _ in {1..60}; do
  if docker exec "$restore_db" pg_isready -U postgres -d workout >/dev/null 2>&1; then break; fi
  sleep 1
done
start_app
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_erasure WHERE athlete_id='${erased_tenant}';") == 1 ]]
[[ $(sha256sum "$directory/private-restored/$control_key" | cut -d ' ' -f 1) == "$control_hash" ]]
checks+=(restored_database_restart_app_health_erasure_and_object)

run_worker() {
  docker run --rm --network "$restore_net" --label 'workout.synthetic-restore=1' \
    -e "RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout" \
    -e RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
    -v "$directory/private-restored:/var/lib/workout/private" \
    "$image" node --import tsx /app/apps/worker/src/resource-cleanup.ts
}

worker_first=$(run_worker)
printf '%s' "$worker_first" | node -e '
  let input=""; process.stdin.on("data", chunk => input+=chunk);
  process.stdin.on("end", () => {
    const report=JSON.parse(input);
    if(report.kind!=="resource_cleanup_result" || report.result.objects!=="completed" ||
      !report.result.tenantPurges.includes("passed")) process.exitCode=1;
  });
'
[[ ! -e "$directory/private-restored/$queued_key" && ! -e "$directory/private-restored/$erased_key" ]]
[[ $(sha256sum "$directory/private-restored/$control_key" | cut -d ' ' -f 1) == "$control_hash" ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM resource_object_cleanup WHERE storage_ref='${queued_key}' AND completed_at IS NOT NULL;") == 1 ]]
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_object_purge WHERE athlete_id='${erased_tenant}' AND passes=1 AND objects_purged>=1 AND last_error_code IS NULL;") == 1 ]]
checks+=(nonempty_queue_and_erased_tenant_prefix_purged_control_retained)

worker_second=$(run_worker)
printf '%s' "$worker_second" | node -e '
  let input=""; process.stdin.on("data", chunk => input+=chunk);
  process.stdin.on("end", () => {
    const report=JSON.parse(input);
    if(report.kind!=="resource_cleanup_result" || report.result.objects!=="empty" ||
      report.result.tenantPurges[0]!=="empty") process.exitCode=1;
  });
'
[[ $(psql_admin "$restore_db" "SELECT count(*) FROM tenant_object_purge WHERE athlete_id='${erased_tenant}' AND passes=1;") == 1 ]]
checks+=(second_worker_run_idempotent_and_empty)

printf '{"schemaVersion":1,"outcome":"passed","scope":"isolated synthetic Docker restore; no production backup or data","checks":['
for index in "${!checks[@]}"; do
  (( index == 0 )) || printf ','
  printf '"%s"' "${checks[$index]}"
done
printf '],"checkCount":%s}\n' "${#checks[@]}"
