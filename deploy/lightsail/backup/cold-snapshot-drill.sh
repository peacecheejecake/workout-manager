#!/usr/bin/env bash
# Opt-in, host-only cold physical PostgreSQL snapshot and isolated old-app rehearsal.
# Install at /srv/workout-manager/admin/cold-snapshot-drill.sh as root:0700.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
exec 3>&2 2>/dev/null

phase=GUARD
root=/srv/workout-manager
source_dir=$root/data/postgres
private_dir=$root/data/private
snapshot_root=$root/backups/cold-postgres
lock_root=/run/lock/workout-manager
config=$root/admin/backup/fence.json
checker=$root/admin/backup/check-fence.mjs
node_bin=$root/backup-runtime/20261001-9babcea-node24/node
compose_file=$root/source/deploy/lightsail/compose.yml
pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
app_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c
system_id=7690725883185365030
snapshot=
snapshot_data=
scratch=
run_id=
clone_db=
clone_app=
clone_setup=
clone_net=
app_id=
pg_id=
graph_id=
app_was_running=0
pg_was_running=0
graph_was_running=0
app_stopped=0
pg_stopped=0
graph_stopped=0
clone_db_created=0
clone_app_created=0
clone_setup_created=0
clone_net_created=0
cleanup_failed=0
snapshot_complete=0
snapshot_created=0
policies_touched=0

