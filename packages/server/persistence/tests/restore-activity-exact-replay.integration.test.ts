import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantOperations, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `activity_replay_${suffix}`;
const ownerRole = `activity_owner_${suffix}`;
const runtimeRole = `activity_app_${suffix}`;
const occurredAt = '2026-09-30 12:34:56+00';
let owner: Pool;
let runtime: Pool;

type Entry = {
  athleteId: string;
  targetId: string;
  eventId: string;
  activityRevision: number;
  sourceKind: 'fit' | 'fixture' | 'manual' | 'healthkit';
  sourceId: string;
  sourceRevision: number;
  sourceContentHash: string;
  occurredAt?: string;
};

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenant<T>(
  pool: Pool,
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function account(): Promise<string> {
  const result = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
       VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const id = result.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
}

function entry(athleteId: string, sourceKind: Entry['sourceKind'] = 'fixture'): Entry {
  return {
    athleteId,
    targetId: randomUUID(),
    eventId: randomUUID(),
    activityRevision: 2,
    sourceKind,
    sourceId: randomUUID(),
    sourceRevision: 1,
    sourceContentHash: sourceKind === 'healthkit' ? '0'.repeat(64) : 'a'.repeat(64),
  };
}

function args(item: Entry): unknown[] {
  return [
    item.athleteId,
    item.targetId,
    item.eventId,
    item.occurredAt ?? occurredAt,
    item.activityRevision,
    item.sourceKind,
    item.sourceId,
    item.sourceRevision,
    item.sourceContentHash,
  ];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_activity_deletion_exact: string }>(
      'SELECT public.replay_activity_deletion_exact($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      args(item),
    );
    return result.rows[0]?.replay_activity_deletion_exact ?? '';
  });
}

