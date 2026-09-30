import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `ai_replay_${suffix}`;
const ownerRole = `ai_owner_${suffix}`;
const runtimeRole = `ai_app_${suffix}`;
let owner: Pool;
let runtime: Pool;

type Entry = {
  athleteId: string;
  eventId: string;
  occurredAt: string;
  previousRevision: number | null;
  previousGranted: boolean | null;
  revision: number;
  granted: boolean;
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

async function entry(
  athleteId: string,
  revision: number,
  granted: boolean,
  previousGranted: boolean | null,
): Promise<Entry> {
  const time = await owner.query<{ occurred_at: string }>(
    'SELECT clock_timestamp()::text AS occurred_at',
  );
  const occurredAt = time.rows[0]?.occurred_at;
  if (!occurredAt) throw new Error('missing replay time');
  return {
    athleteId,
    eventId: randomUUID(),
    occurredAt,
    previousRevision: revision === 1 ? null : revision - 1,
    previousGranted,
    revision,
    granted,
  };
}

function args(item: Entry): unknown[] {
  return [
    item.athleteId,
    item.eventId,
    item.occurredAt,
    item.previousRevision,
    item.previousGranted,
    item.revision,
    item.granted,
  ];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_ai_consent_transition_exact: string }>(
      'SELECT public.replay_ai_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
      args(item),
    );
    return result.rows[0]?.replay_ai_consent_transition_exact ?? '';
  });
}

