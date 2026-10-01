# Synthetic persistent-slot capture

This opt-in `collect.mjs` path is a local PostgreSQL **17.6** drill. It does not
provide production backup, independent deletion-ledger completeness, remote
retention, WAL-tail witnessing, authenticated coverage, or restore readiness.
The v2 manifest remains `caller-supplied-exported-snapshot-local-integrity-only`,
and `collect verify` continues to refuse v2 restore readiness. Existing operational
v1 and disposable temporary-slot collection paths are unchanged.

Use only an isolated, synthetic `workout_pg17_proof` database on loopback, with
`wal_level=logical` and database comment `WM_DISPOSABLE_PG17_PROOF`. Supply its
independently observed system identifier, an unused slot name, explicit publication
name, full table set, and exact operations. Row filters, column lists, schema-wide
publication rules, and catalog changes fail closed. Both local `pg_dump` and
`pg_restore` must report 17.6. The private/output directories and credential/fence
files must satisfy the existing collector's secure permissions and temporary-path
synthetic guard. This drill accepts at most 16 private files and 32 MiB of private
bytes, limits each fence check to five seconds, and uses bounded database connection,
query, and archive subprocess timeouts. The caller is responsible for an actual
write fence; an executable that simply exits successfully does not establish
quiescence.

```sh
node deploy/lightsail/backup/collect.mjs collect \
  --database-url-file /private/tmp/drill/database-url \
  --private-dir /private/tmp/drill/private \
  --output-dir /private/tmp/drill/output \
  --fence-check /private/tmp/drill/fence \
  --synthetic-test yes \
  --synthetic-persistent-slot-proof yes \
  --persistent-expected-system-identifier <observed-system-id> \
  --persistent-publication-tables public.synthetic_event \
  --persistent-publication-operations insert \
  --persistent-slot-owner <exclusive-drill-owner> \
  --replication-slot <unused-drill-slot> \
  --publication <synthetic-publication>
```

The replication connection holds its exported snapshot while `pg_dump` imports
that exact snapshot. `pg_restore --list` checks its table of contents, then
`pg_restore --file=/dev/null` decodes the full archive before private capture.
Private files, their final set/digests, manifest, and directories
are checked and synchronized before publication; the helper then verifies the slot
and publication again. Failed capture or publication removes its local bundle.
A known-created slot is cleaned by the helper when capture fails. Ambiguous CREATE,
DROP, disconnect, or receipt-write outcomes require investigation.

A durable, exclusive `.persistent-slot-<name>.json` reservation is created in the
output directory **before slot creation**. It contains no credentials. Successful
capture records `retained-owner-cleanup-required`, the exact snapshot/LSN, and
`restoreAccessAllowed: false`. This local receipt is not independent proof of
ownership, integrity, or retention. `slotCreationProven: false` must never be used
to authorize dropping a slot: it can represent a pre-existing slot or ambiguous
creation. `failed-investigation-required` also does not assert slot absence.

The exclusive drill owner must explicitly arrange a consumer handoff or manually
clean the retained slot. Before any manual drop, independently confirm the marked
cluster identity, proven creation, exact slot/database/plugin/LSN, inactivity, and
absence of name reuse or another owner. Do not automatically reuse the slot name or
delete the reservation to retry. A crash may leave a published local bundle and a
reservation requiring investigation; consumers must require the final retained
receipt and must not scan bundle names as capture success. Slot retention consumes
WAL; finish the disposable drill and its cleanup promptly.

## Verification

```sh
node --test deploy/lightsail/backup/collect.persistent-slot.test.mjs
WORKOUT_PERSISTENT_SLOT_PG17_URL='<loopback synthetic URL>' \
WORKOUT_PG17_DUMP_BIN='<absolute PostgreSQL 17.6 pg_dump>' \
node --test deploy/lightsail/backup/collect.persistent-slot.pg17.test.mjs
```

The opt-in integration test requires sibling `pg_restore` and `psql` tools. It checks
pre-change dump contents against post-snapshot WAL observations, retained ownership,
retry refusal, dump/full-archive-validation/fence/private-file failures, and
explicit cleanup. An unset
integration environment is a skip, never a PostgreSQL verification pass. Its deliberate
post-snapshot mutation tests snapshot isolation and does not prove a production fence.
