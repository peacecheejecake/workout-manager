# Shared Lightsail host deployment draft

This Compose project runs Workout Manager alongside the existing `pfm-agent` site. It
does not publish host ports, replace the existing Caddyfile, or reuse its PostgreSQL
data. The existing Caddy container must stay on the `infra_default` Docker network.
Only after the app is healthy, add `workout.caddy` as an additional Caddy site block;
retain the existing apex site block. Recheck both hostnames after a Caddy reload.

## Files outside the checkout

Create a deployment directory under `/srv/workout-manager` and keep all secrets
outside Git. The source tree can be owned by the deployment user and its parent
must allow the required traversal; the secrets directory alone must be root-owned
and mode 0700. The path passed as `WORKOUT_DATA_DIR` needs
separate `postgres`, `private`, `routing`, `basemap`, and `geo-data` directories. `private` is a
dedicated persistent mount, readable and writable by the app's container user
(UID 1000); it is not the existing site's storage. PostgreSQL's data directory
must be writable by its container user. Do not prepare either directory with
world-writable permissions. The app entrypoint rejects a missing private bind
mount even if its path exists inside the image.

`WORKOUT_SECRETS_DIR` must be outside the checkout, root-owned mode 0700,
with mode 0600 files. Run Compose as root so it can read them. Required files are:

| File                    | Minimum contents                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres.env`          | `POSTGRES_DB=workout`, `POSTGRES_PASSWORD=<strong unique secret>`; keep the bootstrap role private.                                                           |
| `app.env`               | `DATABASE_URL` for the restricted `workout_runtime` role; `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; any explicitly approved production settings. |
| `resource-cleanup.env`  | `RESOURCE_CLEANUP_DATABASE_URL` for its dedicated worker role.                                                                                                |
| `course-thumbnails.env` | `COURSE_THUMBNAIL_DATABASE_URL` for its dedicated worker role.                                                                                                |
| `url-ingestion.env`     | `RESOURCE_URL_INGESTION_DATABASE_URL` for its dedicated worker role.                                                                                          |
| `setup.env`             | The six database URLs listed below; used only by the one-shot `db_setup` service.                                                                             |

`setup.env` holds `POSTGRES_BOOTSTRAP_URL` (role `postgres`),
`MIGRATION_DATABASE_URL` (`workout_owner`), `WORKOUT_RUNTIME_DATABASE_URL`
(`workout_runtime`), `RESOURCE_CLEANUP_DATABASE_URL`
(`workout_resource_cleanup_worker`), `COURSE_THUMBNAIL_DATABASE_URL`
(`workout_course_thumbnail_worker`), and `RESOURCE_URL_INGESTION_DATABASE_URL`
(`workout_resource_ingestion_worker`). Each is a percent-encoded PostgreSQL URL
to host `wm-postgres`, database `workout`, with a distinct random password of at
least 24 characters. `POSTGRES_BOOTSTRAP_URL` must use the password in
`postgres.env`. Copy the runtime and worker URLs to their respective files
without copying the bootstrap or migration owner URL. The URL ingestion worker
also requires `RESOURCE_URL_ALLOWED_HOSTS` in its own env file. It is an exact
host allowlist; set it from approved sources, not a wildcard.

The unique `wm-postgres` network alias is required because the existing site's
external Caddy network also contains a service named `postgres`. The Workout app
joins both networks; an unqualified `postgres` host may resolve to the existing
site's database. Never point a Workout URL at that shared name.

Only `url_ingestion` joins `workout_egress`, a dedicated non-internal bridge
network that provides outbound DNS and HTTPS for approved URL sources. It also
stays on `workout_internal` to reach `wm-postgres` and uses the same private
object bind mount as the app and cleanup workers. The other workers do not need
outbound access; `url_ingestion` does not join the existing site's Caddy network.
No Workout service publishes a host port through this network. The bridge is
an egress path, not a network-level host allowlist: keep
`RESOURCE_URL_ALLOWED_HOSTS` restricted to approved exact hostnames and retain
the worker's URL, redirect, DNS, and address checks. Verify outbound reachability
from the one-shot container on the actual host before enabling ingestion.