async function state(athleteId: string) {
  const result = await tenant(owner, athleteId, (client) =>
    client.query<{
      revision: number | null;
      granted: boolean | null;
      event_count: string;
      receipt_count: string;
      outbox_count: string;
      evidence_live_count: string;
      evidence_purged_count: string;
    }>(
      `SELECT
        (SELECT revision FROM consent WHERE athlete_id=$1 AND kind='ai') revision,
        (SELECT granted FROM consent WHERE athlete_id=$1 AND kind='ai') granted,
        (SELECT count(*)::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='ai_consent_transition') event_count,
        (SELECT count(*)::text FROM restore_ai_consent_replay_receipt
         WHERE athlete_id=$1) receipt_count,
        (SELECT count(*)::text FROM outbox WHERE athlete_id=$1
          AND idempotency_key LIKE 'restore:ai_consent:%') outbox_count,
        (SELECT count(*)::text FROM core_evidence_snapshot
          WHERE athlete_id=$1 AND body IS NOT NULL) evidence_live_count,
        (SELECT count(*)::text FROM core_evidence_snapshot
          WHERE athlete_id=$1 AND body IS NULL AND purged_reason='consent_withdrawn')
          evidence_purged_count`,
      [athleteId],
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
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON consent TO "${runtimeRole}"`);
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('owner-only exact AI consent replay', () => {
  it('preserves exact grant, withdrawal and re-consent epochs and purges evidence', async () => {
    const athleteId = await account();
    const grant = await entry(athleteId, 1, true, null);
    expect(await replay(owner, grant)).toBe('transitioned');
    await tenant(owner, athleteId, async (client) => {
      const planId = randomUUID();
      const threadId = randomUUID();
      await client.query(
        `INSERT INTO plan_snapshot(athlete_id,id,version,draft)
         VALUES($1,$2,1,'{}'::jsonb)`,
        [athleteId, planId],
      );
      await client.query(
        `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision)
         VALUES($1,$2,$3,'Synthetic thread',
           '{"kind":"session","targetId":"session"}'::jsonb,1)`,
        [athleteId, threadId, planId],
      );
      await client.query(
        `INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body)
         VALUES($1,$2,$3,clock_timestamp(),$4::jsonb)`,
        [athleteId, randomUUID(), threadId, JSON.stringify({ private: 'Synthetic evidence' })],
      );
    });
    const withdraw = await entry(athleteId, 2, false, true);
    await expect(
      tenant(owner, athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_ai_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(withdraw),
        );
        await client.query(
          'SELECT public.replay_ai_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args({ ...(await entry(athleteId, 3, true, false)), previousGranted: true }),
        );
      }),
    ).rejects.toThrow('RESTORE_AI_STATE_CONFLICT');
    expect(await state(athleteId)).toMatchObject({
      revision: 1,
      granted: true,
      event_count: '1',
      receipt_count: '1',
      evidence_live_count: '1',
      evidence_purged_count: '0',
    });
    expect(await replay(owner, withdraw)).toBe('transitioned');
    expect(await state(athleteId)).toMatchObject({
      revision: 2,
      granted: false,
      event_count: '2',
      receipt_count: '2',
      outbox_count: '2',
      evidence_live_count: '0',
      evidence_purged_count: '1',
    });
    const reconsent = await entry(athleteId, 3, true, false);
    expect(await replay(owner, reconsent)).toBe('transitioned');
    expect(await replay(owner, grant)).toBe('already_applied');
    expect(await replay(owner, withdraw)).toBe('already_applied');
    expect(await replay(owner, reconsent)).toBe('already_applied');
    expect(await state(athleteId)).toMatchObject({
      revision: 3,
      granted: true,
      event_count: '3',
      receipt_count: '3',
      outbox_count: '3',
      evidence_live_count: '0',
      evidence_purged_count: '1',
    });
    const event = await tenant(owner, athleteId, (client) =>
      client.query<{
        event_id: string;
        occurred_at: Date;
        consent_previous_revision: number;
        consent_previous_granted: boolean;
        consent_revision: number;
        consent_granted: boolean;
      }>(
        `SELECT event_id,occurred_at,consent_previous_revision,
           consent_previous_granted,consent_revision,consent_granted
         FROM restore_suppression_event WHERE event_id=$1`,
        [withdraw.eventId],
      ),
    );
    expect(event.rows[0]).toEqual({
      event_id: withdraw.eventId,
      occurred_at: new Date(withdraw.occurredAt),
      consent_previous_revision: 1,
      consent_previous_granted: true,
      consent_revision: 2,
      consent_granted: false,
    });
    await expect(replay(owner, { ...withdraw, previousGranted: false })).rejects.toThrow(
      'RESTORE_AI_EVENT_CONFLICT',
    );
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query('DELETE FROM restore_ai_consent_replay_receipt WHERE event_id=$1', [
          withdraw.eventId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('rejects absent, skipped and contradictory predecessor states', async () => {
    const athleteId = await account();
    const skipped = await entry(athleteId, 2, false, true);
    await expect(replay(owner, skipped)).rejects.toThrow('RESTORE_AI_STATE_CONFLICT');
    const grant = await entry(athleteId, 1, true, null);
    expect(await replay(owner, grant)).toBe('transitioned');
    await expect(replay(owner, { ...skipped, previousGranted: false })).rejects.toThrow(
      'RESTORE_AI_STATE_CONFLICT',
    );
    await expect(replay(owner, { ...grant, eventId: randomUUID() })).rejects.toThrow(
      'RESTORE_AI_EVENT_CONFLICT',
    );
    expect(await state(athleteId)).toMatchObject({
      revision: 1,
      granted: true,
      event_count: '1',
      receipt_count: '1',
    });
  });

  it('does not accept an ordinary event as an exact receipt', async () => {
    const athleteId = await account();
    await tenant(owner, athleteId, (client) =>
      client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',true,1)", [
        athleteId,
      ]),
    );
    const event = await tenant(owner, athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: string }>(
        `SELECT event_id,occurred_at::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='ai_consent_transition'`,
        [athleteId],
      ),
    );
    const original = event.rows[0];
    if (!original) throw new Error('missing ordinary event');
    await expect(
      replay(owner, {
        athleteId,
        eventId: original.event_id,
        occurredAt: original.occurred_at,
        previousRevision: null,
        previousGranted: null,
        revision: 1,
        granted: true,
      }),
    ).rejects.toThrow('RESTORE_AI_RECEIPT_MISSING');
  });

  it('rejects a foreign tenant and rolls back an earlier transition', async () => {
    const first = await account();
    const foreign = await account();
    const valid = await entry(first, 1, true, null);
    const other = await entry(foreign, 1, true, null);
    await expect(
      tenant(owner, first, async (client) => {
        await client.query(
          'SELECT public.replay_ai_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(valid),
        );
        await client.query(
          'SELECT public.replay_ai_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(other),
        );
      }),
    ).rejects.toThrow('RESTORE_AI_INVALID_ENTRY');
    expect(await state(first)).toMatchObject({
      revision: null,
      event_count: '0',
      receipt_count: '0',
    });
    expect(await state(foreign)).toMatchObject({ revision: null });
  });

  it('serializes concurrent copies of the same event into one transition', async () => {
    const athleteId = await account();
    const first = await entry(athleteId, 1, true, null);
    const results = await Promise.all([replay(owner, first), replay(owner, first)]);
    expect(results.sort()).toEqual(['already_applied', 'transitioned']);
    expect(await state(athleteId)).toMatchObject({
      revision: 1,
      granted: true,
      event_count: '1',
      receipt_count: '1',
      outbox_count: '1',
    });
  });

  it('denies runtime calls and a spoofed replay GUC', async () => {
    const athleteId = await account();
    const first = await entry(athleteId, 1, true, null);
    await expect(replay(runtime, first)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_ai_consent_event_id',$1,true)", [
          first.eventId,
        ]);
        await client.query(
          "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',true,1)",
          [athleteId],
        );
      }),
    ).rejects.toThrow('RESTORE_AI_OWNER_REQUIRED');
    expect(await state(athleteId)).toMatchObject({ revision: null, event_count: '0' });
  });
});
