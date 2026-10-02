# Shared Lightsail privilege cutover (prepared, not executed)

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
2. Establish a separate, narrowly controlled recovery administrator. Confirm
   independent SSH login, root access and recovery commands in a **new**
   session, while the existing `ubuntu` session stays open. Confirm the
   Lightsail snapshot recovery procedure and take a fresh snapshot before any
   account or ownership change. Do not remove `ubuntu` privileges until this
   path has actually worked. The 2026-10-02 read-only audit found no
   `wm-recovery` account and no instance snapshot for
   `workout-shared-8gb-20260929`; recheck both immediately before creating
   them.
3. Build the reviewed release from a root-controlled, immutable source copy,
   not the current `ubuntu`-writable `/srv/workout-manager/source`. Pin the
   Compose bytes and image IDs. Validate image users numerically, including
   app, GraphHopper, private-writing workers and the intentional ledger root
   exception. Check the built app can start and its runtime cache/temporary
   paths are writable by UID 20001 in a disposable environment.
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
health. Do not use `up postgres` here: the staged Compose file contains a
`wal_level=logical` change whose migration gate is still open. Use the reviewed
writer's `up app` and `up graphhopper` commands only after confirming they pass
`--no-deps`, so neither command can recreate PostgreSQL as a dependency. Each
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