The one-shot `db_setup` service creates or limits the five non-bootstrap roles,
transfers the dedicated database/schema to `workout_owner`, applies the checked
migrations, and grants the API and workers only their existing bounded surfaces.
It refuses wrong role names, database or host, missing passwords, and a role with
superuser, `BYPASSRLS`, role creation or database creation privileges. It may be
re-run for a version update, but first take and verify a database backup. A
failed run prints only `DATABASE_SETUP_FAILED`; diagnose through a controlled
maintenance session without dumping credentials or health records. Never put
the bootstrap or migration owner credential into `app.env` or a worker file.

The routing directory contains the **verified new ODbL build only**: `foot/`
with its manifest and attribution, the pinned GraphHopper 10 jar as
`graphhopper-web.jar`, the matching serving profile as `config-serving.yml`,
and its source PBF as `source.osm.pbf`. `foot.json` is resolved from the pinned
GraphHopper jar; it is not a separate file in the local build. The API mounts
that directory read-only and checks the graph/jar/profile against the manifest
at startup. GraphHopper receives a writable mount of the staged graph directory
because its store can need a lock file; keep the source build immutable elsewhere and
compare the deployed files and active disclosure after startup. The basemap
directory is a copy of the local build's `dist` directory: it contains
`current.json` next to `ebe407d9dcbe-muldszzf/`, not only the latter folder.
The `geo-data` directory contains the real extract build's `places.json`,
`elevation.json`, `odbl-disclosure.json`, `ATTRIBUTION.txt`, and `odbl-scripts/`.
The app mounts it read-only and treats a missing or stale disclosure as unavailable.

## Start and inspect

Set `WORKOUT_DATA_DIR`, `WORKOUT_SECRETS_DIR`, and an immutable
`WORKOUT_RELEASE` in a deployment-only Compose environment file outside Git.
From the repository root on the server:

```sh
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml config --quiet
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml build
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml up -d postgres
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml --profile setup run --rm db_setup
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml up -d app graphhopper
sudo docker compose --env-file /srv/workout-manager/compose.env -f deploy/lightsail/compose.yml ps
```

The app health check covers the loopback API, Next.js web and PostgreSQL
`SELECT 1`. It does **not** prove GraphHopper readiness, external OIDC, durable
storage after restart, or public HTTPS. Check those separately before adding
the Caddy site and DNS record. Run the one-shot `maintenance` services through
`docker compose --profile maintenance run --rm <service>` with each worker's
dedicated role after role grants are verified. They are not recurring schedulers;
set up bounded scheduling separately. The fixture coaching worker is
intentionally absent from production.

For `url_ingestion`, first confirm that Compose resolves both networks and the
private bind mount, then run a single approved, non-sensitive URL job and inspect
its ledger state and stored object through the application. A successful `config`
check proves only the Compose model; an `empty` one-shot result proves only that
no job was leased. Neither proves external DNS/TLS reachability, the fetch and
parse phases, persistence, retries, or deletion suppression. Repeat one-shot
invocations to finish a two-phase job, and record those checks separately before
setting a recurring schedule. Keep service logs free of fetched URLs and content.

The existing apex site and static IP are already on the 8 GiB shared host.
This Compose project does not remap the IP or change DNS. Adding the workout
Caddy site still requires a controlled edit and reload of the existing Caddy
container. Backups, restore, and external end-to-end checks remain required
before calling the Workout Manager deployment complete.

## Host maintenance schedule template (inactive)

`maintenance/` contains two systemd timers for the existing one-shot
`resource_cleanup` and `course_thumbnails` services. Nothing in this checkout
installs or starts them. The 15-minute cleanup and 5-minute thumbnail cadence
are initial limits to review against queue volume and host load, not measured
production capacity. There is deliberately **no URL ingestion timer**. Its
allowlist and a real approved job still need end-to-end validation before a
recurring invocation is safe. Keep `url_ingestion` manual under the procedure
above; an empty queue run is not approval to schedule it.

