import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  validateSuppressionRecord,
  type SuppressionRecord,
} from '../src/restore-suppression-records.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import {
  prepareVerifiedSuppressionChain,
  replayVerifiedSuppressionChainIn,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';

// Actual owner transactions and exact SQL replay. Synthetic authenticated artifacts
// prove this composition boundary only; no admission or generation is opened.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `replay_tx_owner_${suffix}`;
const names = [`replay_tx_source_${suffix}`, `replay_tx_target_${suffix}`];
const key = Buffer.alloc(32, 84),
  keyId = 'synthetic-replay-tx',
  clusterId = '123456789';
let source: Pool, target: Pool;
function url(name: string) {
  const u = new URL(adminUrl as string);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function tenant<T>(pool: Pool, id: string, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`);
    await migrate(url(name));
  }
  source = new Pool({ connectionString: url(names[0] as string) });
  target = new Pool({ connectionString: url(names[1] as string) });
});
afterAll(async () => {
  await source?.end();
  await target?.end();
  for (const name of names) await dropIsolatedDatabase(admin, name);
  await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function fixture() {
  const id = randomUUID();
  for (const pool of [source, target])
    await pool.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [id, 'https://issuer.test', randomUUID()],
    );
  await tenant(source, id, async (c) => {
    await c.query("INSERT INTO consent VALUES($1,'app',true,1)", [id]);
    await c.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [id],
    );
    await c.query("UPDATE consent SET granted=true,revision=3 WHERE athlete_id=$1 AND kind='app'", [
      id,
    ]);
  });
  const rows = await tenant(source, id, (c) =>
    c.query(
      "SELECT e.*,e.occurred_at::text AS occurred_at FROM restore_suppression_event e WHERE athlete_id=$1 AND kind='app_consent_transition' ORDER BY consent_revision",
      [id],
    ),
  );
  const records = rows.rows.map((row) =>
    validateSuppressionRecord(
      new Map(
        Object.entries(row).map(([name, value]) => [
          name,
          value === null ? null : typeof value === 'boolean' ? (value ? 't' : 'f') : String(value),
        ]),
      ),
    ),
  );
  expect(records).toHaveLength(3);
  return { id, records };
}
function chain(records: readonly SuppressionRecord[]) {
  const body = {
    localRecordVersion: 1 as const,
    clusterId,
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: [...records] }],
  };
  const envelope: LocalReplayRecordEnvelope = {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
  const anchor: TrustedReplayAnchor = {
    clusterId,
    fromLsn: body.fromLsn,
    throughLsn: body.throughLsn,
    previousHash: null,
    finalLocalHash: envelope.sha256,
    ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
  };
  return { segments: [bytes], key, keyId, anchor };
}
async function state(id: string) {
  return tenant(
    target,
    id,
    async (c) =>
      (
        await c.query(
          `SELECT (SELECT revision FROM consent WHERE athlete_id=$1 AND kind='app') revision,(SELECT granted FROM consent WHERE athlete_id=$1 AND kind='app') granted,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND kind='app_consent_transition') events,(SELECT count(*)::int FROM restore_app_consent_replay_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND idempotency_key LIKE 'restore:app_consent:%') outbox`,
          [id],
        )
      ).rows[0],
  );
}

it('rolls authenticated replay and exact receipts back with a subsequent owner SQL failure', async () => {
  const { id, records } = await fixture();
  const handle = prepareVerifiedSuppressionChain(chain(records));
  const before = await state(id);
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    expect(await replayVerifiedSuppressionChainIn(client, handle)).toEqual(handle.summary);
    const staged = await client.query(
      "SELECT (SELECT revision FROM consent WHERE athlete_id=$1 AND kind='app') revision,(SELECT count(*)::int FROM restore_app_consent_replay_receipt WHERE athlete_id=$1) receipts",
      [id],
    );
    expect(staged.rows).toEqual([{ revision: 3, receipts: 3 }]);
    await expect(client.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect(await state(id)).toEqual(before);
  // Same process-local authenticated handle can retry only in a new owner transaction.
  await tenant(target, id, (client) => replayVerifiedSuppressionChainIn(client, handle));
  expect(await state(id)).toEqual({
    revision: 3,
    granted: true,
    events: 3,
    receipts: 3,
    outbox: 3,
  });
});

it('commits authenticated replay only with the caller transaction and preserves exact replay', async () => {
  const { id, records } = await fixture();
  const handle = prepareVerifiedSuppressionChain(chain(records));
  const before = await state(id);
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await replayVerifiedSuppressionChainIn(client, handle);
    // Another owner connection cannot see uncommitted writes: replayIn did not commit.
    expect(await state(id)).toEqual(before);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const committed = await state(id);
  expect(committed).toEqual({ revision: 3, granted: true, events: 3, receipts: 3, outbox: 3 });
  await tenant(target, id, (client) => replayVerifiedSuppressionChainIn(client, handle));
  expect(await state(id)).toEqual(committed);
});

it('rejects copied or caller-constructed handles before SQL and leaves the caller transaction usable', async () => {
  const { id, records } = await fixture();
  const handle = prepareVerifiedSuppressionChain(chain(records));
  const before = await state(id);
  const sentinel = randomUUID();
  await tenant(target, sentinel, async (client) => {
    for (const copy of [{ ...handle }, { summary: { ...handle.summary } }]) {
      await expect(replayVerifiedSuppressionChainIn(client, copy)).rejects.toThrow(
        'RESTORE_REPLAY_PREFLIGHT_FAILED',
      );
      expect(
        (await client.query("SELECT current_setting('app.athlete_id') athlete, 1 AS usable")).rows,
      ).toEqual([{ athlete: sentinel, usable: 1 }]);
    }
  });
  expect(await state(id)).toEqual(before);
});
