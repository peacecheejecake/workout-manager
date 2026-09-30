import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `resource_replay_${suffix}`;
const ownerRole = `resource_owner_${suffix}`;
const runtimeRole = `resource_app_${suffix}`;
let owner: Pool;
let runtime: Pool;
let database: Database;

type Entry = {
  athleteId: string;
  targetId: string;
  eventId: string;
  occurredAt: string;
  accessRevision: number;
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
): Promise<T> {
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

async function liveResource(athleteId: string): Promise<Entry> {
  const created = await createPrivateTextResourceRepository(database).create(athleteId, {
    sourceKind: 'text',
    title: 'Synthetic restore note',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic text for restore replay.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('resource creation failed');
  return {
    athleteId,
    targetId: created.resource.id,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    accessRevision: created.resource.accessRevision + 1,
  };
}

function args(item: Entry): unknown[] {
  return [item.athleteId, item.targetId, item.eventId, item.occurredAt, item.accessRevision];
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, async (client) => {
    const result = await client.query<{ replay_resource_deletion_exact: string }>(
      'SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5)',
      args(item),
    );
    return result.rows[0]?.replay_resource_deletion_exact ?? '';
  });
}

async function state(item: Entry) {
  const result = await tenant(owner, item.athleteId, (client) =>
    client.query<{
      event_count: string;
      receipt_count: string;
      audit_count: string;
      outbox_count: string;
      cleanup_count: string;
      active_share_count: string;
      revoked_share_count: string;
      tombstone_receipt_count: string;
      revision: number | null;
      deleted_at: Date | null;
    }>(
      `SELECT
        (SELECT count(*)::text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='resource_deleted' AND target_id=$2) event_count,
        (SELECT count(*)::text FROM restore_resource_replay_receipt
         WHERE athlete_id=$1 AND target_id=$2) receipt_count,
        (SELECT count(*)::text FROM resource_access_audit
         WHERE athlete_id=$1 AND resource_id=$2 AND event_id=$3
           AND action='resource_deleted') audit_count,
        (SELECT count(*)::text FROM outbox
         WHERE athlete_id=$1 AND id=$3 AND topic='resource.deleted') outbox_count,
        (SELECT count(*)::text FROM resource_derived_cleanup
         WHERE athlete_id=$1 AND resource_id=$2 AND reason='resource_deleted'
           AND access_revision=$4) cleanup_count,
        (SELECT count(*)::text FROM resource_share
         WHERE athlete_id=$1 AND resource_id=$2 AND state='active') active_share_count,
        (SELECT count(*)::text FROM resource_share
         WHERE athlete_id=$1 AND resource_id=$2 AND state='revoked'
           AND revoked_access_revision=$4) revoked_share_count,
        (SELECT count(*)::text FROM command_receipt
         WHERE athlete_id=$1 AND result->>'resourceId'=$2::text
           AND result->>'status'='deleted'
           AND (result->>'accessRevision')::integer=$4) tombstone_receipt_count,
        (SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2) revision,
        (SELECT deleted_at FROM resource WHERE athlete_id=$1 AND id=$2) deleted_at`,
      [item.athleteId, item.targetId, item.eventId, item.accessRevision],
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

describe('owner-only exact resource deletion replay', () => {
  it('preserves original identity, revision and time through deletion and exact retry', async () => {
    const item = await liveResource(await account());
    expect(await replay(owner, item)).toBe('deleted');
    expect(await replay(owner, item)).toBe('already_applied');
    expect(await state(item)).toMatchObject({
      event_count: '1',
      receipt_count: '1',
      audit_count: '1',
      outbox_count: '1',
      cleanup_count: '1',
      active_share_count: '0',
      revoked_share_count: '0',
      tombstone_receipt_count: '1',
      revision: item.accessRevision,
      deleted_at: new Date(item.occurredAt),
    });
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{
        event_id: string;
        occurred_at: Date;
        resource_access_revision: number;
      }>(
        `SELECT event_id,occurred_at,resource_access_revision FROM restore_suppression_event
         WHERE event_id=$1`,
        [item.eventId],
      ),
    );
    expect(event.rows[0]).toEqual({
      event_id: item.eventId,
      occurred_at: new Date(item.occurredAt),
      resource_access_revision: item.accessRevision,
    });
    // Delivery and thirty-day cleanup pruning do not erase the replay receipt.
    await tenant(owner, item.athleteId, async (client) => {
      await client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id=$2', [
        item.athleteId,
        item.eventId,
      ]);
      await client.query(
        `DELETE FROM resource_derived_cleanup WHERE athlete_id=$1 AND resource_id=$2
           AND reason='resource_deleted' AND access_revision=$3`,
        [item.athleteId, item.targetId, item.accessRevision],
      );
    });
    expect(await replay(owner, item)).toBe('already_applied');
    await expect(
      replay(owner, { ...item, accessRevision: item.accessRevision + 1 }),
    ).rejects.toThrow('RESTORE_RESOURCE_EVENT_CONFLICT');
  });

  it('refuses absent heads and skipped revisions without inserting an event', async () => {
    const athleteId = await account();
    const absent: Entry = {
      athleteId,
      targetId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      accessRevision: 2,
    };
    await expect(replay(owner, absent)).rejects.toThrow('RESTORE_RESOURCE_ABSENT_UNSUPPORTED');
    expect(await state(absent)).toMatchObject({ event_count: '0', receipt_count: '0' });
    const live = await liveResource(athleteId);
    await expect(
      replay(owner, { ...live, accessRevision: live.accessRevision + 1 }),
    ).rejects.toThrow('RESTORE_RESOURCE_STATE_CONFLICT');
    expect(await state(live)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: live.accessRevision - 1,
      deleted_at: null,
    });
  });

  it('does not treat a backup deletion event as an exact replay receipt', async () => {
    const item = await liveResource(await account());
    const head = await tenant(owner, item.athleteId, (client) =>
      client.query<{ current_version_id: string }>(
        'SELECT current_version_id FROM resource WHERE athlete_id=$1 AND id=$2',
        [item.athleteId, item.targetId],
      ),
    );
    const currentVersionId = head.rows[0]?.current_version_id;
    if (!currentVersionId) throw new Error('missing resource version');
    await createPrivateTextResourceRepository(database).softDelete(item.athleteId, item.targetId, {
      expectedAccessRevision: item.accessRevision - 1,
      expectedCurrentVersionId: currentVersionId,
      idempotencyKey: randomUUID(),
    });
    const event = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: Date }>(
        `SELECT event_id,occurred_at FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='resource_deleted' AND target_id=$2`,
        [item.athleteId, item.targetId],
      ),
    );
    const existing = event.rows[0];
    if (!existing) throw new Error('missing normal deletion event');
    await expect(
      replay(owner, {
        ...item,
        eventId: existing.event_id,
        occurredAt: existing.occurred_at.toISOString(),
      }),
    ).rejects.toThrow('RESTORE_RESOURCE_RECEIPT_MISSING');
  });

  it('recognizes an earlier exact resource event after exact tenant erasure', async () => {
    const item = await liveResource(await account());
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

  it('rejects a foreign resource and rolls back an earlier replay in one transaction', async () => {
    const first = await liveResource(await account());
    const foreign = await liveResource(await account());
    await expect(
      tenant(owner, first.athleteId, async (client) => {
        await client.query(
          'SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5)',
          args(first),
        );
        await client.query(
          'SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5)',
          args({ ...foreign, athleteId: first.athleteId }),
        );
      }),
    ).rejects.toThrow('RESTORE_RESOURCE_FOREIGN_RESOURCE');
    expect(await state(first)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: first.accessRevision - 1,
      deleted_at: null,
    });
    expect(await state(foreign)).toMatchObject({ revision: foreign.accessRevision - 1 });
  });

  it('denies runtime replay and a spoofed trigger GUC', async () => {
    const item = await liveResource(await account());
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_resource_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `UPDATE resource SET access_revision=$3,updated_at=$4,deleted_at=$4,
             include_for_coach=false,coach_use_enabled_at=NULL
           WHERE athlete_id=$1 AND id=$2`,
          [item.athleteId, item.targetId, item.accessRevision, item.occurredAt],
        );
      }),
    ).rejects.toThrow('RESTORE_RESOURCE_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({
      event_count: '0',
      receipt_count: '0',
      revision: item.accessRevision - 1,
      deleted_at: null,
    });
  });
});