Before installing either timer, confirm the immutable release, Compose model,
dedicated worker roles and grants, healthy app/DB, private mount, verified
backup, and an isolated restore drill. Run each worker on a controlled
nonempty fixture or approved job and inspect the ledger, object state, deletion
suppression, retry/failure behavior, and host resource use. Confirm enough disk
for persistent systemd journal and choose a retention policy. Configure
journald persistent storage (`Storage=persistent`) and verify that a failed
test unit remains in `journalctl` after a restart. Arrange an operator to
review failed units, `/var/lib/workout-manager/maintenance/*.failed-at`, and
journal entries; this template does not send remote alerts. The marker has only
a UTC timestamp, remains until deliberately cleared after investigation, and
must be root-readable only. A zero exit code means the one-shot process ran,
not that a queue was drained or its domain result was accepted.

After those gates, copy the four systemd unit files from `maintenance/` to
`/etc/systemd/system/` as root, keeping the runner executable at the pinned
`/srv/workout-manager/source` release path. Verify the file contents and run
`systemd-analyze verify` against all units, `systemctl daemon-reload`, then
enable/start **only** `workout-resource-cleanup.timer` and
`workout-course-thumbnails.timer`. Check `systemctl list-timers`, both worker
service statuses, `journalctl -u 'workout-maintenance@*'`, and the failure
markers after a real invocation. Timer installation/activation, restart
retention, monitoring, and live job behavior remain external checks.

The host runner holds one nonblocking lock across both services. A second
invocation fails visibly rather than overlapping. The fixed Docker container
name also blocks a new invocation if Compose is killed but its container remains.
Each call has a 20-minute timeout and a 30-second TERM grace period; systemd
also bounds the unit at 22 minutes. A timeout or stale container needs operator
inspection of the ledger and Docker state before any retry or cleanup. Do not
force-remove an active container just to clear the name. `Persistent=false`
avoids a backlog burst after host downtime. The wrapper rejects
`url_ingestion` and unknown service names before starting Docker, and never
prints its environment or Compose configuration.

## Database recovery prerequisite

### Backup collector preparation (inactive)

`backup/collect.mjs` is an opt-in local collector, not an installed schedule or
retention policy. Its `collect` command requires a root-owned mode 0600 file
containing a PostgreSQL URL, a root-owned mode 0700 output directory, a dedicated
private directory, and a root-owned mode 0700 executable `--fence-check`. The
operator must first stop **all** Workout database and private-object writers,
including the app, workers, uploads, and any separate maintenance process. The
checker must reject any visible loss of the externally held write fence; the
collector runs it before the dump, before each private-file copy,
and after the copy. A checker that merely returns zero is not evidence of a
fence. The collector cannot establish a consistent recovery point without this
external operational control. Do not use it against the live host until the
fence procedure, disk capacity, and recovery input are reviewed.

`backup/check-fence.mjs` is an **offline-prepared, uninstalled** host-side
checker for that external command slot. It makes a point-in-time, fail-closed
assessment; it does not establish or hold a write fence. Before even considering
an operational run, an operator must establish a bounded maintenance window,
stop/disable both Workout maintenance timers if installed, wait for their
one-shot services and all manually started Workout jobs to finish, and hold
exclusive `/run/lock/workout-manager/maintenance.lock` and
`/run/lock/workout-manager/backup.lock` locks throughout collection. Stop the
Workout `graphhopper` and `app` services while leaving its dedicated `postgres`
service running. Block deployment, manual `db_setup`, worker, upload, and other
Workout writer entry points for the entire window. The existing `infra` Compose
project, apex Caddy block, apex database, and `infra_default` network must stay
running and untouched. The Workout hostname may be unavailable during this
window; that is separate from the apex site.

The checker requires a root-owned mode 0600 JSON file named by the absolute
`WORKOUT_BACKUP_FENCE_CONFIG` environment variable and a root-owned mode 0700
copy of the checker. Its config schemaVersion is 1 and pins project
`workout-manager`, the deployment's exact Compose path
`/srv/workout-manager/source/deploy/lightsail/compose.yml`, private path
`/srv/workout-manager/data/private`, PostgreSQL path
`/srv/workout-manager/data/postgres`, the Compose file SHA-256, network
`workout-manager_workout_internal`, the dedicated
PostgreSQL cluster system identifier, exact PostgreSQL 17.6 server version
number `170006`, and full current Docker IDs for `app`,
`postgres`, and `graphhopper`. The IDs and system identifier are observations
to record through a controlled read-only host inspection, not constants to
guess or reuse after replacement. The checker rejects changed Compose bytes,
symlink paths, missing/unsafe lock or config files, active/enabled timers,
locks that it can acquire, missing/replaced/extra Workout containers, a foreign
container attached to the Workout internal network or data paths, running app
or GraphHopper, an unhealthy Workout DB or wrong mounts/project labels, a wrong
database/cluster identifier, any other PostgreSQL client session, and command
failures. It prints only `BACKUP_FENCE_CHECKED` or `BACKUP_FENCE_FAILED`.

