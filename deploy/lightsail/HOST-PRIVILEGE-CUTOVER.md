# Shared Lightsail privilege cutover (prepared, not executed)

## Read-only UID cutover preflight

`maintenance/preflight-uid-cutover.mjs` is a root-only, read-only host check. Install
it at `/srv/workout-manager/admin/preflight-uid-cutover.mjs` as root:root mode
0700 from the reviewed release. Its `--check` mode does not stop containers,
change ownership, or start a backup. A successful `local_checks_passed` result
does **not** certify the snapshot, recovery access, image runtime probes, or
the transition below. Run it only after the reviewed release has been installed
at the fixed `/srv/workout-manager/source` path as a root-owned tree with no
group/other writable entries. Keep the prior source copy outside that path for
rollback. Never build from the old `ubuntu`-writable source.
The preserved UID-1000-owned source is rollback input only. Before rollback,
copy it into a separate root-controlled staging directory on the same
filesystem; reject symlinks and descendant mounts, set every entry to
root:root, remove group/other write while retaining image-build read/traverse
access, and verify the full file manifest and old Compose SHA. Only that
verified root-owned copy may replace the fixed source. Never restore the
UID-1000-owned copy directly or run root Compose against it.
The current host's `/srv/workout-manager/source` is UID 1000-owned; therefore
the first run **must** fail until installation is complete. Under the proven
recovery administrator, stage the reviewed candidate outside the fixed source,
verify its full file list and hashes, reject symlinks and descendant mounts,
then set its owner/group to root:root without following symlinks and remove
group/other write permission. Make `/srv/workout-manager` root:root with no
group/other write while retaining the traversal mode required by services.
Before replacing the fixed source or either SHA pin, disable both maintenance
timers, verify no one-shot job is active, and hold the backup and maintenance
locks in that order. Exclude other manual root writers through this interval.
Release the locks only after the source, `compose.env`, and both pins agree;
the read-only preflight then reacquires each lock to check availability.
Require `/srv/workout-manager/data` and every parent of `private` and `routing`
through `/srv/workout-manager` to be root:root, non-symlink directories without
group/other write permission. The observed mode of both parents is 0755. UID
1000 must not be able to rename or recreate either data-tree root. Recheck
these parents before and after changing tree ownership and after service
restart; the preflight checks them before transition. At each later checkpoint,
record `stat -c '%u:%g %a %n' /srv/workout-manager
/srv/workout-manager/data` and `namei -l` for both tree paths, and abort if
either parent ceases to be root:root or becomes group/other writable.
Move the old source to a root-only rollback directory and move the prepared
candidate into the fixed source path in the same filesystem. Verify the fixed
path, parent ownership, Compose hash and file modes again. Keep the old copy
unchanged. Do not run the preflight against the staging path or a symlink.

Prepare `/srv/workout-manager/admin/uid-cutover.json` as root:root mode 0600
with **exactly** these fields (all image IDs and hashes are 64 lowercase hex
digits without a `sha256:` prefix):

```json
{
  "schemaVersion": 1,
  "composeSha256": "<sha256sum of installed source/deploy/lightsail/compose.yml>",
  "writerSha256": "<sha256sum of installed admin/run-host-writer.mjs>",
  "postgresContainerId": "<full existing Workout PostgreSQL container ID>",
  "oldAppImageId": "<full old app image ID>",
  "oldGraphhopperImageId": "<full old GraphHopper image ID>",
  "candidateAppImageId": "<full reviewed candidate app image ID>",
  "candidateGraphhopperImageId": "<full reviewed candidate GraphHopper image ID>",
  "snapshotId": "<verified available instance snapshot ID, wm-...>"
}
```

The operator must verify the snapshot ID and recovery login independently;
the script only validates the snapshot ID's syntax. The 2026-10-03 read-only
audit found `wm-pre-recovery-20261003` available and a separate `wm-recovery`
SSH/root session working. Reconfirm freshness and recovery suitability for
this cutover; if another snapshot is needed, assess its cost and wait for
availability before changing ownership. The pin file contains no secrets but
must remain root-only to prevent release substitution. Pin
`WORKOUT_RELEASE` in root-only `/srv/workout-manager/compose.env`, inspect the
rendered base Compose, and prove that its app/GraphHopper tags resolve to the
candidate IDs. The Dockerfiles record named image users (`workout:workout`,
`graphhopper:graphhopper`), while Compose sets numeric runtime users. Run
disposable `id -u`/`id -g` probes for both images and verify 20001/20002,
then inspect the rendered Compose `user` fields before changing ownership.
Keep `compose.logical-wal.yml` out of every command below.

