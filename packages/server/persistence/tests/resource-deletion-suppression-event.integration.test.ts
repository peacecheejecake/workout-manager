import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrivateTextResourceCreate } from '@workout/contracts/resources';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPrivateTextResourceRepository, ResourceNotFoundError } from '../src/resources.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

type EventRow = {
  event_id: string;
  athlete_id: string;
  target_id: string;
  occurred_at: Date;
  resource_access_revision: number;
  activity_revision: number | null;
  source_kind: string | null;
  source_id: string | null;
  source_revision: number | null;
  source_content_hash: string | null;
};

async function events(tenant: string): Promise<EventRow[]> {
  const rows = await admin.query<EventRow>(
    `SELECT event_id,athlete_id,target_id::text,occurred_at,resource_access_revision,
       activity_revision,source_kind,source_id,source_revision,source_content_hash
     FROM restore_suppression_event WHERE athlete_id=$1 AND kind='resource_deleted'
     ORDER BY target_id`,
    [tenant],
  );
  return rows.rows;
}

function command(): PrivateTextResourceCreate {
  return {
    sourceKind: 'text',
    title: 'Private note',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic content for deletion.',
    idempotencyKey: randomUUID(),
  };
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 5 });
});

afterAll(async () => {
  await database?.close();
  await runtime.end();
  await admin.end();
});

describe('transaction-local resource deletion event', () => {
  it('records exactly one minimal event with the committed revision and time, then survives erasure', async () => {
    const tenant = randomUUID();
    const resources = createPrivateTextResourceRepository(database);
    const created = await resources.create(tenant, command());
    if (created.status !== 'available') throw new Error('Expected available resource');
    const deletion = {
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    };
    const deleted = await resources.softDelete(tenant, created.resource.id, deletion);
    expect(deleted.status).toBe('deleted');
    if (deleted.status !== 'deleted') throw new Error('Expected deleted resource');
    const first = await events(tenant);
    expect(first).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        target_id: created.resource.id,
        occurred_at: new Date(deleted.deletedAt),
        resource_access_revision: deleted.accessRevision,
        activity_revision: null,
        source_kind: null,
        source_id: null,
        source_revision: null,
        source_content_hash: null,
      },
    ]);
    expect(await resources.softDelete(tenant, created.resource.id, deletion)).toEqual(deleted);
    await expect(
      resources.softDelete(tenant, created.resource.id, {
        ...deletion,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await events(tenant)).toEqual(first);
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(first);
    expect(
      (await admin.query('SELECT 1 FROM resource WHERE athlete_id=$1', [tenant])).rows,
    ).toEqual([]);
  });

  it('rolls back an event with the deletion and rejects a foreign tenant', async () => {
    const firstTenant = randomUUID();
    const foreignTenant = randomUUID();
    const resources = createPrivateTextResourceRepository(database);
    const created = await resources.create(firstTenant, command());
    if (created.status !== 'available') throw new Error('Expected available resource');
    const deletion = {
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    };
    await expect(
      resources.softDelete(foreignTenant, created.resource.id, deletion),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await events(firstTenant)).toEqual([]);
    expect(await events(foreignTenant)).toEqual([]);

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
      createPrivateTextResourceRepository(broken).softDelete(
        firstTenant,
        created.resource.id,
        deletion,
      ),
    ).rejects.toThrow('injected outbox failure');
    expect(await events(firstTenant)).toEqual([]);
    expect((await resources.read(firstTenant, created.resource.id)).status).toBe('available');
    const deleted = await resources.softDelete(firstTenant, created.resource.id, deletion);
    expect(deleted.status).toBe('deleted');
    expect(await events(firstTenant)).toHaveLength(1);
    expect(await events(foreignTenant)).toEqual([]);
  });

  it('rejects missing resource revisions and unrelated event fields', async () => {
    const tenant = randomUUID();
    const target = randomUUID();
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
         VALUES($1,'resource_deleted',$2,now())`,
        [tenant, target],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at,
          resource_access_revision,activity_revision)
         VALUES($1,'resource_deleted',$2,now(),2,1)`,
        [tenant, target],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await events(tenant)).toEqual([]);
  });
});
