import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

async function resource(tenant: string) {
  const created = await createPrivateTextResourceRepository(database).create(tenant, {
    sourceKind: 'text',
    title: 'Synthetic cause test',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic content.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Expected resource');
  return {
    id: created.resource.id,
    revision: created.resource.accessRevision,
    versionId: created.version.id,
  };
}

async function grants(tenant: string, count: number) {
  const target = await resource(tenant);
  let revision = target.revision;
  const shareIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const state = await createResourceAccessRepository(database).grantShare(tenant, target.id, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: revision,
      idempotencyKey: randomUUID(),
    });
    const share = state.shares.find(
      (item) => item.state === 'active' && !shareIds.includes(item.shareId),
    );
    if (!share) throw new Error('Expected share');
    shareIds.push(share.shareId);
    revision = state.accessRevision;
  }
  return { ...target, revision, shareIds };
}

type Event = {
  event_id: string;
  kind: string;
  target_id: string | null;
  share_id: string | null;
  record_version: number;
  share_cause_kind: string | null;
  share_cause_event_id: string | null;
  share_granted_access_revision: number | null;
  share_revoked_access_revision: number | null;
  resource_access_revision: number | null;
};
async function events(tenant: string): Promise<Event[]> {
  const result = await admin.query<Event>(
    `SELECT event_id::text,kind,target_id::text,share_id::text,record_version,
       share_cause_kind,share_cause_event_id::text,share_granted_access_revision,
       share_revoked_access_revision,resource_access_revision
     FROM restore_suppression_event WHERE athlete_id=$1
       AND kind IN ('resource_share_revoked','resource_deleted','tenant_erased')`,
    [tenant],
  );
  return result.rows;
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

describe('future-only resource share cause ledger', () => {
  for (const count of [0, 1, 3]) {
    it(`binds ${count} resource-deletion share events to the committed parent`, async () => {
      const tenant = randomUUID();
      const target = await grants(tenant, count);
      await createPrivateTextResourceRepository(database).softDelete(tenant, target.id, {
        expectedAccessRevision: target.revision,
        expectedCurrentVersionId: target.versionId,
        idempotencyKey: randomUUID(),
      });
      const recorded = await events(tenant);
      const parent = recorded.find((item) => item.kind === 'resource_deleted');
      const children = recorded.filter((item) => item.kind === 'resource_share_revoked');
      expect(parent).toBeDefined();
      expect(children).toHaveLength(count);
      expect(children.map((item) => item.share_id).sort()).toEqual([...target.shareIds].sort());
      for (const child of children) {
        expect(child.record_version).toBe(2);
        expect(child.share_cause_kind).toBe('resource_deleted');
        expect(child.share_cause_event_id).toBe(parent?.event_id);
        expect(child.share_revoked_access_revision).toBe(parent?.resource_access_revision);
        expect(child.target_id).toBe(target.id);
      }
      expect(
        (await admin.query('SELECT count(*)::int AS count FROM restore_share_erasure_context'))
          .rows[0]?.count,
      ).toBe(0);
    });
    it(`binds ${count} erasure share events to the later parent`, async () => {
      const tenant = randomUUID();
      const target = await grants(tenant, count);
      await createOperationsRepository(database).eraseAccount(tenant);
      const recorded = await events(tenant);
      const parent = recorded.find((item) => item.kind === 'tenant_erased');
      const children = recorded.filter((item) => item.kind === 'resource_share_revoked');
      expect(parent).toBeDefined();
      expect(children).toHaveLength(count);
      expect(children.map((item) => item.share_id).sort()).toEqual([...target.shareIds].sort());
      for (const child of children) {
        expect(child.record_version).toBe(2);
        expect(child.share_cause_kind).toBe('tenant_erased');
        expect(child.share_cause_event_id).toBe(parent?.event_id);
        expect(child.share_revoked_access_revision).toBe(
          (child.share_granted_access_revision ?? 0) + 1,
        );
      }
      expect(
        (await admin.query('SELECT count(*)::int AS count FROM restore_share_erasure_context'))
          .rows[0]?.count,
      ).toBe(0);
    });
  }

  it('keeps standalone revocation as version 1 with no cause or principal leakage', async () => {
    const tenant = randomUUID();
    const target = await grants(tenant, 1);
    const shareId = target.shareIds[0];
    if (!shareId) throw new Error('Expected share');
    await createResourceAccessRepository(database).revokeShare(tenant, target.id, shareId, {
      expectedAccessRevision: target.revision,
      idempotencyKey: randomUUID(),
    });
    const child = (await events(tenant)).find((item) => item.kind === 'resource_share_revoked');
    expect(child).toMatchObject({
      record_version: 1,
      share_cause_kind: null,
      share_cause_event_id: null,
    });
    const columns = (
      await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='restore_suppression_event'`,
      )
    ).rows.map((row) => row.column_name);
    expect(columns).not.toContain('grantee_principal_id');
    expect(columns).not.toContain('grantee_kind');
  });

  it('denies runtime writes and ignores a forged cause setting', async () => {
    const tenant = randomUUID();
    const target = await grants(tenant, 1);
    await expect(
      runtime.query(
        'INSERT INTO restore_share_erasure_context(transaction_id,athlete_id,event_id) VALUES(txid_current(),$1,$2)',
        [tenant, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await client.query("SELECT set_config('app.restore_erasure_cause_id',$1,true)", [
        randomUUID(),
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const shareId = target.shareIds[0];
    if (!shareId) throw new Error('Expected share');
    await createResourceAccessRepository(database).revokeShare(tenant, target.id, shareId, {
      expectedAccessRevision: target.revision,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await events(tenant)).find((item) => item.kind === 'resource_share_revoked')
        ?.share_cause_event_id,
    ).toBeNull();
  });
});
