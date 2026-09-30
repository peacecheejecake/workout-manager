#!/usr/bin/env bash
# Disposable local proof only. Never point this at an existing cluster.
set -euo pipefail

for tool in initdb pg_ctl pg_basebackup psql python3; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

pg_major="$(postgres -V | sed -E 's/.* ([0-9]+)\..*/\1/')"
if (( pg_major < 14 )); then
  echo "PostgreSQL 14 or newer is required" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/wm-sync-proof.XXXXXXXX")"
primary="$scratch/primary"
standby="$scratch/standby"
mkdir -m 700 "$scratch/socket"
primary_started=0
standby_started=0
cleanup() {
  if (( standby_started )); then pg_ctl -D "$standby" -m immediate stop >/dev/null 2>&1 || true; fi
  if (( primary_started )); then pg_ctl -D "$primary" -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

# Separate loopback ports; no existing PostgreSQL data directory is used.
read -r primary_port standby_port < <(python3 - <<'PY'
import socket
sockets = []
for _ in range(2):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets:
    sock.close()
PY
)

initdb -D "$primary" -U postgres -A trust --no-instructions >"$scratch/initdb.log"
cat >>"$primary/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $primary_port
unix_socket_directories = '$scratch/socket'
wal_level = replica
max_wal_senders = 4
max_replication_slots = 4
hot_standby = on
fsync = on
full_page_writes = on
synchronous_commit = on
EOF
pg_ctl -D "$primary" -l "$scratch/primary.log" -w start >/dev/null
primary_started=1

primary_sql() { psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$primary_port" -U postgres -d postgres "$@"; }
standby_sql() { psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$standby_port" -U postgres -d postgres "$@"; }
wait_for() {
  local label="$1" command="$2" expected="$3" actual
  for (( i=0; i<100; i++ )); do
    actual="$(eval "$command" 2>/dev/null || true)"
    if [[ "$actual" == "$expected" ]]; then return 0; fi
    sleep 0.1
  done
  echo "timeout waiting for $label (last: $actual)" >&2
  exit 1
}

primary_sql <<'SQL'
CREATE ROLE proof_replication WITH LOGIN REPLICATION;
-- The fixture represents only the write ordering under test, not migration 080.
CREATE TABLE deletion_target (id text PRIMARY KEY);
CREATE TABLE restore_suppression_event (
  event_id text PRIMARY KEY,
  target_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind = 'target_deleted')
);
INSERT INTO deletion_target VALUES ('acknowledged'), ('standby_lost');
SQL

pg_basebackup -D "$standby" -d "host=127.0.0.1 port=$primary_port user=proof_replication application_name=proof_standby" -R -X stream >"$scratch/basebackup.log" 2>&1
cat >>"$standby/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $standby_port
unix_socket_directories = '$scratch/socket'
hot_standby = on
EOF
[[ "$primary" != "$standby" && -f "$primary/PG_VERSION" && -f "$standby/PG_VERSION" && -f "$standby/standby.signal" ]] || exit 1
pg_ctl -D "$standby" -l "$scratch/standby.log" -w start >/dev/null
standby_started=1
wait_for 'streaming standby' "primary_sql -c \"SELECT application_name || ':' || state FROM pg_stat_replication\"" 'proof_standby:streaming'

primary_sql -c "ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (proof_standby)'" >/dev/null
primary_sql -c 'SELECT pg_reload_conf()' >/dev/null
wait_for 'synchronous standby' "primary_sql -c \"SELECT application_name || ':' || sync_state FROM pg_stat_replication\"" 'proof_standby:sync'
[[ "$(primary_sql -c 'SHOW synchronous_standby_names')" == 'FIRST 1 (proof_standby)' ]]
[[ "$(primary_sql -c 'SHOW synchronous_commit')" == 'on' ]]
[[ "$(primary_sql -c 'SHOW fsync')" == 'on' ]]

primary_sql <<'SQL'
BEGIN;
INSERT INTO restore_suppression_event VALUES ('event-acknowledged', 'acknowledged', 'target_deleted');
DELETE FROM deletion_target WHERE id = 'acknowledged';
COMMIT;
SQL
wait_for 'standby replay' "standby_sql -c \"SELECT count(*) FROM restore_suppression_event WHERE event_id = 'event-acknowledged'\"" '1'
[[ "$(standby_sql -c "SELECT count(*) FROM deletion_target WHERE id = 'acknowledged'")" == '0' ]]
[[ "$(standby_sql -c 'SELECT pg_is_in_recovery()')" == 't' ]]
echo "PASS: acknowledged event and target deletion are visible on independent standby"

pg_ctl -D "$standby" -m immediate -w stop >/dev/null
standby_started=0
wait_for 'standby disconnection' "primary_sql -c \"SELECT count(*) FROM pg_stat_replication\"" '0'

# Observe the blocked commit for two seconds, then terminate its backend. This
# bounds the proof even on versions where statement_timeout does not interrupt
# SyncRep wait. Backend termination is NOT rollback evidence: the transaction
# may already have committed locally before the replication wait.
primary_sql >"$scratch/lost-standby-client.log" 2>&1 <<'SQL' &
SET application_name = 'proof_blocked_deletion';
BEGIN;
INSERT INTO restore_suppression_event VALUES ('event-no-ack', 'standby_lost', 'target_deleted');
DELETE FROM deletion_target WHERE id = 'standby_lost';
COMMIT;
SELECT 'UNEXPECTED_SUCCESS_ACK';
SQL
client_pid=$!
wait_for 'commit waiting for SyncRep' "primary_sql -c \"SELECT count(*) FROM pg_stat_activity WHERE application_name = 'proof_blocked_deletion' AND wait_event = 'SyncRep'\"" '1'
sleep 2
if ! kill -0 "$client_pid" 2>/dev/null; then
  echo 'FAIL: lost-standby client completed while SyncRep was unavailable' >&2
  cat "$scratch/lost-standby-client.log" >&2
  exit 1
fi
[[ "$(primary_sql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'proof_blocked_deletion' AND wait_event = 'SyncRep'")" == 't' ]]
set +e
wait "$client_pid"
failure_status=$?
set -e
if (( failure_status == 0 )) || grep -q 'UNEXPECTED_SUCCESS_ACK' "$scratch/lost-standby-client.log"; then
  echo "FAIL: lost-standby transaction reported success" >&2
  cat "$scratch/lost-standby-client.log" >&2
  exit 1
fi
echo "PASS: after sole standby stopped, new deletion commit waited in SyncRep for 2s without success ACK; backend terminated"
echo "Primary after unacknowledged commit: event_count=$(primary_sql -c "SELECT count(*) FROM restore_suppression_event WHERE event_id = 'event-no-ack'"); target_count=$(primary_sql -c "SELECT count(*) FROM deletion_target WHERE id = 'standby_lost'")"
echo 'Standby after disconnection: unavailable (not queried or treated as having the second event)'
echo "PostgreSQL: $(postgres -V); scratch clusters removed on exit"