fail() { return 1; }
quiet() { "$@" >/dev/null 2>&1; }
root_file() { [[ -f $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
root_directory() { [[ -d $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
docker_short() { /usr/bin/timeout --signal=TERM --kill-after=30s 60s /usr/bin/docker --host unix:///var/run/docker.sock "$@"; }
docker_long() { /usr/bin/timeout --signal=TERM --kill-after=30s 35m /usr/bin/docker --host unix:///var/run/docker.sock "$@"; }
private_empty() { local first; first=$(find "$private_dir" -mindepth 1 -print -quit) || return 1; [[ -z $first ]]; }
no_tablespaces() { local first; first=$(find "$source_dir/pg_tblspc" -mindepth 1 -print -quit) || return 1; [[ -z $first ]]; }
no_unsafe_entries() { local first; first=$(find "$1" -xdev \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit) || return 1; [[ -z $first ]]; }
source_mount_only() {
  local targets mount
  [[ $(findmnt -T "$source_dir" -n -o FSTYPE) == ext4 ]] || return 1
  [[ $(findmnt -T "$source_dir" -n -o TARGET) == / ]] || return 1
  targets=$(findmnt -r -n -o TARGET) || return 1
  while IFS= read -r mount; do
    [[ $mount != "$source_dir" && $mount != "$source_dir/"* ]] || return 1
  done <<< "$targets"
}
no_symlink_parents() {
  local path=$1
  while [[ $path != / ]]; do [[ ! -L $path ]] || return 1; path=${path%/*}; [[ -n $path ]] || path=/; done
}
check_503() {
  local response
  response=$(/usr/bin/curl --silent --show-error --max-time 10 --max-filesize 4096 --noproxy '*' \
    --resolve workout.red-10-proto.xyz:443:127.0.0.1 --write-out $'\n%{http_code}' \
    https://workout.red-10-proto.xyz/) || return 1
  [[ $response == *'Workout Manager setup in progress'* && ${response##*$'\n'} == 503 ]]
}
timers_quiet() {
  local timer values
  for timer in workout-resource-cleanup.timer workout-course-thumbnails.timer; do
    values=$(systemctl show --no-page --property=LoadState,ActiveState,UnitFileState "$timer") || return 1
    [[ $values == *$'ActiveState=inactive'* ]] || return 1
    [[ $values == *$'LoadState=not-found'* || ( $values == *$'LoadState=loaded'* && ( $values == *$'UnitFileState=disabled'* || $values == *$'UnitFileState=masked'* ) ) ]] || return 1
  done
  for timer in resource_cleanup course_thumbnails; do
    values=$(systemctl show --no-page --property=LoadState,ActiveState "workout-maintenance@${timer}.service") || return 1
    [[ $values == *$'ActiveState=inactive'* && ( $values == *$'LoadState=loaded'* || $values == *$'LoadState=not-found'* ) ]] || return 1
  done
}
config_intact() {
  root_file "$config" 600 && root_file "$checker" 700 && root_file "$node_bin" 700 &&
    [[ $(stat -c '%d:%i:%s' "$config") == "$config_identity" ]] &&
    [[ $(sha256sum "$config" | awk '{print $1}') == "$config_hash" ]] &&
    [[ $(sha256sum "$compose_file" | awk '{print $1}') == "$compose_hash" ]]
}
identity() {
  local service=$1 id=$2 expected_image=$3 expected_state=$4 got
  got=$(docker_short inspect -f '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "$id") || return 1
  [[ $got == "$id|$expected_image|workout-manager|$service|$compose_file|$expected_state|no" ]]
}
control_clean() {
  local dir=$1 info
  info=$(docker_short run --rm --network none --entrypoint pg_controldata \
    --mount "type=bind,src=$dir,dst=/var/lib/postgresql/data,readonly" \
    "$pg_image" /var/lib/postgresql/data) || return 1
  [[ $info == *"Database system identifier:           $system_id"* &&
     $info == *'Database cluster state:               shut down'* ]]
}
# Compare every relative path, file type, mode, owner, group, size, mtime and file SHA-256.
# fsync the destination files and directories before publishing a snapshot.
tree_compare() {
  /usr/bin/python3 - "$1" "$2" "$3" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path
left, right, do_sync = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == 'sync'
def inventory(root, sync):
    if sys.platform.startswith('linux') and not hasattr(os, 'listxattr'):
        raise ValueError('xattr inspection unavailable')
    entries = {}
    def walk(path):
        st = path.lstat()
        kind = 'd' if stat.S_ISDIR(st.st_mode) else 'f' if stat.S_ISREG(st.st_mode) else None
        if kind is None or st.st_nlink < 1:
            raise ValueError('unsafe entry')
        rel = str(path.relative_to(root))
        digest = ''
        if kind == 'f':
            h = hashlib.sha256()
            with path.open('rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    h.update(chunk)
                if sync:
                    os.fsync(f.fileno())
            digest = h.hexdigest()
        else:
            for child in sorted(path.iterdir()):
                walk(child)
            if sync:
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
        xattr_names = os.listxattr(path, follow_symlinks=False) if hasattr(os, 'listxattr') else []
        xattrs = tuple((name, os.getxattr(path, name, follow_symlinks=False))
                       for name in sorted(xattr_names))
        entries[rel] = (kind, stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid,
                        st.st_size if kind == 'f' else 0, st.st_mtime_ns, digest, xattrs)
    walk(root)
    return entries
try:
    assert inventory(left, False) == inventory(right, do_sync)
except (AssertionError, OSError, ValueError):
    sys.exit(1)
PY
}
original_verified() {
  config_intact && private_empty && source_mount_only && no_unsafe_entries "$source_dir" && no_tablespaces &&
    control_clean "$source_dir" &&
    { [[ $snapshot_complete == 0 ]] || { root_directory "$snapshot" 700 &&
      [[ -d $snapshot_data && ! -L $snapshot_data ]] && tree_compare "$source_dir" "$snapshot_data" verify; }; }
}
cleanup_container() {
  local name=$1 label
  label=$(docker_short inspect -f '{{index .Config.Labels "workout.cold-snapshot"}}' "$name") || { cleanup_failed=1; return; }
  [[ $label == "$run_id" ]] || { cleanup_failed=1; return; }
  quiet docker_short rm -f "$name" || cleanup_failed=1
}
cleanup() {
  local status=$? i state sql
  trap - EXIT INT TERM HUP
  set +e
  if (( clone_app_created )); then cleanup_container "$clone_app"; fi
  if (( clone_setup_created )); then cleanup_container "$clone_setup"; fi
  if (( clone_db_created )); then cleanup_container "$clone_db"; fi
  if (( clone_net_created )); then
    [[ $(docker_short network inspect -f '{{index .Labels "workout.cold-snapshot"}}' "$clone_net") == "$run_id" ]] &&
      quiet docker_short network rm "$clone_net" || cleanup_failed=1
  fi
  # Keep the bind source whenever a disposable container or network was not removed.
  if [[ -n $scratch ]]; then
    if (( !cleanup_failed )); then rm -rf -- "$scratch" || cleanup_failed=1;
    else printf 'COLD_SNAPSHOT_SCRATCH_RETAINED=%s\n' "$scratch" >&3; fi
  fi
  if (( snapshot_created && !snapshot_complete )) && [[ -n $snapshot && $snapshot == "$snapshot_root/"* ]]; then
    rm -rf -- "$snapshot" || cleanup_failed=1
  fi
  # The production app may start only after the original, not the clone, passes integrity and SQL checks.
  if (( pg_stopped )); then
    if original_verified && identity postgres "$pg_id" "$pg_image" false && check_503 && timers_quiet; then
      quiet docker_short start "$pg_id" || cleanup_failed=1
      state=
      for ((i=0; i<90; i++)); do
        state=$(docker_short inspect -f '{{.State.Health.Status}}' "$pg_id")
        [[ $state == healthy ]] && break
        [[ $state != unhealthy ]] || break
        sleep 1
      done
      [[ $state == healthy ]] || cleanup_failed=1
    else cleanup_failed=1; fi
  fi
  if (( app_stopped )); then
    sql=$(docker_short exec --user postgres "$pg_id" psql -X -qAt -d workout -c "SELECT (pg_control_system()).system_identifier::text='$system_id' AND current_setting('server_version_num')='170006' AND (SELECT count(*)=65 AND min(version)=1 AND max(version)=65 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations)" 2>/dev/null)
    if (( !cleanup_failed )) && [[ $sql == t ]] && identity app "$app_id" "$app_image" false && check_503; then
      quiet docker_short start "$app_id" || cleanup_failed=1
      state=
      for ((i=0; i<90; i++)); do
        state=$(docker_short inspect -f '{{.State.Health.Status}}' "$app_id")
        [[ $state == healthy ]] && break
        [[ $state != unhealthy ]] || break
        sleep 1
      done
      [[ $state == healthy ]] || cleanup_failed=1
    else cleanup_failed=1; fi
  fi
  if (( graph_stopped )); then
    if (( !cleanup_failed )) && identity graphhopper "$graph_id" "$graph_image" false; then
      quiet docker_short start "$graph_id" || cleanup_failed=1
      [[ $(docker_short inspect -f '{{.State.Running}}' "$graph_id") == true ]] || cleanup_failed=1
      state=closed
      for ((i=0; i<90; i++)); do
        if quiet docker_short exec "$app_id" node -e 'const n=require("node:net");const s=n.connect(8991,"127.0.0.1");s.setTimeout(2000);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))'; then
          state=open
          break
        fi
        sleep 1
      done
      [[ $state == open && $(docker_short inspect -f '{{.State.Running}}' "$graph_id") == true ]] || cleanup_failed=1
    else cleanup_failed=1; fi
  fi
  # Restore policies only after all intended service health gates passed; never enable auto-restart on uncertain state.
  if (( !cleanup_failed && policies_touched )); then
    for id in "$pg_id" "$app_id" "$graph_id"; do
      [[ -n $id ]] || { cleanup_failed=1; break; }
      state=$(docker_short inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$id") || { cleanup_failed=1; break; }
      if [[ $state == no ]]; then
        quiet docker_short update --restart unless-stopped "$id" || { cleanup_failed=1; break; }
      elif [[ $state != unless-stopped ]]; then cleanup_failed=1; break; fi
      state=$(docker_short inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$id") || { cleanup_failed=1; break; }
      [[ $state == unless-stopped ]] || { cleanup_failed=1; break; }
    done
  fi
  if (( cleanup_failed )); then printf 'COLD_SNAPSHOT_CLEANUP_FAILED\n' >&3; status=1; fi
  if (( status != 0 )); then printf 'COLD_SNAPSHOT_%s_FAILED\n' "$phase" >&3; fi
  if (( snapshot_complete )) && [[ -n $snapshot ]]; then printf 'COLD_SNAPSHOT_RETAINED=%s\n' "$snapshot"; fi
  if (( status == 0 )); then printf 'COLD_SNAPSHOT_REHEARSAL_PASSED\n'; fi
  exit "$status"
}
trap cleanup EXIT
trap 'phase=INTERRUPTED; exit 1' INT TERM HUP

[[ $# == 1 && $1 == --execute && $EUID == 0 ]] || fail
[[ $(realpath -e "$0") == "$root/admin/cold-snapshot-drill.sh" ]] || fail
root_file "$0" 700 || fail
for dir in /srv "$root" "$root/admin" "$root/admin/backup" "$root/backups" "$root/data"; do
  [[ -d $dir && ! -L $dir && $(stat -c %u "$dir") == 0 ]] || fail
done
root_directory "$root/backups" 700 || fail
[[ -d $private_dir && ! -L $private_dir ]] || fail
[[ -d $source_dir && ! -L $source_dir ]] || fail
no_symlink_parents "$source_dir" || fail
[[ ${WORKOUT_BACKUP_FENCE_CONFIG:-} == "$config" ]] || fail
root_file "$config" 600 || fail
root_file "$checker" 700 || fail
root_file "$node_bin" 700 || fail
root_directory "$lock_root" 700 || fail
root_file "$lock_root/backup.lock" 600 || fail
root_file "$lock_root/maintenance.lock" 600 || fail
for bin in docker timeout openssl flock stat python3 cp curl sync findmnt; do [[ -x /usr/bin/$bin ]] || fail; done
[[ $(docker_short image inspect -f '{{.Id}}' "$pg_image") == "$pg_image" ]] || fail
[[ $(docker_short image inspect -f '{{.Id}}' "$app_image") == "$app_image" ]] || fail
private_empty && source_mount_only && no_unsafe_entries "$source_dir" && no_tablespaces && timers_quiet && check_503 || fail
[[ $(df -Pk "$root/backups" | awk 'END {print $4}') -ge 2097152 ]] || fail

exec 8<"$lock_root/backup.lock"
flock -n 8 || fail
exec 9<"$lock_root/maintenance.lock"
flock -n 9 || fail
config_identity=$(stat -c '%d:%i:%s' "$config") || fail
config_hash=$(sha256sum "$config" | awk '{print $1}') || fail
compose_hash=$(sha256sum "$compose_file" | awk '{print $1}') || fail
app_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.app)' "$config") || fail
pg_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.postgres)' "$config") || fail
graph_id=$("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.containers.graphhopper)' "$config") || fail
for id in "$app_id" "$pg_id" "$graph_id"; do [[ $id =~ ^[a-f0-9]{64}$ ]] || fail; done
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.postgresSystemIdentifier)' "$config") == "$system_id" ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.composeSha256)' "$config") == "$compose_hash" ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.postgresVersionNum)' "$config") == 170006 ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.network)' "$config") == workout-manager_workout_internal ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.postgresDir)' "$config") == "$source_dir" ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.privateDir)' "$config") == "$private_dir" ]] || fail
[[ $("$node_bin" -e 'const c=require(process.argv[1]);process.stdout.write(c.composeFile)' "$config") == "$compose_file" ]] || fail
graph_image=$(docker_short inspect -f '{{.Image}}' "$graph_id") || fail
[[ $graph_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail
for pair in "app:$app_id:$app_image" "postgres:$pg_id:$pg_image" "graphhopper:$graph_id:$graph_image"; do
  IFS=: read -r service id image <<< "$pair"
  [[ $(docker_short inspect -f '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "$id") == "$id|$image|workout-manager|$service|$compose_file|true|unless-stopped" ]] || fail
done
app_was_running=1; pg_was_running=1; graph_was_running=1

phase=QUIESCE
# Disable Docker automatic restarts before the first stop; the EXIT handler keeps uncertain services disabled.
policies_touched=1
for id in "$graph_id" "$app_id" "$pg_id"; do
  quiet docker_short update --restart no "$id" || fail
  [[ $(docker_short inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$id") == no ]] || fail
done
graph_stopped=1
quiet docker_short stop --time 30 "$graph_id" || fail
app_stopped=1
quiet docker_short stop --time 30 "$app_id" || fail
[[ $("$node_bin" "$checker") == BACKUP_FENCE_CHECKED ]] || fail
private_empty && config_intact && timers_quiet && check_503 || fail
docker_ids_before=$(docker_short ps --all --no-trunc --quiet | sort) || fail
phase=STOP_PG
pg_stopped=1
quiet docker_short stop --time 60 "$pg_id" || fail
identity postgres "$pg_id" "$pg_image" false || fail
identity app "$app_id" "$app_image" false || fail
identity graphhopper "$graph_id" "$graph_image" false || fail
[[ $(docker_short ps --all --no-trunc --quiet | sort) == "$docker_ids_before" ]] || fail
control_clean "$source_dir" && source_mount_only && no_unsafe_entries "$source_dir" && no_tablespaces || fail

phase=CAPTURE
if [[ ! -e $snapshot_root ]]; then mkdir -m 0700 -- "$snapshot_root" || fail; fi
root_directory "$snapshot_root" 700 || fail
run_id=$(openssl rand -hex 12) || fail
snapshot="$snapshot_root/$run_id"
snapshot_data="$snapshot/postgres"
[[ ! -e $snapshot ]] || fail
mkdir -m 0700 -- "$snapshot" || fail
snapshot_created=1
root_directory "$snapshot" 700 || fail
mkdir -m 0700 -- "$snapshot_data" || fail
/usr/bin/cp -a --reflink=never -- "$source_dir/." "$snapshot_data/" || fail
tree_compare "$source_dir" "$snapshot_data" sync || fail
sync -f "$snapshot" || fail
sync -f "$snapshot_root" || fail
sync -f "$root/backups" || fail
control_clean "$snapshot_data" && original_verified || fail
snapshot_complete=1

phase=CLONE
scratch=$(mktemp -d /tmp/wm-cold-snapshot.XXXXXXXX) || fail
chmod 0700 "$scratch"
mkdir -m 0700 "$scratch/pg" "$scratch/private"
chown 1000:1000 "$scratch/private"
/usr/bin/cp -a --reflink=never -- "$snapshot_data/." "$scratch/pg/" || fail
tree_compare "$snapshot_data" "$scratch/pg" sync || fail
control_clean "$scratch/pg" || fail
clone_net="wm-cold-${run_id}-net"
clone_db="wm-cold-${run_id}-db"
clone_app="wm-cold-${run_id}-app"
clone_setup="wm-cold-${run_id}-setup"
clone_net_created=1
quiet docker_short network create --internal --label "workout.cold-snapshot=$run_id" "$clone_net" || fail
clone_db_created=1
quiet docker_short run -d --name "$clone_db" --network "$clone_net" --network-alias wm-postgres \
  --label "workout.cold-snapshot=$run_id" --mount "type=bind,src=$scratch/pg,dst=/var/lib/postgresql/data" \
  "$pg_image" || fail
ready=0
for ((i=0; i<90; i++)); do
  if [[ $(docker_short exec "$clone_db" cat /proc/1/comm) == postgres ]] && \
    quiet docker_short exec "$clone_db" pg_isready -U postgres -d workout; then ready=1; break; fi
  sleep 1
done
(( ready )) || fail
clone_sql() { docker_short exec --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -qAt -d workout -c "$1"; }
[[ $(clone_sql "SELECT (pg_control_system()).system_identifier::text='$system_id' AND current_setting('server_version_num')='170006' AND (SELECT count(*)=65 AND min(version)=1 AND max(version)=65 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations)") == t ]] || fail
admin_password=$(openssl rand -hex 24)
owner_password=$(openssl rand -hex 24)
runtime_password=$(openssl rand -hex 24)
cleanup_password=$(openssl rand -hex 24)
thumbnail_password=$(openssl rand -hex 24)
ingestion_password=$(openssl rand -hex 24)
# These ALTER ROLE commands affect only the isolated cold-copy cluster.
quiet docker_short exec -i --user postgres "$clone_db" psql -X -v ON_ERROR_STOP=1 -q -d workout <<ROLES
ALTER ROLE postgres PASSWORD '${admin_password}';
ALTER ROLE workout_owner PASSWORD '${owner_password}';
ALTER ROLE workout_runtime PASSWORD '${runtime_password}';
ALTER ROLE workout_resource_cleanup_worker PASSWORD '${cleanup_password}';
ALTER ROLE workout_course_thumbnail_worker PASSWORD '${thumbnail_password}';
ALTER ROLE workout_resource_ingestion_worker PASSWORD '${ingestion_password}';
ROLES
cat > "$scratch/setup.env" <<SETUP
NODE_ENV=production
POSTGRES_BOOTSTRAP_URL=postgresql://postgres:${admin_password}@wm-postgres/workout
MIGRATION_DATABASE_URL=postgresql://workout_owner:${owner_password}@wm-postgres/workout
WORKOUT_RUNTIME_DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout
RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout
COURSE_THUMBNAIL_DATABASE_URL=postgresql://workout_course_thumbnail_worker:${thumbnail_password}@wm-postgres/workout
RESOURCE_URL_INGESTION_DATABASE_URL=postgresql://workout_resource_ingestion_worker:${ingestion_password}@wm-postgres/workout
SETUP
clone_setup_created=1
[[ $(docker_long run --name "$clone_setup" --network "$clone_net" --label "workout.cold-snapshot=$run_id" \
  --env-file "$scratch/setup.env" "$app_image" node --import tsx /app/deploy/lightsail/bootstrap-db.mjs) == DATABASE_SETUP_COMPLETE ]] || fail
[[ $(clone_sql "SELECT count(*)=65 AND min(version)=1 AND max(version)=65 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations") == t ]] || fail
[[ $(clone_sql "SELECT has_table_privilege('workout_runtime','public.consent','SELECT') AND NOT has_schema_privilege('workout_runtime','public','CREATE')") == t ]] || fail
phase=HEALTH_CLONE
clone_app_created=1
quiet docker_short run -d --name "$clone_app" --network "$clone_net" --label "workout.cold-snapshot=$run_id" \
  -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
  -e PUBLIC_ORIGIN=https://restore.invalid -e OIDC_ISSUER=https://idp.invalid \
  -e OIDC_CLIENT_ID=isolated -e OIDC_CLIENT_SECRET=isolated -e NODE_ENV=production \
  -e API_ORIGIN=http://127.0.0.1:4300 -e PORT=4300 \
  -e PRIVATE_RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
  --mount "type=bind,src=$scratch/private,dst=/var/lib/workout/private" "$app_image" || fail
healthy=0
for ((i=0; i<90; i++)); do
  state=$(docker_short inspect -f '{{.State.Health.Status}}' "$clone_app") || fail
  if [[ $state == healthy ]]; then healthy=1; break; fi
  [[ $state != unhealthy ]] || fail
  sleep 1
done
(( healthy )) || fail
original_verified && check_503 && timers_quiet || fail
phase=RESTORE_ORIGINAL