The root-only config has this shape; replace every placeholder from the
verified deployment state before a controlled trial:

```json
{
  "schemaVersion": 1,
  "project": "workout-manager",
  "network": "workout-manager_workout_internal",
  "composeFile": "/srv/workout-manager/source/deploy/lightsail/compose.yml",
  "composeSha256": "<64 lowercase hex characters>",
  "privateDir": "/srv/workout-manager/data/private",
  "postgresDir": "/srv/workout-manager/data/postgres",
  "postgresSystemIdentifier": "<dedicated cluster system identifier>",
  "postgresVersionNum": "170006",
  "containers": {
    "app": "<64 lowercase hex characters>",
    "postgres": "<64 lowercase hex characters>",
    "graphhopper": "<64 lowercase hex characters>"
  }
}
```

The checker must run on the Docker host: it reads systemd and host locks and
inspects all containers. The original collector's `--database-url-file` mode
runs `pg_dump` on the host, but `wm-postgres` is a Docker-internal alias and
PostgreSQL publishes no host port. The opt-in
`--database-transport <root-owned-executable>` mode delegates only the archive
step to `backup/docker-archive-transport.mjs`. Install a root-owned mode 0700
copy of that executable **and** its adjacent `check-fence.mjs` module outside
Git, then provide the same root-only fence configuration to both through
`WORKOUT_BACKUP_FENCE_CONFIG`. No URL or password is needed for this mode. The
transport invokes PostgreSQL 17.6's `pg_dump` as the `postgres` OS user inside
the pinned, existing Workout DB container and streams its raw stdout to a mode
0600 partial file under the collector's root-only staging directory. It never
publishes a DB port or joins the apex project. It sends those exact bytes back
through stdin to that container's `pg_restore --list` and
`pg_restore --file=/dev/null`, checks a stable SHA-256, and renames the file
only after the fence checker passes again. Failure removes the partial file;
the collector removes its incomplete bundle. Standard output and errors contain
fixed status codes only, never archive bytes or credentials. The transport
does not mount the Docker socket in another container or create a backup
container.

This is still **offline preparation**, not an operational backup procedure.
The opt-in `backup/backup-window.mjs` host wrapper now takes both root-only
`flock` locks for the whole stop → capture → restore sequence. It requires an
already disabled or absent pair of Workout maintenance timers, the pinned
config, root-owned mode 0700 installed checker/transport/collector/wrapper, and
a root-owned mode 0700 `/srv/workout-manager/backups` directory. It checks the
exact IDs, Compose labels, mounts, and health before touching containers. It
stops only the pinned Workout `graphhopper` then `app` containers with
`docker stop`; after the checker and collector complete, it starts only containers
that it stopped, in `app` then `graphhopper` order. It does not call Compose
`up`/`down`, create replacement containers, change Caddy, or touch `infra`.
Failures before stopping leave the services alone. After a stop attempt it
tries to restore that same pinned ID even if the stop command reported failure.
The app's health and public response after restart still require an operator
check. Signal interruption (especially SIGKILL), host loss, or a replaced
container can prevent automatic restoration and require controlled manual
recovery.

The wrapper is not a complete write fence: manual `docker exec`, deployment
commands, host processes, and unregistered writers can ignore its advisory
locks. Those entry points need an operational exclusion rule and a concurrent
writer/restart drill before live use. The checker still samples state. The
exact `postgres` local-socket authentication and Docker streaming path have
not been exercised on the server. The host's
`pg_restore` version must be suitable before using the collector's later
`verify` command; the transport's capture-time PostgreSQL 17 validation does
not supply a host PostgreSQL 17 binary for that later step. A full isolated
restore is required to prove recoverability. The transport uses the dedicated
cluster's local PostgreSQL administrator identity to read RLS-protected data,
so protect the archive and do not mistake this for a least-privilege backup
role. Its 30-minute subprocess limit and available disk must be checked against
real data before scheduling. Actual production collection, backup retention,
off-host copy, independent deletion ledger capture/replay, and recovery remain
**not_executed**.

