import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  makeLocalReplayRecordEnvelope,
  peekSuppressionPgoutput,
  type LocalReplayRecordEnvelope,
} from '../src/restore-suppression-pgoutput.js';
import { encryptReplaySegment, decryptReplaySegment } from '../src/restore-suppression-segment.js';
import { replayVerifiedSuppressionChain } from '../src/restore-suppression-replay.js';

// Actual logical WAL and owner replay, synthetic metadata only. A local fixture
// anchor/key is not external backup completeness, an independent witness or admission.
const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `v6_owner_${suffix}`;
const names = [`v6_source_${suffix}`, `v6_target_${suffix}`];
const slot = `wm_suppression_v6_${suffix}`;
const athlete = randomUUID();
const exactId = randomUUID(),
  allId = randomUUID(),
  rolledBackId = randomUUID();
const version = '12345678-abcd-7abc-8def-123456789abc';
const exactKey = JSON.stringify([version, 2147483647]);
const stamp = '2026-10-01T00:00:00.123456Z';
const key = Buffer.alloc(32, 83),
  keyId = 'synthetic-v6-pgoutput';
let admin: Pool, source: Pool, target: Pool, inspector: Pool;
let envelope: LocalReplayRecordEnvelope, ciphertext: Buffer;
let initialSlotLsn: string;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function endpoint(database: string, username?: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  if (username) {
    value.username = username;
    value.password = 'isolated';
  }
  value.searchParams.set(
    'options',
    '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=5000',
  );
  return value.toString();
}
async function ownerTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function produce(client: PoolClient, id: string, scope: 'exact_version' | 'all_versions') {
  return client.query(
    'SELECT public.replay_manual_review_source_suppression_exact($1,$2,$3,$4,$5,$6,$7)',
    [
      athlete,
      id,
      stamp,
      'session-completion',
      id === rolledBackId ? 'synthetic-rollback-session' : 'synthetic-session',
      scope,
      scope === 'exact_version' ? exactKey : null,
    ],
  );
}
function replay() {
  return replayVerifiedSuppressionChain({
    ownerPool: target,
    segments: [ciphertext],
    key,
    keyId,
    anchor: {
      clusterId: envelope.clusterId,
      fromLsn: envelope.fromLsn,
      throughLsn: envelope.throughLsn,
      previousHash: null,
      finalLocalHash: envelope.sha256,
      ciphertextHashes: [hash(ciphertext)],
    },
  });
}

describe.skipIf(!enabled)(
  'registered106 actual v6 logical pgoutput (local synthetic trust)',
  () => {
    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl });
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      for (const name of names) {
        await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`);
        await migrate(endpoint(name, role));
      }
      source = new Pool({ connectionString: endpoint(names[0] ?? '', role) });
      target = new Pool({ connectionString: endpoint(names[1] ?? '', role) });
      inspector = new Pool({ connectionString: endpoint(names[0] ?? '') });
      for (const pool of [source, target])
        await pool.query(
          'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
          [athlete, 'https://synthetic-v6.invalid', randomUUID()],
        );
      expect((await inspector.query('SHOW wal_level')).rows[0]).toEqual({ wal_level: 'logical' });
      expect(
        (
          await source.query(
            'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
          )
        ).rows[0],
      ).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(
        (await source.query('SELECT count(*)::int AS n,max(version) AS v FROM schema_migrations'))
          .rows[0],
      ).toEqual({ n: 106, v: 106 });
      const created = await inspector.query<{ lsn: string }>(
        'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
        [slot, 'pgoutput'],
      );
      initialSlotLsn = z.string().min(1).parse(created.rows[0]?.lsn);
      await ownerTransaction(source, (client) => produce(client, exactId, 'exact_version'));
      await ownerTransaction(source, (client) => produce(client, allId, 'all_versions'));
      await expect(
        ownerTransaction(source, async (client) => {
          await produce(client, rolledBackId, 'exact_version');
          throw new Error('SYNTHETIC_ROLLBACK');
        }),
      ).rejects.toThrow('SYNTHETIC_ROLLBACK');
      const clusterId = z
        .string()
        .parse(
          (await inspector.query('SELECT system_identifier::text AS id FROM pg_control_system()'))
            .rows[0]?.id,
        );
      envelope = makeLocalReplayRecordEnvelope({
        clusterId,
        fromLsn: initialSlotLsn,
        previousHash: null,
        messages: await peekSuppressionPgoutput(inspector, slot),
      });
      ciphertext = encryptReplaySegment({ envelope, key, keyId }).bytes;
    });
    afterAll(async () => {
      if (inspector) {
        await inspector.query('SELECT pg_drop_replication_slot($1)', [slot]);
        await inspector.end();
      }
      await Promise.all([source?.end(), target?.end()]);
      if (admin) {
        try {
          for (const name of names) await dropIsolatedDatabase(admin, name);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        } finally {
          await admin.end();
        }
      }
    });
    it('has exact44 physical roster and INSERT-only publication', async () => {
      const columns = await inspector.query<{ attname: string; atttypid: number }>(
        'SELECT attname,atttypid::int FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',
        ['public.restore_suppression_event'],
      );
      expect(columns.rows).toHaveLength(44);
      expect(columns.rows.slice(-4)).toEqual(
        [
          'manual_review_source_kind',
          'manual_review_source_id',
          'manual_review_version_scope',
          'manual_review_version_key',
        ].map((attname) => ({ attname, atttypid: 25 })),
      );
      expect(
        (
          await inspector.query(
            'SELECT pubinsert,pubupdate,pubdelete,pubtruncate FROM pg_publication WHERE pubname=$1',
            ['workout_restore_suppression_events'],
          )
        ).rows,
      ).toEqual([{ pubinsert: true, pubupdate: false, pubdelete: false, pubtruncate: false }]);
    });
    it('decodes committed owner metadata with original IDs, microseconds and exact/null namespaces', async () => {
      const records = envelope.transactions.flatMap((transaction) => transaction.records);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.eventId)).toEqual([exactId, allId]);
      expect(records).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ eventId: rolledBackId })]),
      );
      expect(records[0]).toMatchObject({
        schemaVersion: 6,
        kind: 'manual_review_source_suppressed',
        occurredAt: '2026-10-01 00:00:00.123456+00',
        manualReviewSourceKind: 'session-completion',
        manualReviewVersionScope: 'exact_version',
        manualReviewVersionKey: exactKey,
      });
      expect(records[1]).toMatchObject({
        manualReviewVersionScope: 'all_versions',
        manualReviewVersionKey: null,
      });
      expect(
        (
          await inspector.query(
            'SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1',
            [slot],
          )
        ).rows[0]?.lsn,
      ).toBe(initialSlotLsn);
      expect(decryptReplaySegment({ bytes: ciphertext, key, expectedKeyId: keyId })).toEqual(
        envelope,
      );
    });
    it('authenticated local fixture chain replays into independent106 target idempotently without source-domain rows', async () => {
      expect((await replay()).eventCount).toBe(2);
      expect((await replay()).eventCount).toBe(2);
      await ownerTransaction(target, async (client) => {
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS n FROM restore_suppression_event WHERE athlete_id=$1',
              [athlete],
            )
          ).rows[0]?.n,
        ).toBe(2);
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS n FROM restore_manual_review_source_replay_receipt WHERE athlete_id=$1',
              [athlete],
            )
          ).rows[0]?.n,
        ).toBe(2);
        for (const table of [
          'race_event',
          'race_event_revision',
          'routine_run',
          'session_completion',
          'plan_snapshot',
          'race_manual_review',
        ])
          expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(
            0,
          );
      });
    });
  },
);
