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
});
