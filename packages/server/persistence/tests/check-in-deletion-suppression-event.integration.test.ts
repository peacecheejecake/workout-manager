import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCheckInRepository } from '../src/check-ins.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCheckIns, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

const create = () => ({
  idempotencyKey: randomUUID(),
  values: {
    observedAt: '2026-01-02T23:00:00Z',
    timezone: 'Asia/Seoul',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: 'private deletion fixture',
  },
});

type DeletionEvent = {
  event_id: string;
  athlete_id: string;
  kind: string;
  target_id: string;
  check_in_revision: number;
  occurred_at: Date;
};

async function events(tenant: string): Promise<DeletionEvent[]> {
  const result = await admin.query<DeletionEvent>(
    `SELECT event_id,athlete_id,kind,target_id::text,check_in_revision,occurred_at
     FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='check_in_deleted' ORDER BY target_id`,
    [tenant],
  );
  return result.rows;
}

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON outbox TO workout_runtime');
  await admin.query('GRANT UPDATE(idempotency_key) ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});

afterAll(async () => {
  await database?.close();
  await runtime.end();
  await admin.end();
});

describe('transaction-local CheckIn deletion event', () => {
  it('records a minimal deletion tombstone once and keeps it after account erasure', async () => {
    const tenant = randomUUID();
    const repository = createCheckInRepository(database);
    const first = await repository.createCheckIn(tenant, create());
    const second = await repository.createCheckIn(tenant, create());
    const deletion = { idempotencyKey: randomUUID(), expectedRevision: 1 };
    const deleted = await repository.deleteCheckIn(tenant, first.id, deletion);
    expect(deleted).toMatchObject({ id: first.id, deleted: true, revision: 2 });
    const recorded = await events(tenant);
    expect(recorded).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'check_in_deleted',
        target_id: first.id,
        check_in_revision: 2,
        occurred_at: expect.any(Date),
      },
    ]);
    const tombstone = await admin.query(
      'SELECT revision,deleted,values_json,local_date,updated_at FROM check_in WHERE athlete_id=$1 AND id=$2',
      [tenant, first.id],
    );
    expect(tombstone.rows).toEqual([
      {
        revision: 2,
        deleted: true,
        values_json: null,
        local_date: null,
        updated_at: recorded[0]?.occurred_at,
      },
    ]);
    expect(await repository.deleteCheckIn(tenant, first.id, deletion)).toEqual(deleted);
    expect(await events(tenant)).toEqual(recorded);
    await expect(
      repository.deleteCheckIn(tenant, first.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 2,
      }),
    ).rejects.toThrow('CHECK_IN_NOT_FOUND');
    expect(await repository.getCheckIn(tenant, second.id)).not.toBeNull();
    const eventPayload = await admin.query(
      `SELECT to_jsonb(e) AS value FROM restore_suppression_event e
       WHERE athlete_id=$1 AND kind='check_in_deleted'`,
      [tenant],
    );
    expect(JSON.stringify(eventPayload.rows)).not.toContain('private deletion fixture');
    expect(JSON.stringify(eventPayload.rows)).not.toContain('Asia/Seoul');
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(recorded);
  });

  it('rolls back deletion, purge and event if a later outbox write fails', async () => {
    const tenant = randomUUID();
    const repository = createCheckInRepository(database);
    const created = await repository.createCheckIn(tenant, create());
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      createCheckInRepository(broken).deleteCheckIn(tenant, created.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toThrow('injected outbox failure');
    expect(await events(tenant)).toEqual([]);
    expect(await repository.getCheckIn(tenant, created.id)).toMatchObject({ revision: 1 });
    const history = await admin.query(
      'SELECT count(*)::int AS count FROM check_in_revision WHERE athlete_id=$1 AND check_in_id=$2',
      [tenant, created.id],
    );
    expect(history.rows[0]?.['count']).toBe(1);
  });

  it('denies foreign deletion and malformed or reversed tombstones', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const repository = createCheckInRepository(database);
    const created = await repository.createCheckIn(tenant, create());
    await expect(
      repository.deleteCheckIn(other, created.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toThrow('CHECK_IN_NOT_FOUND');
    expect(await events(tenant)).toEqual([]);
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
         VALUES($1,'check_in_deleted',$2,now())`,
        [tenant, created.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await repository.deleteCheckIn(tenant, created.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    await expect(
      database.tenant(tenant, (tx) =>
        tx.query(
          `UPDATE check_in SET deleted=false,values_json='{}'::jsonb,
             local_date='2026-01-03',revision=revision+1
           WHERE athlete_id=$1 AND id=$2`,
          [tenant, created.id],
        ),
      ),
    ).rejects.toThrow('CHECK_IN_DELETION_REVERSAL');
    expect(await events(tenant)).toHaveLength(1);
  });
});