async function liveCanonical(item: Entry, hash = item.sourceContentHash): Promise<void> {
  await tenant(owner, item.athleteId, async (client) => {
    await client.query(
      `INSERT INTO activity_canonical(athlete_id,id,revision,original)
       VALUES($1,$2,$3,'{"title":"restored"}'::jsonb)`,
      [item.athleteId, item.targetId, item.activityRevision - 1],
    );
    await client.query(
      `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [item.athleteId, item.sourceKind, item.sourceId, item.sourceRevision, hash, item.targetId],
    );
  });
}

async function state(item: Entry) {
  const result = await tenant(owner, item.athleteId, (client) =>
    client.query<{
      event_count: string;
      receipt_count: string;
      revision: number | null;
      deleted: boolean | null;
      source_hash: string | null;
      suppressed: boolean;
      purge_pending: boolean;
    }>(
      `SELECT
        (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2) event_count,
        (SELECT count(*)::text FROM restore_activity_replay_receipt WHERE athlete_id=$1 AND target_id=$2) receipt_count,
        (SELECT revision FROM activity_canonical WHERE athlete_id=$1 AND id=$2) revision,
        (SELECT deleted FROM activity_canonical WHERE athlete_id=$1 AND id=$2) deleted,
        (SELECT content_hash FROM activity_source_head WHERE athlete_id=$1 AND activity_id=$2) source_hash,
        EXISTS(SELECT 1 FROM activity_suppression WHERE athlete_id=$1 AND kind=$3 AND source_id=$4) suppressed,
        EXISTS(SELECT 1 FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind='activity'
          AND scope_id=$2 AND completed_at IS NULL) purge_pending`,
      [item.athleteId, item.targetId, item.sourceKind, item.sourceId],
    ),
  );
  return result.rows[0];
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON activity_canonical,activity_source_head,
    activity_suppression TO "${runtimeRole}"`);
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('owner-only exact activity deletion replay', () => {
  it('replays an absent fixture tombstone with original event fields and exact retry', async () => {
    const item = entry(await account());
    expect(await replay(owner, item)).toBe('absent');
    expect(await replay(owner, item)).toBe('already_applied');
    expect(await state(item)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      revision: 2,
      deleted: true,
      source_hash: item.sourceContentHash,
      suppressed: true,
      purge_pending: true,
    });
    const stored = await tenant(owner, item.athleteId, (client) =>
      client.query<{
        event_id: string;
        occurred_at: string;
        activity_revision: number;
        source_kind: string;
        source_id: string;
        source_revision: number;
        source_content_hash: string;
      }>(
        `SELECT event_id,occurred_at::text,activity_revision,source_kind,source_id,
          source_revision,source_content_hash FROM restore_suppression_event WHERE event_id=$1`,
        [item.eventId],
      ),
    );
    expect(stored.rows[0]).toMatchObject({
      event_id: item.eventId,
      activity_revision: item.activityRevision,
      source_kind: item.sourceKind,
      source_id: item.sourceId,
      source_revision: item.sourceRevision,
      source_content_hash: item.sourceContentHash,
    });
    expect(Date.parse(stored.rows[0]?.occurred_at ?? '')).toBe(Date.parse(occurredAt));
    await expect(replay(owner, { ...item, sourceContentHash: 'b'.repeat(64) })).rejects.toThrow(
      'RESTORE_ACTIVITY_EVENT_CONFLICT',
    );
  });

  it('tombstones a present manual activity only at its immediate next revision', async () => {
    const item = entry(await account(), 'manual');
    await liveCanonical(item);
    expect(await replay(owner, item)).toBe('deleted');
    expect(await state(item)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      revision: 2,
      deleted: true,
      source_hash: item.sourceContentHash,
      suppressed: true,
      purge_pending: true,
    });
    const absent = entry(await account(), 'manual');
    await expect(replay(owner, absent)).rejects.toThrow(
      'RESTORE_ACTIVITY_MANUAL_ABSENT_UNSUPPORTED',
    );
    expect(await state(absent)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: null,
    });
  });

  it('redacts a present HealthKit raw sample and keeps the source zero hash', async () => {
    const item = entry(await account(), 'healthkit');
    await tenant(owner, item.athleteId, (client) =>
      client.query(
        `INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,
          source_bundle_id,activity_type,observed_from,observed_to,duration_seconds,payload_digest)
         VALUES($1,$2,$3,'active','synthetic.test',1,now()-interval '1 hour',now(),3600,$4)`,
        [item.athleteId, item.sourceId, randomUUID(), 'a'.repeat(64)],
      ),
    );
    await liveCanonical(item, 'a'.repeat(64));
    expect(await replay(owner, item)).toBe('deleted');
    expect(await state(item)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      revision: 2,
      deleted: true,
      source_hash: '0'.repeat(64),
      suppressed: true,
      purge_pending: true,
    });
    const raw = await tenant(owner, item.athleteId, (client) =>
      client.query<{ state: string; payload_digest: string | null }>(
        'SELECT state,payload_digest FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2',
        [item.athleteId, item.sourceId],
      ),
    );
    expect(raw.rows[0]).toMatchObject({ state: 'deleted', payload_digest: null });
    const absent = entry(await account(), 'healthkit');
    expect(await replay(owner, absent)).toBe('absent');
    expect(await state(absent)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      revision: 2,
      deleted: true,
      source_hash: '0'.repeat(64),
      suppressed: true,
      purge_pending: true,
    });
  });

  it('refuses a skipped revision and retains the restored live activity', async () => {
    const item = { ...entry(await account()), activityRevision: 3 };
    await liveCanonical({ ...item, activityRevision: 2 });
    await expect(replay(owner, item)).rejects.toThrow('RESTORE_ACTIVITY_STATE_CONFLICT');
    expect(await state(item)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: 1,
      deleted: false,
    });
  });

  it('keeps normal deletion event generation and refuses it without an exact replay receipt', async () => {
    const item = entry(await account());
    await liveCanonical(item);
    await tenant(owner, item.athleteId, async (client) => {
      await client.query(
        'INSERT INTO activity_suppression(athlete_id,kind,source_id) VALUES($1,$2,$3)',
        [item.athleteId, item.sourceKind, item.sourceId],
      );
      await client.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [item.athleteId, item.targetId],
      );
    });
    const live = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: string }>(
        `SELECT event_id,occurred_at::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='activity_deleted' AND target_id=$2`,
        [item.athleteId, item.targetId],
      ),
    );
    expect(live.rows).toHaveLength(1);
    const liveEvent = live.rows[0];
    if (!liveEvent) throw new Error('missing live event');
    await expect(
      replay(owner, {
        ...item,
        eventId: liveEvent.event_id,
        occurredAt: liveEvent.occurred_at,
      }),
    ).rejects.toThrow('RESTORE_ACTIVITY_RECEIPT_MISSING');
  });

  it('recognizes an exact activity event after a later exact tenant erasure', async () => {
    const item = entry(await account());
    expect(await replay(owner, item)).toBe('absent');
    await tenant(owner, item.athleteId, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        item.athleteId,
        randomUUID(),
        '2026-09-30 12:35:56+00',
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied_by_erasure');
  });

  it('rejects a foreign activity and rolls back an earlier owner replay in one transaction', async () => {
    const first = entry(await account());
    const foreign = entry(await account());
    await liveCanonical(foreign);
    await expect(
      tenant(owner, first.athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_activity_deletion_exact($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          args(first),
        );
        await client.query(
          'SELECT public.replay_activity_deletion_exact($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          args({ ...foreign, athleteId: first.athleteId }),
        );
      }),
    ).rejects.toThrow('RESTORE_ACTIVITY_FOREIGN_ACTIVITY');
    expect(await state(first)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: null,
    });
    expect(await state(foreign)).toMatchObject({ revision: 1, deleted: false });
  });

  it('denies runtime replay and rejects a runtime-spoofed suppression GUC', async () => {
    const item = entry(await account());
    await liveCanonical(item);
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_activity_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [item.athleteId, item.targetId],
        );
      }),
    ).rejects.toThrow('RESTORE_ACTIVITY_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: 1,
      deleted: false,
    });
  });
});
