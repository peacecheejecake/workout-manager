import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import type { SuppressionRecord } from '../src/restore-suppression-records.js';
import {
  replayVerifiedSuppressionChain,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `compound_chain_${suffix}`;
const ownerRole = `compound_chain_owner_${suffix}`;
const key = Buffer.alloc(32, 45);
const keyId = 'compound-chain-test';
const clusterId = '123456789';
const oldTime = '2026-09-29 00:00:00+00';
let owner: Pool;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenant<T>(
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
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

type Fixture = {
  athleteId: string;
  resourceId: string;
  shareId: string;
  parentId: string;
  childId: string;
};
async function fixture(): Promise<Fixture> {
  const athleteId = randomUUID();
  const resourceId = randomUUID();
  const shareId = randomUUID();
  const versionId = randomUUID();
  await owner.query(
    `INSERT INTO identity_private.account(athlete_id,issuer,subject)
     VALUES($1,'https://issuer.test',$2)`,
    [athleteId, randomUUID()],
  );
  await tenant(athleteId, async (client) => {
    await client.query(
      `INSERT INTO resource(athlete_id,id,title,category,metadata,tags,access_revision,
         current_version,current_version_id,created_at,updated_at)
       VALUES($1,$2,'Synthetic resource','note','{}'::jsonb,'[]'::jsonb,2,
         1,$3,$4,$4)`,
      [athleteId, resourceId, versionId, oldTime],
    );
    await client.query(
      `INSERT INTO resource_version(athlete_id,resource_id,version_id,version,
         content,content_hash,paragraphs,content_status,index_status,created_at)
       VALUES($1,$2,$3,1,'Synthetic text',repeat('a',64),
         '[{"text":"Synthetic text"}]'::jsonb,'parsed','not_indexed',$4)`,
      [athleteId, resourceId, versionId, oldTime],
    );
    await client.query(
      `INSERT INTO resource_share(athlete_id,share_id,resource_id,grantee_kind,
         grantee_principal_id,state,granted_access_revision,granted_at,updated_at)
       VALUES($1,$2,$3,'coach',$4,'active',2,$5,$5)`,
      [athleteId, shareId, resourceId, randomUUID(), oldTime],
    );
  });
  return { athleteId, resourceId, shareId, parentId: randomUUID(), childId: randomUUID() };
}

function resourceRecords(item: Fixture): SuppressionRecord[] {
  return [
    {
      schemaVersion: 1,
      eventId: item.parentId,
      athleteId: item.athleteId,
      occurredAt: '2026-09-30 12:00:00+00',
      kind: 'resource_deleted',
      targetId: item.resourceId,
      resourceAccessRevision: 3,
    },
    {
      schemaVersion: 2,
      eventId: item.childId,
      athleteId: item.athleteId,
      occurredAt: '2026-09-30 12:01:00+00',
      kind: 'resource_share_revoked',
      targetId: item.resourceId,
      shareId: item.shareId,
      shareGrantedAccessRevision: 2,
      shareRevokedAccessRevision: 3,
      shareCauseKind: 'resource_deleted',
      shareCauseEventId: item.parentId,
    },
  ];
}
function erasureRecords(item: Fixture): SuppressionRecord[] {
  return [
    {
      schemaVersion: 2,
      eventId: item.childId,
      athleteId: item.athleteId,
      occurredAt: '2026-09-30 12:00:00+00',
      kind: 'resource_share_revoked',
      targetId: item.resourceId,
      shareId: item.shareId,
      shareGrantedAccessRevision: 2,
      shareRevokedAccessRevision: 3,
      shareCauseKind: 'tenant_erased',
      shareCauseEventId: item.parentId,
    },
    {
      schemaVersion: 1,
      eventId: item.parentId,
      athleteId: item.athleteId,
      occurredAt: '2026-09-30 12:01:00+00',
      kind: 'tenant_erased',
    },
  ];
}
function chain(records: readonly SuppressionRecord[]): {
  segments: Buffer[];
  anchor: TrustedReplayAnchor;
  key: Buffer;
  keyId: string;
} {
  const body = {
    localRecordVersion: 1 as const,
    clusterId,
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: [...records] }],
  };
  const envelope: LocalReplayRecordEnvelope = {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
  return {
    segments: [bytes],
    key,
    keyId,
    anchor: {
      clusterId,
      fromLsn: '0/100',
      previousHash: null,
      throughLsn: '0/120',
      finalLocalHash: envelope.sha256,
      ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
    },
  };
}
async function state(item: Fixture) {
  return tenant(item.athleteId, async (client) => {
    const result = await client.query<{
      access_revision: number;
      deleted_at: Date | null;
      active_shares: string;
      child_events: string;
      parent_events: string;
      child_receipts: string;
      parent_receipts: string;
    }>(
      `SELECT
      (SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2) access_revision,
      (SELECT deleted_at FROM resource WHERE athlete_id=$1 AND id=$2) deleted_at,
      (SELECT count(*)::text FROM resource_share WHERE athlete_id=$1 AND resource_id=$2 AND state='active') active_shares,
      (SELECT count(*)::text FROM restore_suppression_event WHERE event_id=$3) child_events,
      (SELECT count(*)::text FROM restore_suppression_event WHERE event_id=$4) parent_events,
      (SELECT count(*)::text FROM restore_erasure_share_replay_receipt WHERE event_id=$3) child_receipts,
      (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE event_id=$4) parent_receipts`,
      [item.athleteId, item.resourceId, item.childId, item.parentId],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole));
});
afterAll(async () => {
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  await admin.end();
});

describe('authenticated compound suppression-chain replay on PostgreSQL', () => {
  it('replays resource deletion parent then child, and exact retry creates no new events', async () => {
    const item = await fixture();
    const input = chain(resourceRecords(item));
    expect((await replayVerifiedSuppressionChain({ ...input, ownerPool: owner })).eventCount).toBe(
      2,
    );
    const first = await state(item);
    expect(first).toMatchObject({
      access_revision: 3,
      active_shares: '0',
      child_events: '1',
      parent_events: '1',
    });
    expect(first?.deleted_at).not.toBeNull();
    await replayVerifiedSuppressionChain({ ...input, ownerPool: owner });
    expect(await state(item)).toEqual(first);
    const events = await owner.query<{
      event_id: string;
      occurred_at: Date;
      share_cause_event_id: string | null;
    }>(
      `SELECT event_id,occurred_at,share_cause_event_id::text
       FROM restore_suppression_event WHERE event_id IN ($1,$2) ORDER BY occurred_at`,
      [item.parentId, item.childId],
    );
    expect(
      events.rows.map((row) => [
        row.event_id,
        row.occurred_at.toISOString(),
        row.share_cause_event_id,
      ]),
    ).toEqual([
      [item.parentId, '2026-09-30T12:00:00.000Z', null],
      [item.childId, '2026-09-30T12:01:00.000Z', item.parentId],
    ]);
    const receipt = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM restore_resource_compound_replay_receipt WHERE parent_event_id=$1',
      [item.parentId],
    );
    expect(receipt.rows[0]?.count).toBe(1);
  });

  it('replays erasure child before parent, then exact retry uses both receipts', async () => {
    const item = await fixture();
    const input = chain(erasureRecords(item));
    expect((await replayVerifiedSuppressionChain({ ...input, ownerPool: owner })).eventCount).toBe(
      2,
    );
    const facts = await owner.query<{
      event_id: string;
      occurred_at: Date;
      share_cause_event_id: string | null;
    }>(
      `SELECT event_id,occurred_at,share_cause_event_id::text FROM restore_suppression_event
       WHERE event_id IN ($1,$2) ORDER BY occurred_at`,
      [item.childId, item.parentId],
    );
    expect(
      facts.rows.map((row) => [
        row.event_id,
        row.occurred_at.toISOString(),
        row.share_cause_event_id,
      ]),
    ).toEqual([
      [item.childId, '2026-09-30T12:00:00.000Z', item.parentId],
      [item.parentId, '2026-09-30T12:01:00.000Z', null],
    ]);
    const receipts = await owner.query(
      `SELECT (SELECT count(*)::int FROM restore_erasure_share_replay_receipt WHERE event_id=$1) child,
              (SELECT count(*)::int FROM restore_exact_replay_receipt WHERE event_id=$2) parent`,
      [item.childId, item.parentId],
    );
    expect(receipts.rows[0]).toEqual({ child: 1, parent: 1 });
    await replayVerifiedSuppressionChain({ ...input, ownerPool: owner });
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM restore_suppression_event WHERE athlete_id=$1',
          [item.athleteId],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  it('rejects malformed parent/child order and split groups before a DB connection', async () => {
    const item = await fixture();
    const resource = resourceRecords(item);
    const erasure = erasureRecords(item);
    for (const records of [
      [...resource].reverse(),
      [...erasure].reverse(),
      [
        resource[0] as SuppressionRecord,
        { ...resource[0], eventId: randomUUID() } as SuppressionRecord,
        resource[1] as SuppressionRecord,
      ],
      [resource[1] as SuppressionRecord],
      [erasure[0] as SuppressionRecord],
      [
        { ...erasure[0], shareCauseEventId: randomUUID() } as SuppressionRecord,
        erasure[1] as SuppressionRecord,
      ],
    ]) {
      const input = chain(records);
      await expect(
        replayVerifiedSuppressionChain({
          ...input,
          ownerPool: {
            connect: async () => {
              throw new Error('CONNECTED_BEFORE_PREFLIGHT');
            },
          },
        }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
    }
    expect(await state(item)).toMatchObject({
      access_revision: 2,
      active_shares: '1',
      child_events: '0',
      parent_events: '0',
    });
  });

  it('rejects authenticated but partial resource and erasure transactions atomically', async () => {
    const resource = await fixture();
    const erasure = await fixture();
    for (const [item, records] of [
      [resource, [resourceRecords(resource)[0] as SuppressionRecord]],
      [erasure, [erasureRecords(erasure)[1] as SuppressionRecord]],
    ] as const) {
      await expect(
        replayVerifiedSuppressionChain({ ...chain(records), ownerPool: owner }),
      ).rejects.toThrow();
      expect(await state(item)).toMatchObject({
        access_revision: 2,
        active_shares: '1',
        child_events: '0',
        parent_events: '0',
      });
    }
  });
});
