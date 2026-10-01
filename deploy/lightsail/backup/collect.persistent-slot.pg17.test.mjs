import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { assertSyntheticPersistentTarget } from './synthetic-persistent-guard.mjs';

const connectionString = process.env.WORKOUT_PERSISTENT_SLOT_PG17_URL;
const pgDump = process.env.WORKOUT_PG17_DUMP_BIN;
const collector = new URL('./collect.mjs', import.meta.url).pathname;

function run(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

// Requires loopback workout_pg17_proof, database comment WM_DISPOSABLE_PG17_PROOF,
// PostgreSQL 17.6 wal_level=logical, and an absolute 17.6 pg_dump with sibling
// pg_restore/psql. Use only a disposable synthetic cluster, never a live database.
test(
  'PG17.6 collector binds an exact persistent snapshot and cleans failed capture or full-archive validation',
  { skip: !connectionString || !pgDump, timeout: 180_000 },
  async () => {
    assert.ok(isAbsolute(pgDump), 'absolute PostgreSQL 17.6 binary required');
    const sql = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    await sql.connect();
    const system = (
      await sql.query('SELECT system_identifier::text AS id FROM pg_control_system()')
    ).rows[0].id;
    await sql.end();
    await assertSyntheticPersistentTarget(connectionString, system);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-persistent-capture-pg17-')));
    const suffix = randomBytes(6).toString('hex');
    const table = `capture_probe_${suffix}`;
    const publication = `capture_pub_${suffix}`;
    const retainedSlot = `capture_slot_${suffix}`;
    const ownedSlots = [];
    const privateDir = join(root, 'private');
    const outputDir = join(root, 'output');
    const bin = join(root, 'bin');
    const dbFile = join(root, 'database-url');
    const fence = join(root, 'fence');
    const url = new URL(connectionString);
    const databaseEnv = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: 'workout_pg17_proof',
    };
    const pgRestore = join(dirname(pgDump), 'pg_restore');
    const psql = join(dirname(pgDump), 'psql');
    let control;
    let failure;
    const cleanupErrors = [];
    const connect = async () => {
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
      });
      await client.connect();
      return client;
    };
    try {
      for (const dir of [privateDir, outputDir, bin]) mkdirSync(dir, { mode: 0o700 });
      writeFileSync(dbFile, `${connectionString}\n`, { mode: 0o600 });
      writeFileSync(join(privateDir, 'fixture.bin'), 'synthetic-private-bytes', { mode: 0o600 });
      writeFileSync(
        fence,
        '#!/bin/sh\nset -eu\nif [ "${WM_FAIL_FENCE:-}" = yes ] && [ -f "$WM_DUMP_READY" ]; then exit 9; fi\n',
        { mode: 0o700 },
      );
      // The deliberate mutation happens after the replication snapshot exists.
      // It tests snapshot isolation, not the completeness of a production fence.
      writeFileSync(
        join(bin, 'pg_dump'),
        `#!/bin/sh
set -eu
if [ "$1" = --version ]; then exec '${pgDump}' "$@"; fi
if [ "\${WM_FAIL_DUMP:-}" = yes ]; then exit 9; fi
'${psql}' -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.${table}; INSERT INTO public.${table} VALUES (2, 'after-snapshot');" >/dev/null
if [ "\${WM_MUTATE_PRIVATE:-}" = yes ]; then printf added > '${join(privateDir, 'added.bin')}'; fi
exec '${pgDump}' "$@"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, 'pg_restore'),
        `#!/bin/sh
set -eu
if [ "$1" = --file=/dev/null ]; then
  test -f "$WM_DUMP_READY"
  printf attempted > "$WM_FULL_RESTORE_ATTEMPT"
  if [ "\${WM_FAIL_FULL_RESTORE:-}" = yes ]; then exit 9; fi
fi
'${pgRestore}' "$@"
if [ "$1" = --list ]; then touch "$WM_DUMP_READY"; fi
`,
        { mode: 0o700 },
      );
      control = await connect();
      await control.query(
        `CREATE TABLE public.${table} (id integer PRIMARY KEY, label text NOT NULL)`,
      );
      await control.query(
        `CREATE PUBLICATION ${publication} FOR TABLE public.${table} WITH (publish = 'insert,delete')`,
      );
      await control.query(`INSERT INTO public.${table} VALUES (1, 'before-snapshot')`);
      await control.end();
      control = undefined;
      const args = (slot) => [
        'collect',
        '--database-url-file',
        dbFile,
        '--private-dir',
        privateDir,
        '--output-dir',
        outputDir,
        '--fence-check',
        fence,
        '--synthetic-test',
        'yes',
        '--synthetic-persistent-slot-proof',
        'yes',
        '--persistent-expected-system-identifier',
        system,
        '--persistent-publication-tables',
        `public.${table}`,
        '--persistent-publication-operations',
        'insert,delete',
        '--persistent-slot-owner',
        'disposable-test-owner',
        '--replication-slot',
        slot,
        '--publication',
        publication,
      ];
      const invoke = (slot, extraEnv = {}) =>
        spawnSync(process.execPath, [collector, ...args(slot)], {
          encoding: 'utf8',
          timeout: 90_000,
          env: {
            ...databaseEnv,
            PATH: `${bin}:${process.env.PATH}`,
            WM_DUMP_READY: join(root, `dump-ready-${slot}`),
            WM_FULL_RESTORE_ATTEMPT: join(root, `full-restore-${slot}`),
            ...extraEnv,
          },
        });
      ownedSlots.push(retainedSlot);
      const captured = invoke(retainedSlot, {
        PGSERVICE: 'nonexistent-service',
        PGHOSTADDR: '192.0.2.1',
        PGOPTIONS: '-c default_transaction_read_only=on',
      });
      assert.equal(captured.status, 0, captured.stderr);
      const bundleId = captured.stdout.trim().split(' ')[1];
      const bundle = join(outputDir, bundleId);
      const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
      const ownerPath = join(outputDir, `.persistent-slot-${retainedSlot}.json`);
      const ownerBytes = readFileSync(ownerPath);
      const ownership = JSON.parse(ownerBytes);
      assert.equal(ownership.state, 'retained-owner-cleanup-required');
      assert.equal(ownership.restoreAccessAllowed, false);
      assert.equal(ownership.syntheticOnly, true);
      assert.equal(ownership.slotCreationProven, true);
      assert.equal(ownership.bundleId, bundleId);
      assert.deepEqual(ownership.snapshot, manifest.snapshot);
      assert.equal(
        readFileSync(join(bundle, 'private', 'fixture.bin'), 'utf8'),
        'synthetic-private-bytes',
      );
      const restored = run(pgRestore, [
        '--data-only',
        `--table=${table}`,
        '--file=-',
        join(bundle, 'database.dump'),
      ]);
      assert.match(restored, /before-snapshot/);
      assert.doesNotMatch(restored, /after-snapshot/);
      control = await connect();
      const retained = (
        await control.query(
          'SELECT temporary, active, plugin, confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1',
          [retainedSlot],
        )
      ).rows;
      assert.deepEqual(retained, [
        {
          temporary: false,
          active: false,
          plugin: 'pgoutput',
          lsn: manifest.snapshot.consistentPointLsn,
        },
      ]);
      const changes = (
        await control.query(
          "SELECT data FROM pg_logical_slot_peek_binary_changes($1, NULL, 100, 'proto_version', '1', 'publication_names', $2)",
          [retainedSlot, publication],
        )
      ).rows.map(({ data }) => String.fromCharCode(data[0]));
      assert.equal(changes.filter((kind) => kind === 'D').length, 1);
      assert.equal(changes.filter((kind) => kind === 'I').length, 1);
      await control.end();
      control = undefined;
      const repeated = invoke(retainedSlot);
      assert.notEqual(repeated.status, 0);
      assert.deepEqual(
        readFileSync(ownerPath),
        ownerBytes,
        'exclusive receipt is never overwritten on retry',
      );
      for (const [kind, extraEnv] of [
        ['dump', { WM_FAIL_DUMP: 'yes' }],
        ['decode', { WM_FAIL_FULL_RESTORE: 'yes' }],
        ['fence', { WM_FAIL_FENCE: 'yes' }],
        ['private', { WM_MUTATE_PRIVATE: 'yes' }],
      ]) {
        const slot = `${retainedSlot}_${kind}`;
        ownedSlots.push(slot);
        const result = invoke(slot, extraEnv);
        assert.notEqual(result.status, 0, kind);
        if (kind === 'decode') {
          assert.match(result.stderr, /BACKUP_SUBPROCESS_FAILED/);
          assert.equal(
            readFileSync(join(root, `full-restore-${slot}`), 'utf8'),
            'attempted',
            'full archive decode runs after successful TOC validation',
          );
        }
        const failedOwnership = JSON.parse(
          readFileSync(join(outputDir, `.persistent-slot-${slot}.json`)),
        );
        assert.equal(failedOwnership.state, 'failed-investigation-required');
        assert.equal(failedOwnership.slotCreationProven, true);
        control = await connect();
        assert.equal(
          (
            await control.query(
              'SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name=$1',
              [slot],
            )
          ).rows[0].n,
          0,
          `${kind} failure cleans its slot`,
        );
        await control.end();
        control = undefined;
      }
      assert.deepEqual(
        readdirSync(outputDir).filter((name) => !name.startsWith('.persistent-slot-')),
        [bundleId],
        'failed captures publish no bundle or partial directory',
      );
      const expired = spawnSync(
        pgDump,
        [`--snapshot=${manifest.snapshot.snapshotName}`, '-Fc', '-f', join(root, 'expired.dump')],
        { env: databaseEnv, encoding: 'utf8', timeout: 30_000 },
      );
      assert.notEqual(expired.status, 0);
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (!control) control = await connect();
        for (const slot of ownedSlots) {
          const rows = (
            await control.query('SELECT active FROM pg_replication_slots WHERE slot_name=$1', [
              slot,
            ])
          ).rows;
          if (rows.length) {
            assert.equal(rows[0].active, false, 'cleanup requires inactive exclusive test slot');
            await control.query('SELECT pg_drop_replication_slot($1)', [slot]);
          }
        }
        await control.query(`DROP PUBLICATION IF EXISTS ${publication}`);
        await control.query(`DROP TABLE IF EXISTS public.${table}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (control) await control.end().catch((error) => cleanupErrors.push(error));
      rmSync(root, { recursive: true, force: true });
    }
    if (failure || cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        'PG17_CAPTURE_OR_CLEANUP_FAILED',
      );
  },
);
