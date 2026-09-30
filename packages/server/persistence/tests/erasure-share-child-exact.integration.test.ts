import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `erasure_child_${suffix}`;
const ownerRole = `erasure_child_owner_${suffix}`;
const runtimeRole = `erasure_child_rt_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

type Child = {
  resourceId: string;
  shareId: string;
  eventId: string;
  granted: number;
  revoked: number;
  occurredAt: Date;
};

async function setup(count: number): Promise<{
  tenant: string;
  resourceId: string;
  revision: number;
  children: Child[];
}> {
  const tenant = randomUUID();
  await owner.query(
    `INSERT INTO identity_private.account(athlete_id,issuer,subject)
     VALUES($1,'https://issuer.test',$2)`,
    [tenant, randomUUID()],
  );
  const created = await createPrivateTextResourceRepository(database).create(tenant, {
    sourceKind: 'text',
    title: 'Synthetic erasure replay',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic content.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Expected resource');
  const resourceId = created.resource.id;
  let revision = created.resource.accessRevision;
  const children: Child[] = [];
  for (let index = 0; index < count; index++) {
    const state = await createResourceAccessRepository(database).grantShare(tenant, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: revision,
      idempotencyKey: randomUUID(),
    });
    const share = state.shares.find(
      (item) =>
        item.state === 'active' && !children.some((child) => child.shareId === item.shareId),
    );
    if (!share) throw new Error('Expected active share');
    revision = state.accessRevision;
    children.push({
      resourceId,
      shareId: share.shareId,
      eventId: randomUUID(),
      granted: revision,
      revoked: revision + 1,
      occurredAt: new Date(0),
    });
  }
  const time = (await owner.query<{ at: Date }>('SELECT statement_timestamp() AS at')).rows[0]?.at;
  if (!time) throw new Error('Expected database clock');
  for (const child of children) child.occurredAt = time;
  return { tenant, resourceId, revision, children };
}

async function tenant(client: PoolClient, athleteId: string): Promise<void> {
  await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
}
async function child(
  client: PoolClient,
  athleteId: string,
  value: Child,
  parentId: string,
): Promise<string> {
  const result = await client.query<{ replay_erasure_share_child_exact: string }>(
    'SELECT public.replay_erasure_share_child_exact($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      athleteId,
      value.resourceId,
      value.shareId,
      value.eventId,
      value.occurredAt,
      value.granted,
      value.revoked,
      parentId,
    ],
  );
  return result.rows[0]?.replay_erasure_share_child_exact ?? '';
}
async function parent(
  client: PoolClient,
  athleteId: string,
  parentId: string,
): Promise<{ status: string; time: Date }> {
  const time = (await client.query<{ at: Date }>('SELECT statement_timestamp() AS at')).rows[0]?.at;
  if (!time) throw new Error('Expected database clock');
  const result = await client.query<{ replay_tenant_erasure_exact: string }>(
    'SELECT public.replay_tenant_erasure_exact($1,$2,$3)',
    [athleteId, parentId, time],
  );
  return { status: result.rows[0]?.replay_tenant_erasure_exact ?? '', time };
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
  await grantResources(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});
afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('exact tenant-erasure share children under a plain owner', () => {
  for (const count of [0, 1, 3]) {
    it(`replays ${count} child IDs/times and erases only after all active shares are gone`, async () => {
      const input = await setup(count);
      const parentId = randomUUID();
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await tenant(client, input.tenant);
        for (const value of input.children)
          expect(await child(client, input.tenant, value, parentId)).toBe('revoked');
        const erased = await parent(client, input.tenant, parentId);
        expect(erased.status).toBe('erased');
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      const events = await owner.query<{
        event_id: string;
        share_cause_event_id: string;
        occurred_at: Date;
      }>(
        `SELECT event_id::text,share_cause_event_id::text,occurred_at
          FROM restore_suppression_event WHERE athlete_id=$1 AND kind='resource_share_revoked'`,
        [input.tenant],
      );
      expect(events.rows).toHaveLength(count);
      for (const value of input.children) {
        expect(events.rows).toContainEqual({
          event_id: value.eventId,
          share_cause_event_id: parentId,
          occurred_at: value.occurredAt,
        });
      }
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS count FROM restore_erasure_share_replay_receipt WHERE athlete_id=$1',
            [input.tenant],
          )
        ).rows[0]?.count,
      ).toBe(count);
      expect(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM resource_access_audit WHERE athlete_id=$1 AND action='share_revoked'",
            [input.tenant],
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM outbox WHERE athlete_id=$1 AND topic='resource.share_revoked'",
            [input.tenant],
          )
        ).rows[0]?.count,
      ).toBe(0);
      const replay = await owner.connect();
      try {
        await replay.query('BEGIN');
        await tenant(replay, input.tenant);
        for (const value of input.children)
          expect(await child(replay, input.tenant, value, parentId)).toBe(
            'already_applied_by_erasure',
          );
        const erasure = await replay.query<{ erased_at: Date }>(
          'SELECT erased_at FROM tenant_erasure WHERE athlete_id=$1',
          [input.tenant],
        );
        const parentReceipt = await replay.query<{ occurred_at: Date }>(
          "SELECT occurred_at FROM restore_exact_replay_receipt WHERE event_id=$1 AND kind='tenant_erased'",
          [parentId],
        );
        expect(parentReceipt.rows[0]?.occurred_at).toEqual(erasure.rows[0]?.erased_at);
        expect(
          (
            await replay.query<{ replay_tenant_erasure_exact: string }>(
              'SELECT public.replay_tenant_erasure_exact($1,$2,$3)',
              [input.tenant, parentId, erasure.rows[0]?.erased_at],
            )
          ).rows[0]?.replay_tenant_erasure_exact,
        ).toBe('already_applied');
        await replay.query('COMMIT');
      } finally {
        await replay.query('ROLLBACK').catch(() => undefined);
        replay.release();
      }
    });
  }

  it('refuses a missing child and rolls back an earlier child in the same transaction', async () => {
    const input = await setup(2);
    const parentId = randomUUID();
    const first = input.children[0];
    if (!first) throw new Error('Expected child');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      expect(await child(client, input.tenant, first, parentId)).toBe('revoked');
      await expect(parent(client, input.tenant, parentId)).rejects.toThrow(
        'RESTORE_ERASURE_SHARE_CHILDREN_PENDING',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM restore_erasure_share_replay_receipt WHERE athlete_id=$1',
          [input.tenant],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await database.tenant(input.tenant, (tx) =>
          tx.query(
            "SELECT count(*)::int AS count FROM resource_share WHERE athlete_id=$1 AND state='active'",
            [input.tenant],
          ),
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  it('rejects a child-only commit and leaves no event, receipt or share transition', async () => {
    const input = await setup(1);
    const value = input.children[0];
    if (!value) throw new Error('Expected child');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      expect(await child(client, input.tenant, value, randomUUID())).toBe('revoked');
      await expect(client.query('COMMIT')).rejects.toThrow('RESTORE_SHARE_CAUSE_CONFLICT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM restore_suppression_event WHERE event_id=$1',
          [value.eventId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM restore_erasure_share_replay_receipt WHERE event_id=$1',
          [value.eventId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    const current = await database.tenant(input.tenant, (tx) =>
      tx.query('SELECT state FROM resource_share WHERE athlete_id=$1 AND share_id=$2', [
        input.tenant,
        value.shareId,
      ]),
    );
    expect(current.rows[0]?.['state']).toBe('active');
  });

  it('preserves an earlier standalone share revocation and rejects extra or foreign targets', async () => {
    const input = await setup(2);
    const standalone = input.children[0];
    const remaining = input.children[1];
    if (!standalone || !remaining) throw new Error('Expected two shares');
    await createResourceAccessRepository(database).revokeShare(
      input.tenant,
      input.resourceId,
      standalone.shareId,
      {
        expectedAccessRevision: input.revision,
        idempotencyKey: randomUUID(),
      },
    );
    const foreign = await setup(1);
    const foreignChild = foreign.children[0];
    if (!foreignChild) throw new Error('Expected foreign share');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      await expect(child(client, input.tenant, standalone, randomUUID())).rejects.toThrow();
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      await expect(child(client, input.tenant, foreignChild, randomUUID())).rejects.toThrow();
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      expect(await child(client, input.tenant, remaining, randomUUID())).toBe('revoked');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('denies runtime execute and a forged replay setting', async () => {
    const input = await setup(1);
    const value = input.children[0];
    if (!value) throw new Error('Expected share');
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      await expect(child(client, input.tenant, value, randomUUID())).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('ROLLBACK');
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.replay_erasure_share_child_exact(text,uuid,uuid,uuid,timestamptz,integer,integer,uuid) TO "${runtimeRole}"`,
      );
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      await expect(child(client, input.tenant, value, randomUUID())).rejects.toThrow(
        'RESTORE_ERASURE_SHARE_OWNER_REQUIRED',
      );
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await tenant(client, input.tenant);
      await client.query("SELECT set_config('app.restore_replay_event_id',$1,true)", [
        randomUUID(),
      ]);
      await expect(client.query('SELECT public.erase_account($1)', [input.tenant])).rejects.toThrow(
        'RESTORE_REPLAY_OWNER_REQUIRED',
      );
      await client.query('ROLLBACK');
    } finally {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION public.replay_erasure_share_child_exact(text,uuid,uuid,uuid,timestamptz,integer,integer,uuid) FROM "${runtimeRole}"`,
      );
      client.release();
    }
  });
});
