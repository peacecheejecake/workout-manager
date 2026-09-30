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
const databaseName = `chain_replay_${suffix}`;
const ownerRole = `chain_owner_${suffix}`;
const runtimeRole = `chain_app_${suffix}`;
const key = Buffer.alloc(32, 42);
const keyId = 'local-db-test';
const clusterId = '123456789';
let owner: Pool;
let runtime: Pool;

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

async function account(): Promise<string> {
  const result = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
      VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const athleteId = result.rows[0]?.athlete_id;
  if (!athleteId) throw new Error('missing account');
  return athleteId;
}

async function restoredCourse(athleteId: string, courseId: string): Promise<void> {
  await tenant(athleteId, (client) =>
    client.query(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
         reclaimed_at,created_at,updated_at)
       VALUES($1,$2,'Restored course','private','unavailable','source_activity_deleted',
         now(),now(),now())`,
      [athleteId, courseId],
    ),
  );
}

async function restoredActivity(athleteId: string, activityId: string): Promise<void> {
  await tenant(athleteId, async (client) => {
    await client.query(
      `INSERT INTO activity_canonical(athlete_id,id,revision,original)
       VALUES($1,$2,1,'{}'::jsonb)`,
      [athleteId, activityId],
    );
    await client.query(
      `INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id)
       VALUES($1,'fixture',$2,1,repeat('a',64),$3)`,
      [athleteId, randomUUID(), activityId],
    );
  });
}

async function restoredResource(athleteId: string, resourceId: string): Promise<void> {
  const versionId = randomUUID();
  await tenant(athleteId, async (client) => {
    await client.query(
      `INSERT INTO resource(athlete_id,id,title,category,metadata,tags,
         access_revision,current_version,current_version_id,created_at,updated_at)
       VALUES($1,$2,'Synthetic note','note','{}'::jsonb,'[]'::jsonb,
         1,1,$3,'2026-09-29 00:00:00+00','2026-09-29 00:00:00+00')`,
      [athleteId, resourceId, versionId],
    );
    await client.query(
      `INSERT INTO resource_version(athlete_id,resource_id,version_id,version,
         content,content_hash,paragraphs,content_status,index_status,created_at)
       VALUES($1,$2,$3,1,'Synthetic text',repeat('a',64),
         '[{"text":"Synthetic text"}]'::jsonb,'parsed','not_indexed','2026-09-29 00:00:00+00')`,
      [athleteId, resourceId, versionId],
    );
  });
}

function chain(records: readonly SuppressionRecord[]): {
  segments: Buffer[];
  anchor: TrustedReplayAnchor;
} {
  if (records.length !== 2) throw new Error('two-record fixture required');
  let previousHash: string | null = null;
  const segments: Buffer[] = [];
  for (const [index, record] of records.entries()) {
    const fromLsn = index === 0 ? '0/100' : '0/120';
    const throughLsn = index === 0 ? '0/120' : '0/140';
    const body = {
      localRecordVersion: 1 as const,
      clusterId,
      fromLsn,
      throughLsn,
      previousHash,
      transactions: [
        { commitLsn: index === 0 ? '0/110' : '0/130', endLsn: throughLsn, records: [record] },
      ],
    };
    const envelope: LocalReplayRecordEnvelope = {
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    };
    segments.push(encryptReplaySegment({ envelope, key, keyId }).bytes);
    previousHash = envelope.sha256;
  }
  return {
    segments,
    anchor: {
      clusterId,
      fromLsn: '0/100',
      previousHash: null,
      throughLsn: '0/140',
      finalLocalHash: previousHash ?? '',
      ciphertextHashes: segments.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
    },
  };
}

function courseRecord(athleteId: string, targetId: string, occurredAt: string): SuppressionRecord {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    athleteId,
    occurredAt,
    kind: 'course_deleted',
    targetId,
  };
}

function erasureRecord(athleteId: string, occurredAt: string): SuppressionRecord {
  return { schemaVersion: 1, eventId: randomUUID(), athleteId, occurredAt, kind: 'tenant_erased' };
}

function activityRecord(
  athleteId: string,
  targetId: string,
  occurredAt: string,
  sourceKind: 'fixture' | 'manual' = 'fixture',
): SuppressionRecord {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    athleteId,
    occurredAt,
    kind: 'activity_deleted',
    targetId,
    activityRevision: 2,
    sourceKind,
    sourceId: randomUUID(),
    sourceRevision: 1,
    sourceContentHash: 'a'.repeat(64),
  };
}

function resourceRecord(
  athleteId: string,
  targetId: string,
  occurredAt: string,
): SuppressionRecord {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    athleteId,
    occurredAt,
    kind: 'resource_deleted',
    targetId,
    resourceAccessRevision: 2,
  };
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

describe('authenticated chain to owner-only exact replay', () => {
  it('applies ordered course deletion then erasure once and retries the exact chain', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    await restoredCourse(athleteId, courseId);
    const earlier = '2026-09-30 12:34:56+00';
    const later = '2026-09-30 12:35:56+00';
    const sample = chain([
      courseRecord(athleteId, courseId, earlier),
      erasureRecord(athleteId, later),
    ]);
    const result = await replayVerifiedSuppressionChain({
      ...sample,
      key,
      keyId,
      ownerPool: owner,
    });
    expect(result.eventCount).toBe(2);
    expect(result).not.toHaveProperty('athleteId');
    await replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner });
    const state = await tenant(athleteId, (client) =>
      client.query<{ events: string; receipts: string; course: string; erased: string }>(
        `SELECT
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE athlete_id=$1) receipts,
          (SELECT count(*)::text FROM course WHERE athlete_id=$1 AND course_id=$2) course,
          (SELECT count(*)::text FROM tenant_erasure WHERE athlete_id=$1) erased`,
        [athleteId, courseId],
      ),
    );
    expect(state.rows[0]).toMatchObject({ events: '2', receipts: '2', course: '0', erased: '1' });
  });

  it('rolls back the first record when a later course belongs to another tenant', async () => {
    const athleteId = await account();
    const other = await account();
    const firstCourse = randomUUID();
    const foreignCourse = randomUUID();
    await restoredCourse(athleteId, firstCourse);
    await restoredCourse(other, foreignCourse);
    const sample = chain([
      courseRecord(athleteId, firstCourse, '2026-09-30 12:34:56+00'),
      courseRecord(athleteId, foreignCourse, '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
    ).rejects.toThrow('COURSE_REPLAY_FOREIGN_COURSE');
    const state = await tenant(athleteId, (client) =>
      client.query<{ course: string; events: string; receipts: string }>(
        `SELECT
          (SELECT count(*)::text FROM course WHERE athlete_id=$1 AND course_id=$2) course,
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE athlete_id=$1) receipts`,
        [athleteId, firstCourse],
      ),
    );
    expect(state.rows[0]).toMatchObject({ course: '1', events: '0', receipts: '0' });
  });

  it('rejects a non-owner pool and leaves the restored course untouched', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    await restoredCourse(athleteId, courseId);
    const sample = chain([
      courseRecord(athleteId, courseId, '2026-09-30 12:34:56+00'),
      erasureRecord(athleteId, '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: runtime }),
    ).rejects.toThrow(/permission denied/);
    expect(
      (
        await tenant(athleteId, (client) =>
          client.query('SELECT 1 FROM course WHERE athlete_id=$1 AND course_id=$2', [
            athleteId,
            courseId,
          ]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('replays activity deletion then exact erasure and retries without identifiers in the result', async () => {
    const athleteId = await account();
    const sample = chain([
      activityRecord(athleteId, randomUUID(), '2026-09-30 12:34:56+00'),
      erasureRecord(athleteId, '2026-09-30 12:35:56+00'),
    ]);
    const result = await replayVerifiedSuppressionChain({
      ...sample,
      key,
      keyId,
      ownerPool: owner,
    });
    expect(Object.keys(result).sort()).toEqual([
      'clusterId',
      'eventCount',
      'finalLocalHash',
      'segmentCount',
      'throughLsn',
    ]);
    await replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner });
    const state = await tenant(athleteId, (client) =>
      client.query<{
        events: string;
        activity_receipts: string;
        erasure_receipts: string;
        activities: string;
        erased: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_activity_replay_receipt WHERE athlete_id=$1) activity_receipts,
          (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE athlete_id=$1) erasure_receipts,
          (SELECT count(*)::text FROM activity_canonical WHERE athlete_id=$1) activities,
          (SELECT count(*)::text FROM tenant_erasure WHERE athlete_id=$1) erased`,
        [athleteId],
      ),
    );
    expect(state.rows[0]).toMatchObject({
      events: '2',
      activity_receipts: '1',
      erasure_receipts: '1',
      activities: '0',
      erased: '1',
    });
  });

  it('rolls back an earlier activity when a later activity names a foreign owner', async () => {
    const athleteId = await account();
    const other = await account();
    const foreignId = randomUUID();
    await restoredActivity(other, foreignId);
    const first = activityRecord(athleteId, randomUUID(), '2026-09-30 12:34:56+00');
    const later = activityRecord(athleteId, foreignId, '2026-09-30 12:35:56+00');
    const sample = chain([first, later]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
    ).rejects.toThrow('RESTORE_ACTIVITY_FOREIGN_ACTIVITY');
    const state = await tenant(athleteId, (client) =>
      client.query<{ events: string; receipts: string; activities: string }>(
        `SELECT
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_activity_replay_receipt WHERE athlete_id=$1) receipts,
          (SELECT count(*)::text FROM activity_canonical WHERE athlete_id=$1) activities`,
        [athleteId],
      ),
    );
    expect(state.rows[0]).toMatchObject({ events: '0', receipts: '0', activities: '0' });
    expect(
      (
        await tenant(other, (client) =>
          client.query('SELECT 1 FROM activity_canonical WHERE athlete_id=$1 AND id=$2', [
            other,
            foreignId,
          ]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('rejects conflicting event identity for the same activity and rolls back both', async () => {
    const athleteId = await account();
    const targetId = randomUUID();
    const sample = chain([
      activityRecord(athleteId, targetId, '2026-09-30 12:34:56+00'),
      activityRecord(athleteId, targetId, '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
    ).rejects.toThrow('RESTORE_ACTIVITY_EVENT_CONFLICT');
    const state = await tenant(athleteId, (client) =>
      client.query<{ events: string; receipts: string; activities: string }>(
        `SELECT
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_activity_replay_receipt WHERE athlete_id=$1) receipts,
          (SELECT count(*)::text FROM activity_canonical WHERE athlete_id=$1) activities`,
        [athleteId],
      ),
    );
    expect(state.rows[0]).toMatchObject({ events: '0', receipts: '0', activities: '0' });
  });

  it('rolls back an earlier course for an unsupported absent manual activity', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    await restoredCourse(athleteId, courseId);
    const sample = chain([
      courseRecord(athleteId, courseId, '2026-09-30 12:34:56+00'),
      activityRecord(athleteId, randomUUID(), '2026-09-30 12:35:56+00', 'manual'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
    ).rejects.toThrow('RESTORE_ACTIVITY_MANUAL_ABSENT_UNSUPPORTED');
    expect(
      (
        await tenant(athleteId, (client) =>
          client.query('SELECT 1 FROM course WHERE athlete_id=$1 AND course_id=$2', [
            athleteId,
            courseId,
          ]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('denies an activity chain through the runtime pool before an erasure can apply', async () => {
    const athleteId = await account();
    const sample = chain([
      activityRecord(athleteId, randomUUID(), '2026-09-30 12:34:56+00'),
      erasureRecord(athleteId, '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: runtime }),
    ).rejects.toThrow(/permission denied/);
    expect(
      (
        await tenant(athleteId, (client) =>
          client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [athleteId]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it('replays a resource deletion then erasure exactly once without identifiers in the result', async () => {
    const athleteId = await account();
    const resourceId = randomUUID();
    await restoredResource(athleteId, resourceId);
    const sample = chain([
      resourceRecord(athleteId, resourceId, '2026-09-30 12:34:56+00'),
      erasureRecord(athleteId, '2026-09-30 12:35:56+00'),
    ]);
    const result = await replayVerifiedSuppressionChain({
      ...sample,
      key,
      keyId,
      ownerPool: owner,
    });
    expect(Object.keys(result).sort()).toEqual([
      'clusterId',
      'eventCount',
      'finalLocalHash',
      'segmentCount',
      'throughLsn',
    ]);
    await replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner });
    const state = await tenant(athleteId, (client) =>
      client.query<{
        events: string;
        resource_receipts: string;
        erasure_receipts: string;
        resources: string;
        erased: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
          (SELECT count(*)::text FROM restore_resource_replay_receipt WHERE athlete_id=$1) resource_receipts,
          (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE athlete_id=$1) erasure_receipts,
          (SELECT count(*)::text FROM resource WHERE athlete_id=$1) resources,
          (SELECT count(*)::text FROM tenant_erasure WHERE athlete_id=$1) erased`,
        [athleteId],
      ),
    );
    expect(state.rows[0]).toMatchObject({
      events: '2',
      resource_receipts: '1',
      erasure_receipts: '1',
      resources: '0',
      erased: '1',
    });
  });

  it('rolls back an earlier course when the later resource head is absent', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    await restoredCourse(athleteId, courseId);
    const sample = chain([
      courseRecord(athleteId, courseId, '2026-09-30 12:34:56+00'),
      resourceRecord(athleteId, randomUUID(), '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
    ).rejects.toThrow('RESTORE_RESOURCE_ABSENT_UNSUPPORTED');
    expect(
      (
        await tenant(athleteId, (client) =>
          client.query('SELECT 1 FROM course WHERE athlete_id=$1 AND course_id=$2', [
            athleteId,
            courseId,
          ]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('rolls back an earlier resource for a later foreign owner or conflicting event', async () => {
    const athleteId = await account();
    const other = await account();
    const firstId = randomUUID();
    const foreignId = randomUUID();
    await restoredResource(athleteId, firstId);
    await restoredResource(other, foreignId);
    const first = resourceRecord(athleteId, firstId, '2026-09-30 12:34:56+00');
    const foreign = resourceRecord(athleteId, foreignId, '2026-09-30 12:35:56+00');
    const conflict = resourceRecord(athleteId, firstId, '2026-09-30 12:35:56+00');
    for (const [later, error] of [
      [foreign, 'RESTORE_RESOURCE_FOREIGN_RESOURCE'],
      [conflict, 'RESTORE_RESOURCE_EVENT_CONFLICT'],
    ] as const) {
      const sample = chain([first, later]);
      await expect(
        replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: owner }),
      ).rejects.toThrow(error);
      const state = await tenant(athleteId, (client) =>
        client.query<{ events: string; receipts: string; revision: number }>(
          `SELECT
            (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) events,
            (SELECT count(*)::text FROM restore_resource_replay_receipt WHERE athlete_id=$1) receipts,
            (SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2) revision`,
          [athleteId, firstId],
        ),
      );
      expect(state.rows[0]).toMatchObject({ events: '0', receipts: '0', revision: 1 });
    }
  });

  it('denies the resource chain through a runtime pool', async () => {
    const athleteId = await account();
    const resourceId = randomUUID();
    await restoredResource(athleteId, resourceId);
    const sample = chain([
      resourceRecord(athleteId, resourceId, '2026-09-30 12:34:56+00'),
      erasureRecord(athleteId, '2026-09-30 12:35:56+00'),
    ]);
    await expect(
      replayVerifiedSuppressionChain({ ...sample, key, keyId, ownerPool: runtime }),
    ).rejects.toThrow(/permission denied/);
    expect(
      (
        await tenant(athleteId, (client) =>
          client.query('SELECT access_revision FROM resource WHERE athlete_id=$1 AND id=$2', [
            athleteId,
            resourceId,
          ]),
        )
      ).rows[0]?.access_revision,
    ).toBe(1);
  });
});
