import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrivateTextResourceCreate } from '@workout/contracts/resources';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createResourceAccessRepository, ResourceAccessError } from '../src/resource-access.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

type ShareEvent = {
  event_id: string;
  athlete_id: string;
  target_id: string;
  share_id: string;
  share_granted_access_revision: number;
  share_revoked_access_revision: number;
  occurred_at: Date;
};

async function events(tenant: string): Promise<ShareEvent[]> {
  const result = await admin.query<ShareEvent>(
    `SELECT event_id,athlete_id,target_id::text,share_id::text,
       share_granted_access_revision,share_revoked_access_revision,occurred_at
     FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='resource_share_revoked' ORDER BY share_id`,
    [tenant],
  );
  return result.rows;
}

function command(): PrivateTextResourceCreate {
  return {
    sourceKind: 'text',
    title: 'Synthetic sharing note',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic private content.',
    idempotencyKey: randomUUID(),
  };
}

async function createResource(
  tenant: string,
): Promise<{ id: string; revision: number; versionId: string }> {
  const created = await createPrivateTextResourceRepository(database).create(tenant, command());
  if (created.status !== 'available') throw new Error('Expected available resource');
  return {
    id: created.resource.id,
    revision: created.resource.accessRevision,
    versionId: created.version.id,
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

describe('transaction-local resource share revocation event', () => {
  it('records the exact share and revisions without a grantee, survives retries and erasure', async () => {
    const tenant = randomUUID();
    const coach = randomUUID();
    const resource = await createResource(tenant);
    const access = createResourceAccessRepository(database);
    const granted = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: resource.revision,
      idempotencyKey: randomUUID(),
    });
    const shareId = granted.shares[0]?.shareId;
    if (!shareId) throw new Error('Expected one share');
    const request = {
      expectedAccessRevision: granted.accessRevision,
      idempotencyKey: randomUUID(),
    };
    const revoked = await access.revokeShare(tenant, resource.id, shareId, request);
    expect(revoked.accessRevision).toBe(granted.accessRevision + 1);
    const share = await admin.query<{
      revoked_at: Date;
      granted_access_revision: number;
      revoked_access_revision: number;
    }>(
      `SELECT revoked_at,granted_access_revision,revoked_access_revision
       FROM resource_share WHERE athlete_id=$1 AND share_id=$2`,
      [tenant, shareId],
    );
    const first = await events(tenant);
    expect(first).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        target_id: resource.id,
        share_id: shareId,
        share_granted_access_revision: share.rows[0]?.granted_access_revision,
        share_revoked_access_revision: share.rows[0]?.revoked_access_revision,
        occurred_at: share.rows[0]?.revoked_at,
      },
    ]);
    expect(first[0]?.share_revoked_access_revision).toBe(revoked.accessRevision);
    expect(await access.revokeShare(tenant, resource.id, shareId, request)).toEqual(revoked);
    await access.revokeShare(tenant, resource.id, shareId, {
      expectedAccessRevision: revoked.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(await events(tenant)).toEqual(first);
    expect((await access.listSharedWithMe(coach)).items).toEqual([]);

    const payload = await admin.query(
      `SELECT to_jsonb(e) AS value FROM restore_suppression_event e
       WHERE athlete_id=$1 AND kind='resource_share_revoked'`,
      [tenant],
    );
    expect(JSON.stringify(payload.rows)).not.toContain(coach);
    expect(JSON.stringify(payload.rows)).not.toContain('Synthetic private content');
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(first);
    expect(
      (await admin.query('SELECT 1 FROM resource_share WHERE athlete_id=$1', [tenant])).rows,
    ).toEqual([]);
  });

  it('rolls back with a late command failure and rejects another tenant', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const resource = await createResource(tenant);
    const access = createResourceAccessRepository(database);
    const granted = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: resource.revision,
      idempotencyKey: randomUUID(),
    });
    const shareId = granted.shares[0]?.shareId;
    if (!shareId) throw new Error('Expected one share');
    const request = {
      expectedAccessRevision: granted.accessRevision,
      idempotencyKey: randomUUID(),
    };
    await expect(access.revokeShare(other, resource.id, shareId, request)).rejects.toBeInstanceOf(
      ResourceAccessError,
    );
    expect(await events(other)).toEqual([]);
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
      createResourceAccessRepository(broken).revokeShare(tenant, resource.id, shareId, request),
    ).rejects.toThrow('injected outbox failure');
    expect(await events(tenant)).toEqual([]);
    const stillActive = await admin.query<{ state: string }>(
      'SELECT state FROM resource_share WHERE athlete_id=$1 AND share_id=$2',
      [tenant, shareId],
    );
    expect(stillActive.rows).toEqual([{ state: 'active' }]);
    expect((await access.listSharedWithMe(other)).items).toEqual([]);
    await access.revokeShare(tenant, resource.id, shareId, request);
    expect(await events(tenant)).toHaveLength(1);
    expect(await events(other)).toEqual([]);
  });

  it('targets one share without revoking another grant on the same resource', async () => {
    const tenant = randomUUID();
    const firstCoach = randomUUID();
    const secondCoach = randomUUID();
    const resource = await createResource(tenant);
    const access = createResourceAccessRepository(database);
    const first = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: firstCoach,
      expectedAccessRevision: resource.revision,
      idempotencyKey: randomUUID(),
    });
    const firstShare = first.shares[0]?.shareId;
    if (!firstShare) throw new Error('Expected first share');
    const second = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: secondCoach,
      expectedAccessRevision: first.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const secondShare = second.shares.find(
      (share) => share.state === 'active' && share.shareId !== firstShare,
    )?.shareId;
    if (!secondShare || secondShare === firstShare)
      throw new Error('Expected distinct second share');
    await access.revokeShare(tenant, resource.id, firstShare, {
      expectedAccessRevision: second.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(await events(tenant)).toMatchObject([{ target_id: resource.id, share_id: firstShare }]);
    expect((await access.listSharedWithMe(firstCoach)).items).toEqual([]);
    expect(
      (await access.listSharedWithMe(secondCoach)).items.map((item) => item.resourceId),
    ).toEqual([resource.id]);
    const state = await admin.query<{ share_id: string; state: string }>(
      'SELECT share_id::text,state FROM resource_share WHERE athlete_id=$1 AND share_id=$2',
      [tenant, secondShare],
    );
    expect(state.rows).toEqual([{ share_id: secondShare, state: 'active' }]);
  });

  it('retains account-erasure share transitions with their own revisions', async () => {
    const tenant = randomUUID();
    const resource = await createResource(tenant);
    const access = createResourceAccessRepository(database);
    const first = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: resource.revision,
      idempotencyKey: randomUUID(),
    });
    const second = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: first.accessRevision,
      idempotencyKey: randomUUID(),
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    const recorded = await events(tenant);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((row) => row.share_granted_access_revision).sort((a, b) => a - b)).toEqual([
      first.accessRevision,
      second.accessRevision,
    ]);
    expect(recorded.map((row) => row.share_revoked_access_revision).sort((a, b) => a - b)).toEqual([
      first.accessRevision + 1,
      second.accessRevision + 1,
    ]);
    expect(recorded.some((row) => row.share_revoked_access_revision > second.accessRevision)).toBe(
      true,
    );
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count FROM restore_suppression_event
           WHERE athlete_id=$1 AND kind='tenant_erased'`,
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('captures a share revoked by resource deletion and rejects malformed rows', async () => {
    const tenant = randomUUID();
    const resource = await createResource(tenant);
    const access = createResourceAccessRepository(database);
    const granted = await access.grantShare(tenant, resource.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: resource.revision,
      idempotencyKey: randomUUID(),
    });
    const shareId = granted.shares[0]?.shareId;
    if (!shareId) throw new Error('Expected one share');
    const resources = createPrivateTextResourceRepository(database);
    await resources.softDelete(tenant, resource.id, {
      expectedAccessRevision: granted.accessRevision,
      expectedCurrentVersionId: resource.versionId,
      idempotencyKey: randomUUID(),
    });
    expect(await events(tenant)).toMatchObject([{ target_id: resource.id, share_id: shareId }]);
    const deleted = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='resource_deleted'`,
      [tenant],
    );
    expect(deleted.rows[0]?.count).toBe(1);
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event
           (athlete_id,kind,target_id,share_id,occurred_at,
            share_granted_access_revision,share_revoked_access_revision)
         VALUES($1,'resource_share_revoked',$2,$3,now(),2,2)`,
        [tenant, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event
           (athlete_id,kind,target_id,share_id,occurred_at,
            resource_access_revision,share_granted_access_revision,share_revoked_access_revision)
         VALUES($1,'resource_deleted',$2,$3,now(),3,1,2)`,
        [tenant, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
