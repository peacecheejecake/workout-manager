import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `healthkit_replay_${suffix}`;
const ownerRole = `healthkit_owner_${suffix}`;
const runtimeRole = `healthkit_app_${suffix}`;
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
    const result = await client.query<{ replay_healthkit_consent_transition_exact: string }>(
      'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
      args(item),
    );
    return result.rows[0]?.replay_healthkit_consent_transition_exact ?? '';
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
      sample_count: string;
      digest_count: string;
    }>(
      `SELECT
        (SELECT revision FROM consent WHERE athlete_id=$1 AND kind='healthkit') revision,
        (SELECT granted FROM consent WHERE athlete_id=$1 AND kind='healthkit') granted,
        (SELECT count(*)::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='healthkit_consent_transition') event_count,
        (SELECT count(*)::text FROM restore_healthkit_consent_replay_receipt
         WHERE athlete_id=$1) receipt_count,
        (SELECT count(*)::text FROM outbox WHERE athlete_id=$1
          AND idempotency_key LIKE 'restore:healthkit_consent:%') outbox_count,
        (SELECT count(*)::text FROM healthkit_workout_sample WHERE athlete_id=$1) sample_count,
        (SELECT count(*)::text FROM healthkit_workout_batch_receipt
          WHERE athlete_id=$1 AND request_digest IS NOT NULL) digest_count`,
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

describe('owner-only exact HealthKit consent replay', () => {
  it('preserves exact grant, withdrawal and re-consent epochs and purges raw data', async () => {
    const athleteId = await account();
    const grant = await entry(athleteId, 1, true, null);
    expect(await replay(owner, grant)).toBe('transitioned');
    await tenant(owner, athleteId, async (client) => {
      await client.query(
        `INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,
           source_bundle_id,activity_type,observed_from,observed_to,duration_seconds,payload_digest)
         VALUES($1,$2,$3,'active','synthetic.test',37,now()-interval '1 hour',now(),3600,$4)`,
        [athleteId, randomUUID(), randomUUID(), 'a'.repeat(64)],
      );
      await client.query(
        `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,
           request_digest,accepted_count) VALUES($1,$2,$3,$4,1)`,
        [athleteId, randomUUID(), randomUUID(), 'b'.repeat(64)],
      );
    });
    const withdraw = await entry(athleteId, 2, false, true);
    await expect(
      tenant(owner, athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(withdraw),
        );
        await client.query(
          'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args({ ...(await entry(athleteId, 3, true, false)), previousGranted: true }),
        );
      }),
    ).rejects.toThrow('RESTORE_HEALTHKIT_STATE_CONFLICT');
    expect(await state(athleteId)).toMatchObject({
      revision: 1,
      granted: true,
      event_count: '1',
      receipt_count: '1',
      sample_count: '1',
      digest_count: '1',
    });
    expect(await replay(owner, withdraw)).toBe('transitioned');
    expect(await state(athleteId)).toMatchObject({
      revision: 2,
      granted: false,
      event_count: '2',
      receipt_count: '2',
      outbox_count: '2',
      sample_count: '0',
      digest_count: '0',
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
      sample_count: '0',
      digest_count: '0',
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
      'RESTORE_HEALTHKIT_EVENT_CONFLICT',
    );
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query('DELETE FROM restore_healthkit_consent_replay_receipt WHERE event_id=$1', [
          withdraw.eventId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('rejects absent, skipped and contradictory predecessor states', async () => {
    const athleteId = await account();
    const skipped = await entry(athleteId, 2, false, true);
    await expect(replay(owner, skipped)).rejects.toThrow('RESTORE_HEALTHKIT_STATE_CONFLICT');
    const grant = await entry(athleteId, 1, true, null);
    expect(await replay(owner, grant)).toBe('transitioned');
    await expect(replay(owner, { ...skipped, previousGranted: false })).rejects.toThrow(
      'RESTORE_HEALTHKIT_STATE_CONFLICT',
    );
    await expect(replay(owner, { ...grant, eventId: randomUUID() })).rejects.toThrow(
      'RESTORE_HEALTHKIT_EVENT_CONFLICT',
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
      client.query(
        "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
        [athleteId],
      ),
    );
    const event = await tenant(owner, athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: string }>(
        `SELECT event_id,occurred_at::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='healthkit_consent_transition'`,
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
    ).rejects.toThrow('RESTORE_HEALTHKIT_RECEIPT_MISSING');
  });

  it('rejects a foreign tenant and rolls back an earlier transition', async () => {
    const first = await account();
    const foreign = await account();
    const valid = await entry(first, 1, true, null);
    const other = await entry(foreign, 1, true, null);
    await expect(
      tenant(owner, first, async (client) => {
        await client.query(
          'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(valid),
        );
        await client.query(
          'SELECT public.replay_healthkit_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)',
          args(other),
        );
      }),
    ).rejects.toThrow('RESTORE_HEALTHKIT_INVALID_ENTRY');
    expect(await state(first)).toMatchObject({
      revision: null,
      event_count: '0',
      receipt_count: '0',
    });
    expect(await state(foreign)).toMatchObject({ revision: null });
  });

  it('denies runtime calls and a spoofed replay GUC', async () => {
    const athleteId = await account();
    const first = await entry(athleteId, 1, true, null);
    await expect(replay(runtime, first)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_healthkit_consent_event_id',$1,true)", [
          first.eventId,
        ]);
        await client.query(
          "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
          [athleteId],
        );
      }),
    ).rejects.toThrow('RESTORE_HEALTHKIT_OWNER_REQUIRED');
    expect(await state(athleteId)).toMatchObject({ revision: null, event_count: '0' });
  });
});
