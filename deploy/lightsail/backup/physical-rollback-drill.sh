#!/usr/bin/env bash
# Opt-in isolated physical rollback of a disposable copy of the retained cold cluster.
# Install at /srv/workout-manager/admin/physical-rollback-drill.sh, root:0700.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
exec 3>&2 2>/dev/null

phase=GUARD
snapshot=/srv/workout-manager/backups/cold-postgres/15eff9a95c86d1ca6f5e237d/postgres
pg_image=sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
old_image=sha256:902466cf07ac4814f5a2672e2458516aa0fe5a7e4ec682d608f19d2afaee245c
staged_tag=workout-manager/app:fa29723-staged
staged_image=sha256:e117f1042c3d7d9eed24ef830f3611260c0738bb5a595234589b1468d4399977
system_id=7690725883185365030
lock_root=/run/lock/workout-manager
label_key=workout.physical-rollback
scratch=
run_id=
net=
db=
setup=
app=
net_created=0
db_created=0
setup_created=0
app_created=0
db_stopped=0
restore_needed=0
restored=0
cleanup_failed=0
stage_ok=0

fail() { return 1; }
quiet() { "$@" >/dev/null 2>&1; }
docker_short() { /usr/bin/timeout --signal=TERM --kill-after=30s 60s /usr/bin/docker --host unix:///var/run/docker.sock "$@"; }
docker_long() { /usr/bin/timeout --signal=TERM --kill-after=30s 35m /usr/bin/docker --host unix:///var/run/docker.sock "$@"; }
root_file() { [[ -f $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
root_directory() { [[ -d $1 && ! -L $1 && $(stat -c '%u:%a' "$1") == "0:$2" ]]; }
no_symlink_parents() { local path=$1; while [[ $path != / ]]; do [[ ! -L $path ]] || return 1; path=${path%/*}; [[ -n $path ]] || path=/; done; }
no_unsafe_entries() { local first; first=$(find "$1" -xdev \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit) || return 1; [[ -z $first ]]; }
no_tablespaces() { local first; first=$(find "$snapshot/pg_tblspc" -mindepth 1 -print -quit) || return 1; [[ -z $first ]]; }
snapshot_mount_safe() {
  local targets mount
  [[ $(findmnt -T "$snapshot" -n -o TARGET) == / && $(findmnt -T "$snapshot" -n -o FSTYPE) == ext4 ]] || return 1
  targets=$(findmnt -r -n -o TARGET) || return 1
  while IFS= read -r mount; do
    [[ $mount != "$snapshot" && $mount != "$snapshot/"* ]] || return 1
  done <<< "$targets"
}
control_clean() {
  local info
  info=$(docker_short run --rm --network none --entrypoint pg_controldata \
    --mount "type=bind,src=$1,dst=/var/lib/postgresql/data,readonly" "$pg_image" /var/lib/postgresql/data) || return 1
  [[ $info == *"Database system identifier:           $system_id"* &&
     $info == *'Database cluster state:               shut down'* ]]
}
tree_compare() {
  /usr/bin/python3 - "$1" "$2" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path
if sys.platform.startswith('linux') and not hasattr(os, 'listxattr'): sys.exit(1)
def inventory(root):
    found = {}
    def walk(path):
        s = path.lstat()
        kind = 'd' if stat.S_ISDIR(s.st_mode) else 'f' if stat.S_ISREG(s.st_mode) else None
        if kind is None or s.st_nlink < 1: raise ValueError('unsafe entry')
        digest = ''
        if kind == 'f':
            h = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
            digest = h.hexdigest()
        else:
            for child in sorted(path.iterdir()): walk(child)
        xattrs = tuple((name, os.getxattr(path, name, follow_symlinks=False))
                       for name in sorted(os.listxattr(path, follow_symlinks=False))) if hasattr(os, 'listxattr') else ()
        if path != root:
            found[str(path.relative_to(root))] = (kind, stat.S_IMODE(s.st_mode), s.st_uid,
                s.st_gid, s.st_size if kind == 'f' else 0, s.st_mtime_ns, digest, xattrs)
    walk(root)
    return found
try:
    left = inventory(Path(sys.argv[1]))
    if sys.argv[2] == '-': print(hashlib.sha256(repr(sorted(left.items())).encode()).hexdigest())
    elif left != inventory(Path(sys.argv[2])): sys.exit(1)
except (OSError, ValueError): sys.exit(1)
PY
}
snapshot_intact() {
  [[ -d $snapshot && ! -L $snapshot && $(stat -c '%a' "$snapshot") == 700 ]] && no_symlink_parents "$snapshot" &&
    [[ $(stat -c '%d:%i' "$snapshot") == "$snapshot_identity" ]] &&
    snapshot_mount_safe && no_unsafe_entries "$snapshot" && no_tablespaces && control_clean "$snapshot" &&
    [[ $(tree_compare "$snapshot" -) == "$snapshot_digest" ]]
}
clone_identity() {
  local got
  got=$(docker_short inspect -f '{{.Id}}|{{.Image}}|{{index .Config.Labels "workout.physical-rollback"}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{range .Mounts}}{{.Type}}:{{.Source}}:{{.Destination}}:{{.RW}}{{end}}' "$db") || return 1
  [[ $got == "$db_id|$pg_image|$run_id|$net|no|bind:$scratch/pg:/var/lib/postgresql/data:true" ]]
}
clone_sql() { docker_short exec --user postgres "$db_id" psql -X -v ON_ERROR_STOP=1 -qAt -d workout -c "$1"; }
rotate_clone_roles() {
  # Local peer auth reaches only the isolated PostgreSQL container.
  quiet docker_short exec -i --user postgres "$db_id" psql -X -v ON_ERROR_STOP=1 -q -d workout <<ROLES
ALTER ROLE postgres PASSWORD '${admin_password}';
ALTER ROLE workout_owner PASSWORD '${owner_password}';
ALTER ROLE workout_runtime PASSWORD '${runtime_password}';
ALTER ROLE workout_resource_cleanup_worker PASSWORD '${cleanup_password}';
ALTER ROLE workout_course_thumbnail_worker PASSWORD '${thumbnail_password}';
ALTER ROLE workout_resource_ingestion_worker PASSWORD '${ingestion_password}';
ROLES
}
schema_is() {
  [[ $(clone_sql "SELECT (pg_control_system()).system_identifier::text='$system_id' AND current_setting('server_version_num')='170006' AND (SELECT count(*)=$1 AND min(version)=1 AND max(version)=$1 AND bool_and(checksum ~ '^[0-9a-f]{64}$') FROM public.schema_migrations)") == t ]]
}
wait_db() {
  local i
  for ((i=0; i<90; i++)); do
    if [[ $(docker_short exec "$db_id" cat /proc/1/comm) == postgres ]] &&
      quiet docker_short exec "$db_id" pg_isready -U postgres -d workout; then return 0; fi
    sleep 1
  done
  return 1
}
stop_clone() {
  clone_identity || return 1
  db_stopped=1
  quiet docker_short stop --time 60 "$db_id" || return 1
  [[ $(docker_short inspect -f '{{.State.Running}}' "$db_id") == false ]] && control_clean "$scratch/pg"
}
restore_clone() {
  # Docker retains the bind-source inode. Empty and refill only its children while stopped.
  [[ $restore_needed == 1 && $restored == 0 ]] || return 1
  if (( ! db_stopped )); then stop_clone || return 1; fi
  clone_identity && root_directory "$scratch" 700 &&
    [[ $(stat -c '%d:%i' "$scratch") == "$scratch_identity" ]] &&
    [[ -d $scratch/pg && ! -L $scratch/pg ]] &&
    [[ $(stat -c '%d:%i' "$scratch/pg") == "$bind_identity" ]] &&
    [[ $(docker_short inspect -f '{{.State.Running}}' "$db_id") == false ]] &&
    snapshot_intact || return 1
  find "$scratch/pg" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
  /usr/bin/cp -a --reflink=never -- "$snapshot/." "$scratch/pg/" || return 1
  sync -f "$scratch/pg" || return 1
  tree_compare "$snapshot" "$scratch/pg" && control_clean "$scratch/pg" && snapshot_intact || return 1
  [[ $(stat -c '%d:%i' "$scratch/pg") == "$bind_identity" ]] || return 1
  quiet docker_short start "$db_id" || return 1
  db_stopped=0
  wait_db && schema_is 65 || return 1
  restored=1
}
remove_container() {
  local got
  got=$(docker_short inspect -f '{{index .Config.Labels "workout.physical-rollback"}}' "$1") || { cleanup_failed=1; return; }
  [[ $got == "$run_id" ]] && quiet docker_short rm -f "$1" || cleanup_failed=1
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if (( restore_needed && !restored )); then phase=RESTORE; restore_clone || cleanup_failed=1; fi
  if (( app_created )); then remove_container "$app"; fi
  if (( setup_created )); then remove_container "$setup"; fi
  if (( db_created )); then remove_container "$db"; fi
  if (( net_created )); then
    [[ $(docker_short network inspect -f '{{index .Labels "workout.physical-rollback"}}' "$net") == "$run_id" ]] &&
      quiet docker_short network rm "$net" || cleanup_failed=1
  fi
  if [[ -n $scratch ]]; then
    if (( cleanup_failed )); then printf 'PHYSICAL_ROLLBACK_SCRATCH_RETAINED=%s\n' "$scratch" >&3
    elif [[ $scratch == /tmp/wm-physical-rollback.* && -n ${scratch_identity:-} ]] &&
      root_directory "$scratch" 700 && [[ $(stat -c '%d:%i' "$scratch") == "$scratch_identity" ]]; then
      rm -rf -- "$scratch" || cleanup_failed=1
    else cleanup_failed=1; fi
  fi
  if (( cleanup_failed )); then printf 'PHYSICAL_ROLLBACK_CLEANUP_FAILED\n' >&3; status=1; fi
  if (( status != 0 )); then printf 'PHYSICAL_ROLLBACK_%s_FAILED\n' "$phase" >&3
  else printf 'PHYSICAL_ROLLBACK_REHEARSAL_PASSED\n'; fi
  exit "$status"
}
trap cleanup EXIT
trap 'phase=INTERRUPTED; exit 1' INT TERM HUP

[[ ( $# == 1 && $1 == --execute ) || ( $# == 2 && $1 == --execute && $2 == --inject-post-migration-failure ) ]] || fail
[[ $EUID == 0 && $(realpath -e "$0") == /srv/workout-manager/admin/physical-rollback-drill.sh ]] || fail
root_file "$0" 700 || fail
for dir in /srv/workout-manager/backups /srv/workout-manager/backups/cold-postgres /srv/workout-manager/backups/cold-postgres/15eff9a95c86d1ca6f5e237d; do
  root_directory "$dir" 700 || fail
done
for dir in /srv /srv/workout-manager /srv/workout-manager/admin; do
  [[ -d $dir && ! -L $dir && $(stat -c %u "$dir") == 0 ]] || fail
done
[[ -d $snapshot && ! -L $snapshot && $(stat -c '%a' "$snapshot") == 700 ]] || fail
root_directory "$lock_root" 700 || fail
root_file "$lock_root/backup.lock" 600 || fail
root_file "$lock_root/maintenance.lock" 600 || fail
for bin in docker timeout openssl flock stat python3 cp findmnt sync; do [[ -x /usr/bin/$bin ]] || fail; done
[[ $(docker_short image inspect -f '{{.Id}}' "$pg_image") == "$pg_image" ]] || fail
[[ $(docker_short image inspect -f '{{.Id}}' "$old_image") == "$old_image" ]] || fail
[[ $(docker_short image inspect -f '{{.Id}}' "$staged_tag") == "$staged_image" ]] || fail
exec 8<"$lock_root/backup.lock"
flock -n 8 || fail
exec 9<"$lock_root/maintenance.lock"
flock -n 9 || fail
snapshot_identity=$(stat -c '%d:%i' "$snapshot") || fail
snapshot_digest=$(tree_compare "$snapshot" -) || fail
snapshot_intact || fail
[[ $(df -Pk /tmp | awk 'END {print $4}') -ge 2097152 ]] || fail

phase=CLONE
scratch=$(mktemp -d /tmp/wm-physical-rollback.XXXXXXXX) || fail
root_directory "$scratch" 700 || fail
scratch_identity=$(stat -c '%d:%i' "$scratch") || fail
mkdir -m 0700 "$scratch/pg" "$scratch/private" || fail
chown 1000:1000 "$scratch/private" || fail
bind_identity=$(stat -c '%d:%i' "$scratch/pg") || fail
/usr/bin/cp -a --reflink=never -- "$snapshot/." "$scratch/pg/" || fail
tree_compare "$snapshot" "$scratch/pg" && control_clean "$scratch/pg" && snapshot_intact || fail
run_id=$(openssl rand -hex 12) || fail
net="wm-physical-${run_id}-net"
db="wm-physical-${run_id}-db"
setup="wm-physical-${run_id}-setup"
app="wm-physical-${run_id}-app"
net_created=1
quiet docker_short network create --internal --label "$label_key=$run_id" "$net" || fail
db_created=1
db_id=$(docker_short run -d --name "$db" --network "$net" --network-alias wm-postgres --label "$label_key=$run_id" \
  --mount "type=bind,src=$scratch/pg,dst=/var/lib/postgresql/data" "$pg_image") || fail
[[ $db_id =~ ^[a-f0-9]{64}$ ]] && clone_identity && wait_db && schema_is 65 || fail

# Only the disposable cluster receives new passwords; no live env file is read.
admin_password=$(openssl rand -hex 24)
owner_password=$(openssl rand -hex 24)
runtime_password=$(openssl rand -hex 24)
cleanup_password=$(openssl rand -hex 24)
thumbnail_password=$(openssl rand -hex 24)
ingestion_password=$(openssl rand -hex 24)
rotate_clone_roles || fail
cat > "$scratch/setup.env" <<SETUP
NODE_ENV=production
POSTGRES_BOOTSTRAP_URL=postgresql://postgres:${admin_password}@wm-postgres/workout
MIGRATION_DATABASE_URL=postgresql://workout_owner:${owner_password}@wm-postgres/workout
WORKOUT_RUNTIME_DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout
RESOURCE_CLEANUP_DATABASE_URL=postgresql://workout_resource_cleanup_worker:${cleanup_password}@wm-postgres/workout
COURSE_THUMBNAIL_DATABASE_URL=postgresql://workout_course_thumbnail_worker:${thumbnail_password}@wm-postgres/workout
RESOURCE_URL_INGESTION_DATABASE_URL=postgresql://workout_resource_ingestion_worker:${ingestion_password}@wm-postgres/workout
SETUP

phase=STAGED_SETUP
restore_needed=1
setup_created=1
if [[ $(docker_long run --name "$setup" --network "$net" --label "$label_key=$run_id" \
  --env-file "$scratch/setup.env" "$staged_image" node --import tsx /app/deploy/lightsail/bootstrap-db.mjs) == DATABASE_SETUP_COMPLETE ]] &&
  schema_is 93; then stage_ok=1; fi
# Simulate a post-migration failure before recovery, then still verify the old stack.
injected_failure=0
if (( stage_ok )) && [[ $# == 2 ]]; then injected_failure=1; fi
phase=RESTORE
restore_clone || fail
(( stage_ok )) || fail
phase=OLD_SETUP
rotate_clone_roles || fail
remove_container "$setup"
(( !cleanup_failed )) || fail
setup_created=0
setup_created=1
[[ $(docker_long run --name "$setup" --network "$net" --label "$label_key=$run_id" \
  --env-file "$scratch/setup.env" "$old_image" node --import tsx /app/deploy/lightsail/bootstrap-db.mjs) == DATABASE_SETUP_COMPLETE ]] || fail
schema_is 65 || fail
phase=OLD_HEALTH
app_created=1
quiet docker_short run -d --name "$app" --network "$net" --label "$label_key=$run_id" \
  -e "DATABASE_URL=postgresql://workout_runtime:${runtime_password}@wm-postgres/workout" \
  -e PUBLIC_ORIGIN=https://restore.invalid -e OIDC_ISSUER=https://idp.invalid \
  -e OIDC_CLIENT_ID=isolated -e OIDC_CLIENT_SECRET=isolated -e NODE_ENV=production \
  -e API_ORIGIN=http://127.0.0.1:4300 -e PORT=4300 \
  -e PRIVATE_RESOURCE_STORAGE_ROOT=/var/lib/workout/private \
  --mount "type=bind,src=$scratch/private,dst=/var/lib/workout/private" "$old_image" || fail
healthy=0
for ((i=0; i<90; i++)); do
  state=$(docker_short inspect -f '{{.State.Health.Status}}' "$app") || fail
  if [[ $state == healthy ]]; then healthy=1; break; fi
  [[ $state != unhealthy ]] || fail
  sleep 1
done
(( healthy )) && schema_is 65 && snapshot_intact || fail
if (( injected_failure )); then phase=INJECTED_FAILURE; fail; fi
