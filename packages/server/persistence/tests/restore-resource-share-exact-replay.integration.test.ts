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
const databaseName = `share_replay_${suffix}`;
const ownerRole = `share_owner_${suffix}`;
const runtimeRole = `share_app_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;

type Entry = {
  athleteId: string;
  resourceId: string;
  shareId: string;
  eventId: string;
  occurredAt: string;
  grantedRevision: number;
  revokedRevision: number;
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

async function liveShare(athleteId: string): Promise<Entry> {
  const created = await createPrivateTextResourceRepository(database).create(athleteId, {
    sourceKind: 'text',
    title: 'Synthetic share resource',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic private body',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('resource creation failed');
  const granted = await createResourceAccessRepository(database).grantShare(
    athleteId,
    created.resource.id,
    {
      granteeKind: 'coach',
      granteePrincipalId: randomUUID(),
      expectedAccessRevision: created.resource.accessRevision,
      idempotencyKey: randomUUID(),
    },
  );
  const shareId = granted.shares[0]?.shareId;
  if (!shareId) throw new Error('share creation failed');
  const time = await owner.query<{ occurred_at: string }>(
    'SELECT clock_timestamp()::text AS occurred_at',
  );
  const occurredAt = time.rows[0]?.occurred_at;
  if (!occurredAt) throw new Error('missing replay time');
  return {
    athleteId,
    resourceId: created.resource.id,
    shareId,
    eventId: randomUUID(),
    occurredAt,
    grantedRevision: granted.accessRevision,
    revokedRevision: granted.accessRevision + 1,
  };
}

function args(item: Entry): unknown[] {
  return [
    item.athleteId,
    item.resourceId,
    item.shareId,
    item.eventId,
    item.occurredAt,
    item.grantedRevision,
    item.revokedRevision,
  ];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_resource_share_revoke_exact: string }>(
      'SELECT public.replay_resource_share_revoke_exact($1,$2,$3,$4,$5,$6,$7)',
      args(item),
    );
    return result.rows[0]?.replay_resource_share_revoke_exact ?? '';
  });
}

async function state(item: Entry) {
  const result = await tenant(owner, item.athleteId, (client) =>
    client.query<{
      resource_revision: number | null;
      share_state: string | null;
      share_revoked_revision: number | null;
      share_revoked_at: Date | null;
      event_count: string;
      receipt_count: string;
      audit_count: string;
      cleanup_count: string;
      outbox_count: string;
    }>(
      `SELECT
        (SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2) resource_revision,
        (SELECT state FROM resource_share WHERE athlete_id=$1 AND share_id=$3) share_state,
        (SELECT revoked_access_revision FROM resource_share
          WHERE athlete_id=$1 AND share_id=$3) share_revoked_revision,
        (SELECT revoked_at FROM resource_share
          WHERE athlete_id=$1 AND share_id=$3) share_revoked_at,
        (SELECT count(*)::text FROM restore_suppression_event
          WHERE athlete_id=$1 AND kind='resource_share_revoked' AND share_id=$3) event_count,
        (SELECT count(*)::text FROM restore_resource_share_replay_receipt
          WHERE athlete_id=$1 AND share_id=$3) receipt_count,
        (SELECT count(*)::text FROM resource_access_audit
          WHERE athlete_id=$1 AND resource_id=$2 AND share_id=$3
            AND action='share_revoked' AND access_revision=$4) audit_count,
        (SELECT count(*)::text FROM resource_derived_cleanup
          WHERE athlete_id=$1 AND resource_id=$2 AND reason='share_revoked'
            AND access_revision=$4) cleanup_count,
        (SELECT count(*)::text FROM outbox
          WHERE athlete_id=$1 AND id=$5 AND topic='resource.share_revoked') outbox_count`,
      [item.athleteId, item.resourceId, item.shareId, item.revokedRevision, item.eventId],
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
  await grantResources(urlFor(ownerRole), runtimeRole);
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

describe('owner-only standalone resource share revocation replay', () => {
  it('preserves source identity, revokes access and cleans derived data exactly once', async () => {
    const item = await liveShare(await account());
    expect(await replay(owner, item)).toBe('revoked');
    expect(await replay(owner, item)).toBe('already_applied');
    expect(await state(item)).toMatchObject({
      resource_revision: item.revokedRevision,
      share_state: 'revoked',
      share_revoked_revision: item.revokedRevision,
      share_revoked_at: new Date(item.occurredAt),
      event_count: '1',
      receipt_count: '1',
      audit_count: '1',
      cleanup_count: '1',
      outbox_count: '1',
    });
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{
        event_id: string;
        target_id: string;
        share_id: string;
        occurred_at: Date;
        share_granted_access_revision: number;
        share_revoked_access_revision: number;
      }>(
        `SELECT event_id,target_id,share_id,occurred_at,
           share_granted_access_revision,share_revoked_access_revision
         FROM restore_suppression_event WHERE event_id=$1`,
        [item.eventId],
      ),
    );
    expect(event.rows[0]).toEqual({
      event_id: item.eventId,
      target_id: item.resourceId,
      share_id: item.shareId,
      occurred_at: new Date(item.occurredAt),
      share_granted_access_revision: item.grantedRevision,
      share_revoked_access_revision: item.revokedRevision,
    });
    await tenant(owner, item.athleteId, async (client) => {
      await client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
        item.athleteId,
        item.eventId,
      ]);
      await client.query(
        `DELETE FROM resource_derived_cleanup WHERE athlete_id=$1 AND resource_id=$2
           AND reason='share_revoked' AND access_revision=$3`,
        [item.athleteId, item.resourceId, item.revokedRevision],
      );
    });
    expect(await replay(owner, item)).toBe('already_applied');
    await expect(
      replay(owner, { ...item, revokedRevision: item.revokedRevision + 1 }),
    ).rejects.toThrow('RESTORE_SHARE_EVENT_CONFLICT');
    await expect(
      tenant(owner, item.athleteId, (client) =>
        client.query('DELETE FROM restore_resource_share_replay_receipt WHERE event_id=$1', [
          item.eventId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('refuses absent and skipped predecessors', async () => {
    const item = await liveShare(await account());
    await expect(replay(owner, { ...item, shareId: randomUUID() })).rejects.toThrow(
      'RESTORE_SHARE_ABSENT_UNSUPPORTED',
    );
    await expect(
      replay(owner, { ...item, revokedRevision: item.revokedRevision + 1 }),
    ).rejects.toThrow('RESTORE_SHARE_STATE_CONFLICT');
    expect(await state(item)).toMatchObject({
      resource_revision: item.grantedRevision,
      share_state: 'active',
      event_count: '0',
      receipt_count: '0',
    });
  });

  it('does not accept an ordinary share event as an exact receipt', async () => {
    const item = await liveShare(await account());
    await createResourceAccessRepository(database).revokeShare(
      item.athleteId,
      item.resourceId,
      item.shareId,
      { expectedAccessRevision: item.grantedRevision, idempotencyKey: randomUUID() },
    );
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: string }>(
        `SELECT event_id,occurred_at::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='resource_share_revoked' AND share_id=$2`,
        [item.athleteId, item.shareId],
      ),
    );
    const original = event.rows[0];
    if (!original) throw new Error('missing ordinary event');
    await expect(
      replay(owner, { ...item, eventId: original.event_id, occurredAt: original.occurred_at }),
    ).rejects.toThrow('RESTORE_SHARE_RECEIPT_MISSING');
  });

  it('rejects foreign resources and rolls back earlier revocation', async () => {
    const first = await liveShare(await account());
    const foreign = await liveShare(await account());
    await expect(
      tenant(owner, first.athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_resource_share_revoke_exact($1,$2,$3,$4,$5,$6,$7)',
          args(first),
        );
        await client.query(
          'SELECT public.replay_resource_share_revoke_exact($1,$2,$3,$4,$5,$6,$7)',
          args({ ...foreign, athleteId: first.athleteId }),
        );
      }),
    ).rejects.toThrow('RESTORE_SHARE_FOREIGN_TARGET');
    expect(await state(first)).toMatchObject({
      resource_revision: first.grantedRevision,
      share_state: 'active',
      event_count: '0',
      receipt_count: '0',
      audit_count: '0',
      cleanup_count: '0',
    });
  });

  it('fails closed on a resource-deletion compound event without an exact share receipt', async () => {
    const item = await liveShare(await account());
    const head = await tenant(owner, item.athleteId, (client) =>
      client.query<{ current_version_id: string }>(
        'SELECT current_version_id FROM resource WHERE athlete_id=$1 AND id=$2',
        [item.athleteId, item.resourceId],
      ),
    );
    const versionId = head.rows[0]?.current_version_id;
    if (!versionId) throw new Error('missing resource version');
    await createPrivateTextResourceRepository(database).softDelete(
      item.athleteId,
      item.resourceId,
      {
        expectedAccessRevision: item.grantedRevision,
        expectedCurrentVersionId: versionId,
        idempotencyKey: randomUUID(),
      },
    );
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{
        event_id: string;
        occurred_at: string;
        share_revoked_access_revision: number;
      }>(
        `SELECT event_id,occurred_at::text,share_revoked_access_revision
         FROM restore_suppression_event WHERE athlete_id=$1
           AND kind='resource_share_revoked' AND share_id=$2`,
        [item.athleteId, item.shareId],
      ),
    );
    const original = event.rows[0];
    if (!original) throw new Error('missing compound event');
    await expect(
      replay(owner, {
        ...item,
        eventId: original.event_id,
        occurredAt: original.occurred_at,
        revokedRevision: original.share_revoked_access_revision,
      }),
    ).rejects.toThrow('RESTORE_SHARE_RECEIPT_MISSING');
  });

  it('accepts retry after later resource deletion and exact tenant erasure', async () => {
    const item = await liveShare(await account());
    expect(await replay(owner, item)).toBe('revoked');
    const head = await tenant(owner, item.athleteId, (client) =>
      client.query<{ current_version_id: string }>(
        'SELECT current_version_id FROM resource WHERE athlete_id=$1 AND id=$2',
        [item.athleteId, item.resourceId],
      ),
    );
    const versionId = head.rows[0]?.current_version_id;
    if (!versionId) throw new Error('missing resource version');
    await createPrivateTextResourceRepository(database).softDelete(
      item.athleteId,
      item.resourceId,
      {
        expectedAccessRevision: item.revokedRevision,
        expectedCurrentVersionId: versionId,
        idempotencyKey: randomUUID(),
      },
    );
    expect(await replay(owner, item)).toBe('already_applied');
    await tenant(owner, item.athleteId, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        item.athleteId,
        randomUUID(),
        new Date().toISOString(),
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied_by_erasure');
  });

  it('denies runtime replay and a spoofed trigger GUC', async () => {
    const item = await liveShare(await account());
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_resource_share_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `UPDATE resource_share SET state='revoked',revoked_at=$3,
             revoked_access_revision=$4,updated_at=$3
           WHERE athlete_id=$1 AND share_id=$2`,
          [item.athleteId, item.shareId, item.occurredAt, item.revokedRevision],
        );
      }),
    ).rejects.toThrow('RESTORE_SHARE_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({ share_state: 'active', event_count: '0' });
  });
});