The window wrapper has synthetic tests at
`node --test deploy/lightsail/backup/backup-window.test.mjs` for exact stop/start
order, initially stopped services, locks/timers/project failures, a Docker stop
that changes state but returns failure, checker failure, and collector failure.
No host timer, wrapper, or recurring backup is installed. Deletion-ledger
completeness and replay remain independent acceptance gates.

`backup/remote-store.mjs` is an opt-in, uninstalled S3 transport for a local
bundle that `collect.mjs` has already published. It requires a root-owned mode
0600 JSON config with `schemaVersion: 1`, `bucket`, `prefix`,
`region: "ap-northeast-2"`, and the 12-digit
`expectedBucketOwner`; commands are `upload <absolute-config> <absolute-bundle>`
and `download <absolute-config> <bundle-id> <new-absolute-destination>`. The
bucket must have versioning enabled. Upload verifies the bundle's exact file
set and SHA-256 manifest, uses S3 SSE-S3, downloads each pinned object version
to check its bytes, and conditionally publishes `completion.json` last. A
repeated upload verifies all recorded remote versions; download starts from an
empty destination and rejects missing or changed bytes. Individual files over
4 GiB are rejected. This transport has synthetic success, interruption,
corruption, conflict, and retry tests; no S3 bucket, IAM policy, retention,
Object Lock, live upload, independent signature, or recovery run has been
verified. The completion record fixes `ledgerCompleteness` to `not_verified`:
it is a transfer receipt, never permission to restore or reopen the app. The
post-backup deletion ledger and its complete tail remain separate gates.

The checker can miss a writer created between Docker inventory, DB query, and
the collector's next call. In particular, `collect.mjs` enumerates private
files before its first checker invocation and there is a gap between its last
check and publication. Merely calling the checker before and after copies does
not close those races. All writer entry points must honor an independently held
host fence for the entire operation, and a real restart/concurrent writer drill
must fail safely before production collection. Confirm that the chosen
PostgreSQL connection points to this cluster; the collector currently checks
URL syntax, not cluster identity. Measure disk headroom for both private bytes
and the database archive; its current estimate covers private bytes and 64 MiB
only. Its subprocess timeout is 120 seconds, which may not suit real data.

Offline checks: `node --test deploy/lightsail/backup/check-fence.test.mjs` covers
synthetic success and writer restart, wrong project/path/DB, active client,
timer/lock, foreign container, and Docker failure rejection. This does not
prove any live writer is fenced. Operational use additionally needs independent
post-backup deletion/erasure/consent/suppression ledger capture and replay,
off-host protected copies, retention, and an isolated PostgreSQL 17 restore
with the app, private objects, workers, restart, and RLS checks before runtime
access. An empty ledger needs independent attestation; the collector's `verify`
checks its supplied bytes, not completeness or replay.

`node --test deploy/lightsail/backup/docker-archive-transport.test.mjs
deploy/lightsail/backup/collect.test.mjs` covers the opt-in handoff, complete
and partial synthetic byte streams, Docker/fence failure, stale pins, and
incomplete-bundle cleanup. The opt-in disposable PostgreSQL 14 collector test
also checks an actual custom archive through no-filename `pg_restore --list`
and `pg_restore --file=/dev/null` stdin reads. It does not exercise Docker or
the deployed PostgreSQL 17.6 container.

The collector rejects symlinks and nonregular private entries, overlapping
source/output paths, low available disk, unsafe ownership or modes, changed
source bytes, and failed `pg_dump`/`pg_restore --list`. It writes into a mode
0700 partial directory, stores the archive, copied private files, and manifest
at mode 0600, then publishes the directory by rename only after all checks pass.
It removes a failed partial directory. This checks capture bytes; it does not
make database and file writes atomic by itself. The database URL is passed to
PostgreSQL through environment variables rather than command arguments; output
contains only fixed status codes and the new bundle name.

