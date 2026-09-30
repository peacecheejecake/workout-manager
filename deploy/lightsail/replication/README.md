# Disposable synchronous standby proof

Run `bash deploy/lightsail/replication/prove-synchronous-standby.sh` on a test
machine with local PostgreSQL binaries (`postgres`, `initdb`, `pg_ctl`,
`pg_basebackup`, `psql`), Python 3, and available loopback ports. The script
creates two independent temporary data directories with `mktemp`, starts a
primary and a physical standby on separate loopback ports, and removes both
clusters on exit. It uses temporary local `trust` authentication only inside
those disposable clusters; never adapt that authentication to deployment.

The fixture has a `restore_suppression_event` table and a `deletion_target`
table. They are intentionally minimal and are **not** the application's
migrations or a test of migration 080's invariants. The first transaction
inserts an event and deletes its target. The script requires
`synchronous_standby_names = 'FIRST 1 (proof_standby)'`,
`synchronous_commit = on`, `fsync = on`, and `pg_stat_replication.sync_state =
sync` before the transaction. After its successful commit response, it queries
the standby to confirm that the event is present and the target absent. A
brief replay wait is allowed because `synchronous_commit = on` confirms remote
WAL flush, not remote apply.

The script then stops the only standby, waits for the replication connection
to disappear, and starts a second event plus target deletion transaction. It
observes the commit waiting in `SyncRep` for two seconds without a success
response, terminates that test backend, and requires the client to fail
without reaching its post-commit success marker. **This does not prove that
the second transaction rolled back.** PostgreSQL can commit locally before
waiting for remote confirmation; an operator must resolve the uncertain
outcome before retrying or promoting a node. Killing or timing out a client is
not an application-level guarantee that no local deletion occurred.

The proof covers one local machine and two directories. It does not test
independent hosts or failure domains, failover fencing, network partitions,
backup/restore, a full deletion ledger, PostgreSQL 17.6 deployment, or a
production write path. Record its output as local implementation evidence
only.

PostgreSQL 17 reference: [synchronous replication](https://www.postgresql.org/docs/17/warm-standby.html#SYNCHRONOUS-REPLICATION),
[standby naming](https://www.postgresql.org/docs/17/runtime-config-replication.html#GUC-SYNCHRONOUS-STANDBY-NAMES),
and [commit durability](https://www.postgresql.org/docs/17/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT).
