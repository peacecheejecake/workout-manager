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
The current host's `/srv/workout-manager/source` is UID 1000-owned; therefore
the first run **must** fail until installation is complete. Under the proven
recovery administrator, stage the reviewed candidate outside the fixed source,
verify its full file list and hashes, reject symlinks and descendant mounts,
then set its owner/group to root:root without following symlinks and remove
group/other write permission. Make `/srv/workout-manager` root:root with no
group/other write while retaining the traversal mode required by services.
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

```sh
# In the separately proven recovery root shell; do not assume generic sudo rights.
/usr/bin/node /srv/workout-manager/admin/preflight-uid-cutover.mjs --check
```

The check requires both maintenance timers disabled/inactive, both locks
available, exactly the three expected Workout containers, original healthy
PostgreSQL with `wal_level=replica`, old app/GraphHopper images still running,
candidate images with their expected named `Config.User`, unclaimed 20001/20002 host IDs,
root-owned non-writable installed source, and current 1000-owned private and
routing trees. It rejects symlinks and nested mounts in those trees. A mount at
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

   Record the exact three Workout container IDs with `docker inspect`. Set
   their restart policies to `no` with `docker update --restart=no` by those
   **full pinned IDs**. Stop only the pinned GraphHopper, app, then PostgreSQL
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
   identity with the recorded value. With the lock shell and recovery session
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
   PostgreSQL owner. If any command fails, keep all services stopped and use
   the rollback below.
5. Exit the lock-holding shell, confirming both locks are released. This is a
   controlled gap: both timers remain disabled and no backup/manual writer
   may start. Use the reviewed installed host writer's `start postgres`, check
   the exact pinned PostgreSQL container ID, health and `SHOW wal_level`
   (`replica`); then `up app`, check again; then `up graphhopper`, check again.
   Each writer call acquires both locks itself. Abort on an unexpected
   container/image ID, WAL level, new writer, failed health check or changed
   503/apex behavior. Never use `up postgres`, `down`, or the logical WAL
   override in this transition.
6. Probe private create/read/delete under the real 20001 app/worker identity
   and routing write under 20002, plus routing read under 20001. Verify frozen
   Compose and candidate image IDs, all service health, root-owned source,
   503/apex behavior, and denied `ubuntu` direct access in a new session.
   Keep timers and public 503 unchanged until the separate backup and release
   gates pass.

**Rollback before new application writes:** reacquire both locks, disable
restart policies, stop only the Workout app and GraphHopper, then PostgreSQL;
verify all are stopped. Inspect for partial writes. If no new writes occurred,
restore the private/routing trees to their recorded UID/GID 1000 and modes
with the same top-level root gate and symlink/mount checks. Restore the
preserved old source and old `compose.env` to their fixed paths using a
root-controlled same-filesystem rename, moving the candidate copies aside;
verify their exact prior hashes. Use the **old** Compose and old release tag,
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
apex. The installed host writer cannot be used until its Compose SHA pin is
updated to the reviewed restored file; direct root Compose above is confined
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

## Preconditions

1. Keep the public Workout 503 block active. Confirm the apex site, app,
   PostgreSQL and GraphHopper states, exact running image IDs, schema version,
   current directory ownership and disk space. Record them without secrets or
   personal data.
2. Confirm the Lightsail snapshot recovery procedure, take a fresh snapshot,
   and verify its ID and availability before changing any account or file
   ownership. Then establish a separate, narrowly controlled recovery
   administrator. Confirm independent SSH login, root access and recovery
   commands in a **new** session, while the existing `ubuntu` session stays
   open. Do not remove `ubuntu` privileges until this path has actually
   worked. The 2026-10-02 read-only audit found no `wm-recovery` account and
   no instance snapshot for `workout-shared-8gb-20260929`; recheck both
   immediately before starting this sequence.
