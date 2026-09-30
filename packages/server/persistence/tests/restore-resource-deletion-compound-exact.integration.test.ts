import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `resource_compound_${suffix}`;
const ownerRole = `resource_compound_owner_${suffix}`;
const runtimeRole = `resource_compound_app_${suffix}`;
let owner: Pool;
let runtime: Pool;

type Child = {
  recordVersion: 2;
  eventId: string;
  athleteId: string;
  targetId: string;
  shareId: string;
  occurredAt: string;
  shareGrantedAccessRevision: number;
  shareRevokedAccessRevision: number;
  shareCauseKind: 'resource_deleted';
  shareCauseEventId: string;
};
type Entry = {
  athleteId: string;
  resourceId: string;
  parentEventId: string;
  occurredAt: string;
  accessRevision: number;
  children: Child[];
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
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function account(): Promise<string> {
  const result = await owner.query<{ athlete_id: string }>(
    "INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1) RETURNING athlete_id::text",
    [randomUUID()],
  );
  const id = result.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
}

async function fixture(providedAthleteId?: string, shareCount = 2): Promise<Entry> {
  const athleteId = providedAthleteId ?? (await account());
  const resourceId = randomUUID();
  const parentEventId = randomUUID();
  const occurredAt = '2026-09-30 12:00:00+00';
  const accessRevision = shareCount + 2;
  const versionId = randomUUID();
  const children: Child[] = [];
  await tenant(owner, athleteId, async (client) => {
    await client.query(
      `INSERT INTO resource(athlete_id,id,title,category,metadata,tags,access_revision,
         current_version,current_version_id,created_at,updated_at)
       VALUES($1,$2,'Synthetic resource','note','{}'::jsonb,'[]'::jsonb,$3,
         1,$4,'2026-09-29 00:00:00+00','2026-09-29 00:00:00+00')`,
      [athleteId, resourceId, accessRevision - 1, versionId],
    );
    await client.query(
      `INSERT INTO resource_version(athlete_id,resource_id,version_id,version,
         content,content_hash,paragraphs,content_status,index_status,created_at)
       VALUES($1,$2,$3,1,'Synthetic text',repeat('a',64),
         '[{"text":"Synthetic text"}]'::jsonb,'parsed','not_indexed','2026-09-29 00:00:00+00')`,
      [athleteId, resourceId, versionId],
    );
    for (let index = 0; index < shareCount; index++) {
      const shareId = randomUUID();
      await client.query(
        `INSERT INTO resource_share(athlete_id,share_id,resource_id,grantee_kind,
           grantee_principal_id,state,granted_access_revision,granted_at,updated_at)
         VALUES($1,$2,$3,'coach',$4,'active',$5,
           '2026-09-29 00:00:00+00','2026-09-29 00:00:00+00')`,
        [athleteId, shareId, resourceId, randomUUID(), index + 2],
      );
      children.push({
        recordVersion: 2,
        eventId: randomUUID(),
        athleteId,
        targetId: resourceId,
        shareId,
        occurredAt: `2026-09-30 12:0${index + 1}:00+00`,
        shareGrantedAccessRevision: index + 2,
        shareRevokedAccessRevision: accessRevision,
        shareCauseKind: 'resource_deleted',
        shareCauseEventId: parentEventId,
      });
    }
  });
  return { athleteId, resourceId, parentEventId, occurredAt, accessRevision, children };
}

function args(entry: Entry): unknown[] {
  return [
    entry.athleteId,
    entry.resourceId,
    entry.parentEventId,
    entry.occurredAt,
    entry.accessRevision,
    JSON.stringify(entry.children),
  ];
}

async function replay(pool: Pool, entry: Entry): Promise<string> {
  return tenant(pool, entry.athleteId, async (client) => {
    const result = await client.query<{ replay_resource_deletion_compound_exact: string }>(
      'SELECT public.replay_resource_deletion_compound_exact($1,$2,$3,$4,$5,$6::jsonb)',
      args(entry),
    );
    return result.rows[0]?.replay_resource_deletion_compound_exact ?? '';
  });
}

async function state(entry: Entry) {
  const result = await tenant(owner, entry.athleteId, (client) =>
    client.query<{
      revision: number;
      deleted_at: Date | null;
      active_shares: string;
      events: string;
      parent_receipts: string;
      child_receipts: string;
      compound_receipts: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2) revision,
        (SELECT deleted_at FROM resource WHERE athlete_id=$1 AND id=$2) deleted_at,
        (SELECT count(*)::text FROM resource_share WHERE athlete_id=$1 AND resource_id=$2 AND state='active') active_shares,
        (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1 AND
          (event_id=$3 OR share_cause_event_id=$3)) events,
        (SELECT count(*)::text FROM restore_resource_replay_receipt WHERE event_id=$3) parent_receipts,
        (SELECT count(*)::text FROM restore_resource_share_replay_receipt WHERE athlete_id=$1
          AND resource_id=$2) child_receipts,
        (SELECT count(*)::text FROM restore_resource_compound_replay_receipt WHERE parent_event_id=$3) compound_receipts,
        (SELECT count(*)::text FROM outbox WHERE athlete_id=$1 AND id=$3) outbox`,
      [entry.athleteId, entry.resourceId, entry.parentEventId],
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
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('exact compound resource deletion under a plain owner', () => {
  it('preserves parent then ordered version-2 child identities and retries after an uncertain COMMIT response', async () => {
    const item = await fixture();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [item.athleteId]);
      await client.query(
        'SELECT public.replay_resource_deletion_compound_exact($1,$2,$3,$4,$5,$6::jsonb)',
        args(item),
      );
      await client.query('COMMIT');
      // Model a caller that loses the acknowledgement after PostgreSQL commits.
    } finally {
      client.release();
    }
    expect(await replay(owner, item)).toBe('already_applied');
    await expect(
      replay(owner, { ...item, children: [...item.children].reverse() }),
    ).rejects.toThrow('RESTORE_RESOURCE_COMPOUND_RECEIPT_MISSING');
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision,
      deleted_at: new Date(item.occurredAt),
      active_shares: '0',
      events: '3',
      parent_receipts: '1',
      child_receipts: '2',
      compound_receipts: '1',
      outbox: '1',
    });
    const ledger = await tenant(owner, item.athleteId, (client) =>
      client.query<{ event_id: string; kind: string; share_id: string | null }>(
        `SELECT event_id,kind,share_id FROM restore_suppression_event
         WHERE event_id=$1 OR share_cause_event_id=$1 ORDER BY occurred_at,event_id`,
        [item.parentEventId],
      ),
    );
    expect(ledger.rows.map((row) => row.event_id)).toEqual([
      item.parentEventId,
      ...item.children.map((child) => child.eventId),
    ]);
  });

  it('refuses incomplete, extra and foreign child sets before the parent changes', async () => {
    const item = await fixture();
    const foreign = await fixture(await account(), 1);
    const [firstChild, secondChild] = item.children;
    const [foreignChild] = foreign.children;
    if (!firstChild || !secondChild || !foreignChild) throw new Error('missing fixture child');
    for (const changed of [
      { ...item, children: item.children.slice(0, 1) },
      {
        ...item,
        children: [
          ...item.children,
          { ...secondChild, eventId: randomUUID(), shareId: randomUUID() },
        ],
      },
      {
        ...item,
        children: [{ ...firstChild, shareId: foreignChild.shareId }, secondChild],
      },
    ]) {
      await expect(replay(owner, changed)).rejects.toThrow();
      expect(await state(item)).toMatchObject({
        revision: item.accessRevision - 1,
        deleted_at: null,
        active_shares: '2',
        events: '0',
        parent_receipts: '0',
        compound_receipts: '0',
      });
    }
  });

  it('rolls back parent and children when a late outbox identity conflicts', async () => {
    const item = await fixture();
    await tenant(owner, item.athleteId, (client) =>
      client.query(
        `INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload)
         VALUES($1,$2,$3,'fixture.conflict','{}'::jsonb)`,
        [item.athleteId, item.parentEventId, `fixture:${randomUUID()}`],
      ),
    );
    await expect(replay(owner, item)).rejects.toThrow();
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision - 1,
      deleted_at: null,
      active_shares: '2',
      events: '0',
      parent_receipts: '0',
      child_receipts: '0',
      compound_receipts: '0',
    });
  });

  it('rejects a child event ID already assigned to another kind', async () => {
    const item = await fixture();
    const child = item.children[0];
    if (!child) throw new Error('missing fixture child');
    await tenant(owner, item.athleteId, (client) =>
      client.query(
        `INSERT INTO restore_suppression_event(event_id,athlete_id,kind,target_id,occurred_at)
         VALUES($1,$2,'course_deleted',$3,$4)`,
        [child.eventId, item.athleteId, randomUUID(), item.occurredAt],
      ),
    );
    await expect(replay(owner, item)).rejects.toThrow('RESTORE_RESOURCE_COMPOUND_CHILD_CONFLICT');
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision - 1,
      deleted_at: null,
      active_shares: '2',
      events: '0',
      parent_receipts: '0',
      child_receipts: '0',
      compound_receipts: '0',
    });
  });

  it('requires the compound function for active shares and blocks runtime or spoofed GUCs', async () => {
    const item = await fixture();
    await expect(
      tenant(owner, item.athleteId, (client) =>
        client.query(
          'SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5)',
          args(item).slice(0, 5),
        ),
      ),
    ).rejects.toThrow('RESTORE_RESOURCE_COMPOUND_REQUIRED');
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await owner.query(`GRANT SELECT,UPDATE ON resource TO "${runtimeRole}"`);
    await owner.query(`GRANT SELECT ON resource_share TO "${runtimeRole}"`);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_resource_event_id',$1,true)", [
          item.parentEventId,
        ]);
        await client.query(
          `UPDATE resource SET access_revision=$3,updated_at=$4,
        deleted_at=$4,include_for_coach=false,coach_use_enabled_at=NULL
        WHERE athlete_id=$1 AND id=$2`,
          [item.athleteId, item.resourceId, item.accessRevision, item.occurredAt],
        );
      }),
    ).rejects.toThrow('RESTORE_RESOURCE_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({
      revision: item.accessRevision - 1,
      deleted_at: null,
      active_shares: '2',
      events: '0',
    });
  });
});
