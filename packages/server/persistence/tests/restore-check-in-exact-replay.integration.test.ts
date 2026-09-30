import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCheckInRepository } from '../src/check-ins.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCheckIns, grantOperations, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `checkin_replay_${suffix}`;
const ownerRole = `checkin_owner_${suffix}`;
const runtimeRole = `checkin_app_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;

type Entry = {
  athleteId: string;
  targetId: string;
  eventId: string;
  occurredAt: string;
  revision: number;
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

async function liveCheckIn(athleteId: string): Promise<Entry> {
  const created = await createCheckInRepository(database).createCheckIn(athleteId, {
    idempotencyKey: randomUUID(),
    values: {
      observedAt: '2026-01-02T23:00:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: 'Private replay fixture',
    },
  });
  const time = await owner.query<{ occurred_at: string }>(
    'SELECT clock_timestamp()::text AS occurred_at',
  );
  const occurredAt = time.rows[0]?.occurred_at;
  if (!occurredAt) throw new Error('missing replay time');
  return {
    athleteId,
    targetId: created.id,
    eventId: randomUUID(),
    occurredAt,
    revision: created.revision + 1,
  };
}

function args(item: Entry): unknown[] {
  return [item.athleteId, item.targetId, item.eventId, item.occurredAt, item.revision];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_check_in_deletion_exact: string }>(
      'SELECT public.replay_check_in_deletion_exact($1,$2,$3,$4,$5)',
      args(item),
    );
    return result.rows[0]?.replay_check_in_deletion_exact ?? '';
  });
}

async function state(item: Entry) {
  const result = await tenant(owner, item.athleteId, (client) =>
    client.query<{
      event_count: string;
      receipt_count: string;
      history_count: string;
      outbox_count: string;
      collection_revision: number | null;
      revision: number | null;
      deleted: boolean | null;
      updated_at: Date | null;
      values_json: unknown;
    }>(
      `SELECT
        (SELECT count(*)::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='check_in_deleted' AND target_id=$2) event_count,
        (SELECT count(*)::text FROM restore_check_in_replay_receipt
         WHERE athlete_id=$1 AND target_id=$2) receipt_count,
        (SELECT count(*)::text FROM check_in_revision
         WHERE athlete_id=$1 AND check_in_id=$2) history_count,
        (SELECT count(*)::text FROM outbox
         WHERE athlete_id=$1 AND id=$3 AND topic='checkin.changed') outbox_count,
        (SELECT revision FROM check_in_collection_head WHERE athlete_id=$1) collection_revision,
        (SELECT revision FROM check_in WHERE athlete_id=$1 AND id=$2) revision,
        (SELECT deleted FROM check_in WHERE athlete_id=$1 AND id=$2) deleted,
        (SELECT updated_at FROM check_in WHERE athlete_id=$1 AND id=$2) updated_at,
        (SELECT values_json FROM check_in WHERE athlete_id=$1 AND id=$2) values_json`,
      [item.athleteId, item.targetId, item.eventId],
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
  await grantCheckIns(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT ON outbox TO "${runtimeRole}"`);
  await owner.query(`GRANT UPDATE(idempotency_key) ON outbox TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole) });
});

afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('owner-only exact check-in deletion replay', () => {
  it('preserves event identity, time and revision, cleans history, and retries exactly', async () => {
    const item = await liveCheckIn(await account());
    expect(await replay(owner, item)).toBe('deleted');
    expect(await replay(owner, item)).toBe('already_applied');
    expect(await state(item)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      history_count: '0',
      outbox_count: '1',
      collection_revision: 2,
      revision: item.revision,
      deleted: true,
      updated_at: new Date(item.occurredAt),
      values_json: null,
    });
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{
        event_id: string;
        athlete_id: string;
        target_id: string;
        occurred_at: Date;
        check_in_revision: number;
      }>(
        `SELECT event_id,athlete_id,target_id,occurred_at,check_in_revision
         FROM restore_suppression_event WHERE event_id=$1`,
        [item.eventId],
      ),
    );
    expect(event.rows[0]).toEqual({
      event_id: item.eventId,
      athlete_id: item.athleteId,
      target_id: item.targetId,
      occurred_at: new Date(item.occurredAt),
      check_in_revision: item.revision,
    });
    await tenant(owner, item.athleteId, (client) =>
      client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
        item.athleteId,
        item.eventId,
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied');
    await expect(replay(owner, { ...item, revision: item.revision + 1 })).rejects.toThrow(
      'RESTORE_CHECK_IN_EVENT_CONFLICT',
    );
    await expect(
      tenant(owner, item.athleteId, (client) =>
        client.query('DELETE FROM restore_check_in_replay_receipt WHERE event_id=$1', [
          item.eventId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('rejects absent and skipped-revision heads without side effects', async () => {
    const athleteId = await account();
    const absent: Entry = {
      athleteId,
      targetId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      revision: 2,
    };
    await expect(replay(owner, absent)).rejects.toThrow('RESTORE_CHECK_IN_ABSENT_UNSUPPORTED');
    const live = await liveCheckIn(athleteId);
    await expect(replay(owner, { ...live, revision: 3 })).rejects.toThrow(
      'RESTORE_CHECK_IN_STATE_CONFLICT',
    );
    expect(await state(live)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      history_count: '1',
      collection_revision: 1,
      revision: 1,
      deleted: false,
    });
  });

  it('does not accept an ordinary deletion event as an exact receipt', async () => {
    const item = await liveCheckIn(await account());
    await createCheckInRepository(database).deleteCheckIn(item.athleteId, item.targetId, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    const result = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: string }>(
        `SELECT event_id,occurred_at::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='check_in_deleted' AND target_id=$2`,
        [item.athleteId, item.targetId],
      ),
    );
    const event = result.rows[0];
    if (!event) throw new Error('missing ordinary event');
    await expect(
      replay(owner, {
        ...item,
        eventId: event.event_id,
        occurredAt: event.occurred_at,
      }),
    ).rejects.toThrow('RESTORE_CHECK_IN_RECEIPT_MISSING');
  });

  it('fails closed when the live head has lost its prior revision', async () => {
    const item = await liveCheckIn(await account());
    await tenant(owner, item.athleteId, (client) =>
      client.query('DELETE FROM check_in_revision WHERE athlete_id=$1 AND check_in_id=$2', [
        item.athleteId,
        item.targetId,
      ]),
    );
    await expect(replay(owner, item)).rejects.toThrow('RESTORE_CHECK_IN_STATE_CONFLICT');
    expect(await state(item)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: 1,
      deleted: false,
    });
  });

  it('recognizes an earlier exact deletion after exact tenant erasure', async () => {
    const item = await liveCheckIn(await account());
    expect(await replay(owner, item)).toBe('deleted');
    await tenant(owner, item.athleteId, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        item.athleteId,
        randomUUID(),
        new Date().toISOString(),
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied_by_erasure');
  });

  it('rejects a foreign target and rolls back an earlier replay in the transaction', async () => {
    const first = await liveCheckIn(await account());
    const foreign = await liveCheckIn(await account());
    await expect(
      tenant(owner, first.athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_check_in_deletion_exact($1,$2,$3,$4,$5)',
          args(first),
        );
        await client.query(
          'SELECT public.replay_check_in_deletion_exact($1,$2,$3,$4,$5)',
          args({ ...foreign, athleteId: first.athleteId }),
        );
      }),
    ).rejects.toThrow('RESTORE_CHECK_IN_FOREIGN_TARGET');
    expect(await state(first)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      history_count: '1',
      collection_revision: 1,
      revision: 1,
      deleted: false,
    });
    expect(await state(foreign)).toMatchObject({ revision: 1, deleted: false });
  });

  it('denies runtime replay and a spoofed replay GUC', async () => {
    const item = await liveCheckIn(await account());
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_check_in_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `UPDATE check_in SET revision=$3,deleted=true,values_json=NULL,
             local_date=NULL,updated_at=$4 WHERE athlete_id=$1 AND id=$2`,
          [item.athleteId, item.targetId, item.revision, item.occurredAt],
        );
      }),
    ).rejects.toThrow('RESTORE_CHECK_IN_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: 1,
      deleted: false,
    });
  });
});