3. Build the reviewed release from a root-controlled, immutable source copy,
   not the current `ubuntu`-writable `/srv/workout-manager/source`. Pin the
   Compose bytes and image IDs. Keep the copied source non-writable while
   preserving the read/traverse modes needed by the image's non-root user:
   Docker `COPY` preserves restrictive source modes. Do not apply `go-rwx` to
   the build context; verify code and Next build files are readable by UID 20001
   and GraphHopper's launcher is readable by UID 20002 in disposable containers.
   Validate image users numerically, including app, GraphHopper, private-writing
   workers and the intentional ledger root exception. Check the built app can
   start and its runtime cache/temporary paths are writable by UID 20001 in a
   disposable environment. Compare the installed root-owned host writer's full
   SHA-256 with the reviewed source and inspect its `up app`/`up graphhopper`
   command output for `--no-deps`; a grep for that token can match a different
   command path.
4. Prepare a rollback plan using the previous image IDs and the snapshot.
   Document the exact ownership rollback while all Workout writers are
   stopped. Never overwrite data with a stale snapshot after new writes.

## Controlled transition

Disable the two maintenance
timers and check that no one-shot worker, setup job, backup collector, or
ledger exporter is active. Confirm the backup release is not connected to a
timer and prohibit other manual root writers during this window. Hold both
Workout backup and maintenance locks while stopping services and changing
ownership. Keep the 503 block. Stop GraphHopper and app, then PostgreSQL, and
confirm Docker did not restart them. Do not change the apex site's containers
or data.

While every Workout writer is stopped, move the private bind tree to UID/GID
20001 and preserve restrictive directory/file modes. Move the routing tree to
UID/GID 20002; keep the app's read-only routing access working without giving
`ubuntu` write permission. Recheck the ownership of every nested file,
symlink, and mount point; do not follow untrusted symlinks during ownership
changes. The PostgreSQL data directory keeps its database-specific owner.

Release both locks before invoking the host writer: it acquires the same locks
nonblocking for each command and would otherwise exit 75. This is a controlled
handoff, not an atomic lock transfer. With all timers disabled, no backup
scheduler and no other manual writer, first use its `start postgres` command
to start the **existing** PostgreSQL container, then check its exact ID and
health. Keep `compose.logical-wal.yml` out of this transition: its
`wal_level=logical` change has a separate, still-open migration gate. The base
Compose file leaves PostgreSQL's image defaults in place. Use the reviewed
writer's `up app` and `up graphhopper` commands only after confirming they pass
`--no-deps`, so neither command can recreate PostgreSQL as a dependency. Check
the existing PostgreSQL container ID and `SHOW wal_level` before and after the
app/GraphHopper recreation; abort if either changes unexpectedly. Each
writer call reacquires and releases both locks; inspect container IDs and abort
on any unexpected writer or change between calls. Run private file
create/read/delete and routing-read probes as their
actual container identities, then the bounded workers with disposable data.
Confirm healthy services, immutable image/Compose IDs and unchanged 503/apex
behavior. If a probe fails, stop all Workout writers before restoring the old
images and matching ownership; inspect for partial writes before rollback.

Only after the separate administrator access is proven, remove `ubuntu` from
sudo, Docker and LXD access and any passwordless sudo grant. On the current
host, `/etc/sudoers.d/90-cloud-init-users` grants `ubuntu` `NOPASSWD:ALL` in
addition to its sudo group membership; account group removal alone is
insufficient. Preserve a validated recovery sudo rule before changing that
root-owned file, then check the effective `sudo -l -U ubuntu` result. End existing
`ubuntu` sessions and test a **new** `ubuntu` login: direct private read/write,
Docker socket, LXD control and sudo must all fail. Check that the app and its
workers still write the private tree and GraphHopper can maintain its graph.
Keep root and the separate recovery administrator as explicit trusted actors;
the backup lock cannot constrain them. Recheck source-tree immutability and
backup fence identity after the privilege change.

## Evidence required before a fresh backup claim

Record the exact snapshot ID, reviewed release/image/Compose hashes, numeric
host/container identities, ownership before and after, independent recovery
login, denied `ubuntu` bypass attempts, healthy app/worker writes, both locks,
service transitions and rollback result. Then execute the root-only backup
window with concurrent-writer and restart-failure drills, S3 upload, independent
deletion-ledger tail and a separate restore test. The installation and this
plan are **not_executed** evidence for those operations. Do not change their
status to passed based on Dockerfile, Compose, or documentation checks.
