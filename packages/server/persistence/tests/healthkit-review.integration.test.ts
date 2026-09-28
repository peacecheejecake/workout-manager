import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitProjectionRepository } from '../src/healthkit-projection.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function ownerTenant<T>(athleteId: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function consent(athleteId: string, granted: boolean) {
  await ownerTenant(athleteId, (client) =>
    client.query(
      `INSERT INTO consent(athlete_id,kind,granted,revision)
       VALUES($1,'healthkit',$2,1)
       ON CONFLICT (athlete_id,kind) DO UPDATE
         SET granted=EXCLUDED.granted,revision=consent.revision+1`,
      [athleteId, granted],
    ),
  );
}

async function ingest(
  athleteId: string,
  options: {
    sampleId?: string;
    at?: string;
    activityType?: number;
    distanceMeters?: number | null;
  } = {},
) {
  const sampleId = options.sampleId ?? randomUUID();
  const observedFrom = options.at ?? '2026-09-20T00:00:00Z';
  const observedTo = new Date(Date.parse(observedFrom) + 60 * 60 * 1000).toISOString();
  await createHealthKitIngestionRepository(database).ingestBatch(athleteId, {
    schemaVersion: 1,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId,
        sourceBundleId: 'com.apple.health',
        sourceVersion: '1',
        activityType: options.activityType ?? 37,
        observedFrom,
        observedTo,
        durationSeconds: 1800,
        distanceMeters: options.distanceMeters ?? null,
        energyKilocalories: 400,
      },
    ],
  });
  return sampleId;
}

describe('M3-02g owner-scoped HealthKit review queue', () => {
  it('returns bounded, deterministic, minimal pending facts and isolates tenants', async () => {
    const athleteId = randomUUID();
    const other = randomUUID();
    await consent(athleteId, true);
    await consent(other, true);
    const earlier = await ingest(athleteId, {
      at: '2026-09-19T00:00:00Z',
      activityType: 13,
      distanceMeters: 12000,
    });
    const first = randomUUID();
    const second = randomUUID();
    await ingest(athleteId, { sampleId: first });
    await ingest(athleteId, { sampleId: second });
    await ingest(other, { activityType: 50 });

    const repo = createHealthKitProjectionRepository(database);
    const own = await repo.listPendingWorkouts(athleteId, 100);
    expect(own.items.map((item) => item.sampleId)).toEqual([...[first, second].sort(), earlier]);
    expect(own.items[0]).toMatchObject({
      kind: 'running',
      durationSeconds: 1800,
      distanceMeters: null,
      observedFrom: '2026-09-20T00:00:00.000Z',
    });
    expect(own.items[2]).toMatchObject({ kind: 'cycling', distanceMeters: 12000 });
    expect(Object.keys(own.items[0] ?? {}).sort()).toEqual(
      [
        'sampleId',
        'expectedSampleDigest',
        'kind',
        'observedFrom',
        'observedTo',
        'durationSeconds',
        'distanceMeters',
      ].sort(),
    );
    expect(own.items[0]?.expectedSampleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await repo.listPendingWorkouts(athleteId, 2)).items).toEqual(own.items.slice(0, 2));
    expect((await repo.listPendingWorkouts(other, 100)).items).toHaveLength(1);
    for (const limit of [0, 101, 1.2])
      await expect(repo.listPendingWorkouts(athleteId, limit)).rejects.toThrow();
  });

  it('omits every non-pending lineage state and deleted raw sample', async () => {
    const athleteId = randomUUID();
    await consent(athleteId, true);
    const pending = await ingest(athleteId);
    const linked = await ingest(athleteId);
    const created = await ingest(athleteId);
    const suppressed = await ingest(athleteId);
    const deleted = await ingest(athleteId);
    for (const [sampleId, state] of [
      [linked, 'linked_existing'],
      [created, 'created_activity'],
      [suppressed, 'suppressed'],
    ] as const) {
      await ownerTenant(athleteId, (client) =>
        client.query(
          'UPDATE healthkit_workout_lineage SET state=$3 WHERE athlete_id=$1 AND sample_id=$2',
          [athleteId, sampleId, state],
        ),
      );
    }
    await createHealthKitIngestionRepository(database).ingestBatch(athleteId, {
      schemaVersion: 1,
      installationId: randomUUID(),
      batchId: randomUUID(),
      events: [{ kind: 'delete', sampleId: deleted }],
    });
    const items = (
      await createHealthKitProjectionRepository(database).listPendingWorkouts(athleteId, 100)
    ).items;
    expect(items.map((item) => item.sampleId)).toEqual([pending]);
  });

  it('reveals no workout when consent is absent or withdrawn', async () => {
    const athleteId = randomUUID();
    const repo = createHealthKitProjectionRepository(database);
    await expect(repo.listPendingWorkouts(athleteId, 50)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await consent(athleteId, true);
    await ingest(athleteId);
    expect((await repo.listPendingWorkouts(athleteId, 50)).items).toHaveLength(1);
    await consent(athleteId, false);
    await expect(repo.listPendingWorkouts(athleteId, 50)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    const raw = await database.tenant(athleteId, (tx) =>
      tx.query('SELECT count(*)::int AS count FROM healthkit_workout_sample'),
    );
    expect(raw.rows[0]?.['count']).toBe(0);
  });
});