The installed host writer has its own root:root mode-0600 pin at
`/srv/workout-manager/admin/host-writer.json`. Its exact schema is
`{"schemaVersion":1,"composeSha256":"<64 lowercase hex>"}`. Preserve the old
file with the old source and `compose.env`. Once the candidate source is at
the fixed path, prepare a candidate pin as a root:root mode-0600 temporary
file **in the same admin directory**, containing the candidate Compose SHA.
Validate its two-field JSON and atomically replace the installed pin with
`mv -T /srv/workout-manager/admin/host-writer.json.next
/srv/workout-manager/admin/host-writer.json` (the `.next` file must already be
root:root mode 0600). Exclude writer invocations during the brief source/pin replacement
interval. Recheck that `host-writer.json`, `uid-cutover.json`, and the installed
Compose bytes all have the same SHA. The preflight rejects a mismatch. During
rollback, atomically restore the old writer pin with the old source and verify
it against the restored Compose before any writer call.

```sh
# In the separately proven recovery root shell; do not assume generic sudo rights.
/usr/bin/node /srv/workout-manager/admin/preflight-uid-cutover.mjs --check
```

The check requires both maintenance timers disabled/inactive, both locks
available, exactly the three expected Workout containers, original healthy
PostgreSQL with `wal_level=replica`, old app/GraphHopper images still running,
and `HostConfig.RestartPolicy` equal to `unless-stopped` with retry count zero
for all three. Record the exact three original policy values before changing
any of them; unexpected policy values fail the preflight and require a
separately reviewed plan. It also requires candidate images with their expected
named `Config.User`, unclaimed 20001/20002 host IDs,
root-owned non-writable installed source, and current 1000-owned private and
routing trees. It also checks root-owned, non-writable data parents and the
installed host writer pin against the candidate Compose SHA. It rejects
symlinks and nested mounts in those trees. A mount at
the root of a data tree is allowed, but the operator must verify its source,
device and persistence. It bounds its walk at 100,000 entries per tree; an
oversized tree needs a separately reviewed inspection method. It intentionally
does not inspect or modify the apex site's containers or data.

## Exact manual transition after preflight

Run this sequence as the separately tested recovery administrator, with the
public Workout 503 block active and the `ubuntu` session retained only until
independent root access is proven. Record each command's result. Stop at any
failed assertion; do not continue to the next numbered step.

1. Reconfirm snapshot availability and suitability, recovery SSH/root access,
   image IDs, Compose hash, disk headroom, root-owned source, rendered release
   tags, and absence of live one-shot jobs. Preserve a copy of the old source, old image IDs,
   installed Compose, root-only pin file, and the data-tree ownership listing.
   Verify the installed writer's `start postgres`, `up app`, and `up
graphhopper` command paths, including `--no-deps`. Disable both maintenance
   timers (`systemctl disable --now workout-resource-cleanup.timer
workout-course-thumbnails.timer`), and verify `is-active` is `inactive`.
   Disconnect backup scheduling and exclude any other manual root writer. Then
   run the preflight immediately before the transition.
2. In a root shell, acquire the backup lock and then the maintenance lock with
   nested nonblocking GNU `flock` processes. Keep the lock-holding shell alive
   through all stops, identity changes and the ownership walk. Example lock
   entry (run the following stop/ownership commands **inside** this shell):

   ```sh
   /usr/bin/flock --nonblock --conflict-exit-code 75 /run/lock/workout-manager/backup.lock \
     /usr/bin/flock --nonblock --conflict-exit-code 75 /run/lock/workout-manager/maintenance.lock \
     /bin/bash --noprofile --norc
   ```

   Record the exact three Workout container IDs and each
   `HostConfig.RestartPolicy` with `docker inspect`. All three must be
   `unless-stopped` with retry count zero, matching the preflight. Set
   their restart policies to `no` with `docker update --restart=no` by those
   **full pinned IDs** and inspect all three again to prove `no`. Stop only
   the pinned GraphHopper, app, then PostgreSQL
   IDs (`docker stop <graphhopper-id> <app-id>`, then `docker stop
