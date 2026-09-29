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

The existing apex site and static IP are already on the 8 GiB shared host.
This Compose project does not remap the IP or change DNS. Adding the workout
Caddy site still requires a controlled edit and reload of the existing Caddy
container. Backups, restore, and external end-to-end checks remain required
before calling the Workout Manager deployment complete.

## Database recovery prerequisite

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
startup, restart, data integrity, and private-object recovery. This sequence
is a proposed procedure until its own isolated drill succeeds. Keep backups
root-only and never point the recovery test at the live database.