`verify --bundle ... --post-backup-ledger-dir ...` checks archive readability and
all recorded bytes, and requires a **separately captured** post-backup deletion
ledger directory. That directory needs mode 0700, mode 0600 ledger files, and
`ledger-manifest.json` with `schemaVersion: 1`,
`source: "independent-post-backup-deletion-ledger"`, `backupCapturedAt` equal to
the bundle capture time, `replayThrough` at or after that time, and sorted
`files` entries containing relative `path`, `sha256`, and `bytes`. Verification
checks supplied bytes and coverage timestamps only; it does **not** prove that
the ledger is complete or that replay succeeded. An empty ledger must still be
independently produced and attested. Restored runtime access remains prohibited
until the relevant erasure, deletion, consent, and suppression ledgers are
replayed and checked. No live collector run, retention/pruning, off-host copy,
RPO/RTO measure, or independent operational ledger capture has been accepted.

`node --test deploy/lightsail/backup/collect.test.mjs` covers publishing and
failure paths with synthetic private files and PostgreSQL command stubs.
`WORKOUT_BACKUP_REAL_PG=1 node --test deploy/lightsail/backup/collect.test.mjs`
also creates and removes a disposable PostgreSQL 14 cluster, then checks a real
archive and deliberate corruption. The recorded local run passed. This does not
exercise the deployed PostgreSQL 17.6 Compose topology or live operational
fence, and is not authorization to collect a production backup.

A `pg_dump -Fc` backup contains the Workout database but not cluster roles.
Before restoring into a fresh cluster, create `workout_owner` as a restricted
role: several RLS policies name it explicitly. The isolated schema drill used
`pg_restore --exit-on-error --no-owner --no-acl --create -d postgres`, but
that runs as the PostgreSQL administrator and may leave restored objects owned
by that administrator. `db_setup` changes database and schema ownership; it
does not transfer each restored object's ownership. Do **not** treat that
drill or a later `db_setup` invocation as a verified operational recovery.

Test the complete procedure in a separate PostgreSQL cluster and network with
no connection to the live Compose project. Create a database owned by
`workout_owner`, restore into it while connected as that restricted role
without `--create`, then test `db_setup`, runtime and worker grants, RLS, app
startup, restart, data integrity, and private-object recovery. The restricted
owner restore, subsequent `db_setup` role/grant setup, and app health on that
restored database passed in an isolated drill with temporary credentials and a
dummy IdP. A later synthetic Docker drill also passed restored app health after
restarting its isolated PostgreSQL container, a nonempty abandoned-object cleanup
queue, and erased-tenant prefix purge. Real IdP login, application-originated
worker operations, and deployed
data/private-object recovery remain unexecuted. Keep backups root-only and
never point the recovery test at the live database.

The opt-in synthetic drill (`node --import tsx
scripts/backup-restore-drill.mts --execute`) restores generated account and
resource rows with an exact-byte private-object directory copy. It replays
independently captured deletion ledgers before runtime access, checks tenant
ownership and erasure suppression, then restarts its isolated PostgreSQL
process and rechecks restricted-role database access, the retained resource,
erased-account denial, and the private object's bytes. Its Unix-socket cluster
has no TCP listener and is removed afterward. This local PostgreSQL 14 drill
does not exercise the deployed PostgreSQL 17.6 Compose topology, HTTP health,
restored app restart, production backup collection, or a live IdP. A separate
two-stack drill with the deployed image and private bind mount remains required
before claiming operational recovery.

The host-only opt-in `synthetic-restore-drill.sh --execute` uses the pinned app
image and PostgreSQL 17.6 in two new internal Docker networks. It creates a
synthetic database archive and private file, restores as `workout_owner`, runs
`db_setup`, replays a fixed synthetic post-backup tenant erasure before app
startup, then checks app health and object bytes after a database restart. It
checks the restricted runtime's erasure gate and runs the cleanup worker against
a due abandoned-object queue and an erased tenant's rowless file; a second run
checks the empty queue and unchanged retained control file. The script removes its
containers, networks, volumes, archive, and file in an exit trap. Run it only
on a host where that image is already available, after checking for sufficient
temporary capacity. The [recorded host run](../../docs/implementation/research/lightsail-synthetic-restore-20260930.json)
does not establish production backup, independent ledger capture/replay, application-originated cleanup,
real authentication, public HTTPS, or RPO/RTO behavior.