<postgres-id>`). Verify all three `State.Running=false`, no replacement
   Workout container, and unchanged apex containers before changing any file.

3. While still holding both locks, remove `ubuntu`'s passwordless sudo grant
   from `/etc/sudoers.d/90-cloud-init-users`, its sudo/docker/lxd memberships,
   and any other effective grant; retain the already tested recovery sudo
   path. Run `visudo -c`, inspect `sudo -l -U ubuntu`, terminate existing
   `ubuntu` sessions, and verify a **new** `ubuntu` login cannot use sudo,
   Docker or LXD. Existing UID 1000 still owns the data tree: deny new direct
   access by changing each top-level `private` and `routing` directory to
   root:root mode 0700 before the recursive walk. Keep all app writers stopped.
4. Recheck each tree has no symlink or nested mount and compare its mount
   identity with the recorded value. Recheck that `/srv/workout-manager/data`
   and every parent through `/srv/workout-manager` remain root:root without
   group/other write; UID 1000 must not be able to replace either tree root.
   With the lock shell and recovery session
   still exclusive, change only the two Workout trees: use GNU `find
/srv/workout-manager/data/private -xdev -depth -exec chown --no-dereference
20001:20001 {} +` and the same command for `routing` with 20002:20002.
   The top-level root-owned gate prevents UID 1000 from racing the walk.
   Restore the routing directory's recorded 0755 traversal mode (`chmod 0755
/srv/workout-manager/data/routing`) after changing its owner so UID 20001
   can read the bind; do not leave the temporary 0700 gate on routing. Preserve
   the recorded restrictive private modes. Check nested routing files remain
   readable by 20001 and writable only by 20002/root.
   Recheck **every** entry's numeric owner/group, symlink/mount absence,
   private mode restrictions, routing read access for UID 20001, and unchanged
   PostgreSQL owner. Recheck protected parents before releasing either lock.
   If any command fails, keep all services stopped and use
   the rollback below.
5. Exit the lock-holding shell, confirming both locks are released. This is a
   controlled gap: both timers remain disabled and no backup/manual writer
   may start. Use the reviewed installed host writer's `start postgres`, check
   the exact pinned PostgreSQL container ID, health and `SHOW wal_level`
   (`replica`); then `up app`, check again; then `up graphhopper`, check again.
   Each writer call acquires both locks itself. Abort on an unexpected
   container/image ID, WAL level, new writer, failed health check or changed
   503/apex behavior. Never use `up postgres`, `down`, or the logical WAL
   override in this transition. After all three are healthy, reacquire both
   locks in the same order. Restore `unless-stopped` on the **original pinned
   PostgreSQL ID** with `docker update --restart=unless-stopped
<pinned-postgres-id>`; verify its ID and restart policy by inspect. Verify
   the recreated app and GraphHopper policies are also `unless-stopped` with
   retry count zero, restoring each with `docker update --restart=unless-stopped
<current-verified-id>` if needed. Inspect all three again before releasing
   the locks. If any policy restore or inspect fails, set any changed policy
   back to `no` where possible, stop all Workout writers, keep timers disabled
   and report an incomplete transition; do not claim success or leave a
   running PostgreSQL with an unverified restart policy.
6. Probe private create/read/delete under the real 20001 app/worker identity
   and routing write under 20002, plus routing read under 20001. Verify frozen
   Compose and candidate image IDs, all service health, all three restored
   restart policies, root-owned source,
   protected data parents, 503/apex behavior, and denied `ubuntu` direct
   access in a new session.
   Keep timers and public 503 unchanged until the separate backup and release
   gates pass.

**Rollback before new application writes:** reacquire both locks, disable
restart policies, stop only the Workout app and GraphHopper, then PostgreSQL;
verify all are stopped. Inspect for partial writes. If no new writes occurred,
restore the private/routing trees to their recorded UID/GID 1000 and modes
with the same top-level root gate and symlink/mount checks. Create and fully
verify the root-owned immutable rollback source from the preserved old copy
as described above. Move the candidate source aside and install only that
verified rollback source at the fixed path by root-controlled same-filesystem
rename. Restore the preserved old root-only `compose.env` to its fixed path;
atomically restore the preserved old `host-writer.json` in the same admin
directory. Move the candidate `uid-cutover.json` to the root-only candidate
archive so its SHA cannot be mistaken for the active release; do not leave a
stale active cutover pin. Verify the restored host writer SHA pin against the
restored Compose bytes, the old `WORKOUT_RELEASE` against the old image IDs,
and the root-owned source tree
before any Compose command. Recheck the protected data parents and exact prior
source/env hashes. Use the **old** Compose and old release tag,
not the candidate Compose with its 20001/20002 `user` overrides. Verify the
old tags still resolve to the pinned old image IDs (`docker image inspect
workout-manager/app:<old-release>` and the GraphHopper equivalent); if a tag
was moved, restore it with `docker image tag sha256:<pinned-old-id>
workout-manager/app:<old-release>` (GraphHopper analog), then reinspect. Start
only the pinned existing PostgreSQL container (`docker start
<pinned-postgres-id>`), assert exact ID, health and `wal_level=replica`, and
recreate only app and GraphHopper with the restored old files:

Keep both locks held through this direct Compose command and the subsequent
identity and health checks; release them only after rollback verification.

```sh
/usr/bin/docker --host unix:///var/run/docker.sock compose \
  --project-name workout-manager --env-file /srv/workout-manager/compose.env \
  -f /srv/workout-manager/source/deploy/lightsail/compose.yml \
  up -d --no-deps --force-recreate app graphhopper
```

Verify the old image IDs, PostgreSQL ID, `wal_level=replica`, health, 503 and
apex. Restore `unless-stopped` on the pinned original PostgreSQL ID and verify
its exact ID and `HostConfig.RestartPolicy`. Inspect the recreated old app and
GraphHopper policies and restore `unless-stopped` if needed; verify all three
policies and retry counts before releasing either lock. If any policy update
or inspect fails, stop all Workout writers and keep the locks/timers controlled
for recovery; rollback is incomplete. The restored host writer pin must match the restored Compose before any
later writer call; direct root Compose above is confined
to the held locks and recovery procedure. If there are new writes or any
uncertain partial state, **do not** copy an older snapshot over the live data;
leave services stopped and investigate/reconcile under the recovery plan.
Rollback of image/data ownership does not silently reinstate `ubuntu` sudo,
Docker or LXD privileges. Keep the recovery administrator available.

The current host runs `ubuntu` as UID/GID 1000. The app and GraphHopper images
also run as `node` (numeric UID/GID 1000). The private bind source is owned by
1000:1000 with mode 0700, and the routing source is owned by 1000:1000. The
`ubuntu` account has broad passwordless sudo and belongs to `docker` and `lxd`.
These facts make advisory backup locks an insufficient write fence. On
2026-10-02, `getent` found no host user or group using 20001 or 20002. Recheck
immediately before cutover; this observation does not reserve those IDs.

The prepared image/Compose target is app and all private-writing one-shot
workers at fixed UID/GID 20001; GraphHopper at 20002. `db_setup` uses the app
image identity but has no private bind. `ledger_export` is an explicit root
exception with a read-only filesystem and secret key mounts; review that
exception separately. A Dockerfile `USER` line alone does not change ownership
of existing bind sources or restrict an administrator with Docker access.

## Current procedure

The preflight, exact manual transition, and rollback above replace the earlier
preconditions and controlled-transition draft. In particular, the recovery
administrator and denial of `ubuntu` sudo/Docker/LXD access must be verified
**before** changing data-tree ownership; postponing privilege removal until
after service restart would leave UID 1000 able to bypass the ownership fence.
Use only the ordered procedure above for a cutover.

## Evidence required before a fresh backup claim

Record the exact snapshot ID, reviewed release/image/Compose hashes, numeric
host/container identities, ownership before and after, independent recovery
login, denied `ubuntu` bypass attempts, healthy app/worker writes, both locks,
service transitions and rollback result. Then execute the root-only backup
window with concurrent-writer and restart-failure drills, S3 upload, independent
deletion-ledger tail and a separate restore test. The installation and this
plan are **not_executed** evidence for those operations. Do not change their
status to passed based on Dockerfile, Compose, or documentation checks.
