import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthKitIngestionBatch } from '@workout/contracts/healthkit-ingestion';
import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitBindingRepository } from '../src/healthkit-binding.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');

const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function ownerTenant<T>(
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

async function createTarget(athleteId: string, kind: 'manual' | 'fit' | 'fixture' = 'manual') {
  const activityId = randomUUID();
  const sourceId = randomUUID();
  const original = {
    title: 'synthetic workout',
    kind: 'running',
    startedAt: '2026-09-20T00:00:00Z',
    durationSeconds: 1800,
    durationKind: 'elapsed',
    timezone: 'Asia/Seoul',
    distanceMeters: 5000,
  };
  await ownerTenant(athleteId, async (client) => {
    await client.query(
      `INSERT INTO activity_canonical(athlete_id,id,revision,original)
       VALUES($1,$2,1,$3::jsonb)`,
      [athleteId, activityId, JSON.stringify(original)],
    );
    await client.query(
      `INSERT INTO activity_source_head
        (athlete_id,kind,source_id,source_revision,content_hash,activity_id)
       VALUES($1,$2,$3,1,$4,$5)`,
      [athleteId, kind, sourceId, 'a'.repeat(64), activityId],
    );
  });
  return { activityId, sourceId, original };
}

async function grantConsent(athleteId: string) {
  await ownerTenant(athleteId, (client) =>
    client.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    ),
  );
}

function workout(sampleId = randomUUID()): HealthKitIngestionBatch {
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId,
        sourceBundleId: 'com.apple.health',
        sourceVersion: null,
        activityType: 37,
        observedFrom: '2026-09-20T06:00:00+09:00',
        observedTo: '2026-09-20T06:30:00+09:00',
        durationSeconds: 1800,
        distanceMeters: 5000,
        energyKilocalories: null,
      },
    ],
  };
}

async function sampleDigest(athleteId: string, sampleId: string) {
  const found = await database.tenant(athleteId, (tx) =>
    tx.query('SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1', [sampleId]),
  );
  return String(found.rows[0]?.['payload_digest']);
}

async function prepared(athleteId = randomUUID()) {
  await grantConsent(athleteId);
  const target = await createTarget(athleteId);
  const batch = workout();
  await createHealthKitIngestionRepository(database).ingestBatch(athleteId, batch);
  const sampleId = batch.events[0]?.sampleId;
  if (!sampleId) throw new Error('Expected sample');
  const expectedSampleDigest = await sampleDigest(athleteId, sampleId);
  return { athleteId, ...target, batch, sampleId, expectedSampleDigest };
}

function command(input: Awaited<ReturnType<typeof prepared>>, idempotencyKey = randomUUID()) {
  return {
    sampleId: input.sampleId,
    targetActivityId: input.activityId,
    expectedActivityRevision: 1,
    expectedSampleDigest: input.expectedSampleDigest,
    confirmed: true as const,
    idempotencyKey,
  };
}

describe('M3-02e explicit existing Activity binding', () => {
  it('binds only supplementary lineage, retains the primary source and one Activity count', async () => {
    const fixture = await prepared();
    const repo = createHealthKitBindingRepository(database);
    const result = await repo.bindExisting(fixture.athleteId, command(fixture));
    expect(result).toEqual({
      sampleId: fixture.sampleId,
      activityId: fixture.activityId,
      activityRevision: 1,
      state: 'linked_existing',
    });
    const otherBatch = workout();
    await createHealthKitIngestionRepository(database).ingestBatch(fixture.athleteId, otherBatch);
    const otherSampleId = otherBatch.events[0]?.sampleId;
    if (!otherSampleId) throw new Error('Expected second sample');
    await repo.bindExisting(fixture.athleteId, {
      ...command(fixture),
      sampleId: otherSampleId,
      expectedSampleDigest: await sampleDigest(fixture.athleteId, otherSampleId),
      idempotencyKey: randomUUID(),
    });
    const read = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
        (SELECT count(*)::int FROM activity_canonical WHERE NOT deleted) AS activity_count,
        (SELECT count(*)::int FROM healthkit_existing_binding) AS binding_count,
        (SELECT count(*)::int FROM activity_source_head WHERE activity_id=$1) AS primary_count,
        (SELECT revision FROM activity_canonical WHERE id=$1) AS activity_revision,
        (SELECT original FROM activity_canonical WHERE id=$1) AS original,
        (SELECT kind FROM activity_source_head WHERE activity_id=$1) AS source_kind`,
        [fixture.activityId],
      ),
    );
    expect(read.rows[0]).toEqual({
      activity_count: 1,
      binding_count: 2,
      primary_count: 1,
      activity_revision: 1,
      original: fixture.original,
      source_kind: 'manual',
    });
    expect((await createActivityRepository(database).summary(fixture.athleteId)).count).toBe(1);
    const exported = await createOperationsRepository(database).exportAccount(fixture.athleteId);
    expect(exported.schemaVersion).toBe(27);
    if (exported.schemaVersion !== 27) throw new Error('Expected current account export');
    expect(exported.data.healthKitExistingBindings).toHaveLength(2);
  });

  it('serializes same-key replay and different-key decisions for one UUID', async () => {
    const first = await prepared();
    const repo = createHealthKitBindingRepository(database);
    const request = command(first);
    const same = await Promise.all([
      repo.bindExisting(first.athleteId, request),
      repo.bindExisting(first.athleteId, request),
    ]);
    expect(same[0]).toEqual(same[1]);
    await expect(
      repo.bindExisting(first.athleteId, {
        ...request,
        targetActivityId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const second = await prepared();
    const a = command(second);
    const b = { ...a, idempotencyKey: randomUUID() };
    const contenders = await Promise.allSettled([
      repo.bindExisting(second.athleteId, a),
      repo.bindExisting(second.athleteId, b),
    ]);
    expect(contenders.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(contenders.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const rejected = contenders.find((item) => item.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected rejected contender');
    expect(rejected.reason).toMatchObject({ code: 'ALREADY_LINKED' });
  });

  it('refuses stale, foreign, suppressed, deleted, fixture and changed raw decisions', async () => {
    const fixture = await prepared();
    const repo = createHealthKitBindingRepository(database);
    const base = command(fixture);
    await expect(
      repo.bindExisting(fixture.athleteId, {
        ...base,
        expectedActivityRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      repo.bindExisting(fixture.athleteId, {
        ...base,
        expectedSampleDigest: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_CONFLICT' });
    const foreign = await createTarget(randomUUID());
    await expect(
      repo.bindExisting(fixture.athleteId, {
        ...base,
        targetActivityId: foreign.activityId,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    await ownerTenant(fixture.athleteId, (client) =>
      client.query('INSERT INTO activity_suppression(athlete_id,kind,source_id) VALUES($1,$2,$3)', [
        fixture.athleteId,
        'manual',
        fixture.sourceId,
      ]),
    );
    await expect(repo.bindExisting(fixture.athleteId, base)).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        'DELETE FROM activity_suppression WHERE athlete_id=$1 AND kind=$2 AND source_id=$3',
        [fixture.athleteId, 'manual', fixture.sourceId],
      ),
    );
    const testTarget = await createTarget(fixture.athleteId, 'fixture');
    await expect(
      repo.bindExisting(fixture.athleteId, {
        ...base,
        targetActivityId: testTarget.activityId,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    await ownerTenant(fixture.athleteId, (client) =>
      client.query('UPDATE activity_canonical SET deleted=true WHERE athlete_id=$1 AND id=$2', [
        fixture.athleteId,
        fixture.activityId,
      ]),
    );
    await expect(repo.bindExisting(fixture.athleteId, base)).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        "UPDATE healthkit_workout_lineage SET state='suppressed' WHERE athlete_id=$1 AND sample_id=$2",
        [fixture.athleteId, fixture.sampleId],
      ),
    );
    await expect(
      repo.bindExisting(fixture.athleteId, {
        ...base,
        targetActivityId: testTarget.activityId,
      }),
    ).rejects.toMatchObject({ code: 'SAMPLE_UNAVAILABLE' });
  });

  it('removes binding on raw tombstone and never revives it from a late upsert', async () => {
    const fixture = await prepared();
    const repo = createHealthKitBindingRepository(database);
    await repo.bindExisting(fixture.athleteId, command(fixture));
    await createHealthKitIngestionRepository(database).ingestBatch(fixture.athleteId, {
      schemaVersion: 1,
      installationId: fixture.batch.installationId,
      batchId: randomUUID(),
      events: [{ kind: 'delete', sampleId: fixture.sampleId }],
    });
    await createHealthKitIngestionRepository(database).ingestBatch(fixture.athleteId, {
      ...fixture.batch,
      batchId: randomUUID(),
    });
    const result = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
        (SELECT count(*)::int FROM healthkit_existing_binding) AS binding_count,
        (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage_state,
        (SELECT count(*)::int FROM activity_canonical WHERE NOT deleted) AS activity_count`,
        [fixture.sampleId],
      ),
    );
    expect(result.rows[0]).toEqual({
      binding_count: 0,
      lineage_state: 'deleted',
      activity_count: 1,
    });
  });

  it('removes a link when the target source is suppressed without a canonical tombstone', async () => {
    const fixture = await prepared();
    await createHealthKitBindingRepository(database).bindExisting(
      fixture.athleteId,
      command(fixture),
    );
    await ownerTenant(fixture.athleteId, (client) =>
      client.query('INSERT INTO activity_suppression(athlete_id,kind,source_id) VALUES($1,$2,$3)', [
        fixture.athleteId,
        'manual',
        fixture.sourceId,
      ]),
    );
    const result = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
        (SELECT count(*)::int FROM healthkit_existing_binding) AS binding_count,
        (SELECT state FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage_state`,
        [fixture.sampleId],
      ),
    );
    expect(result.rows[0]).toEqual({ binding_count: 0, lineage_state: 'suppressed' });
    await createHealthKitIngestionRepository(database).ingestBatch(fixture.athleteId, {
      ...fixture.batch,
      batchId: randomUUID(),
    });
    await expect(
      createHealthKitBindingRepository(database).bindExisting(
        fixture.athleteId,
        command(fixture, randomUUID()),
      ),
    ).rejects.toMatchObject({ code: 'SAMPLE_UNAVAILABLE' });
  });

  it('withdrawal and erasure remove link data and redact command receipts', async () => {
    const fixture = await prepared();
    const request = command(fixture);
    const repo = createHealthKitBindingRepository(database);
    await repo.bindExisting(fixture.athleteId, request);
    await ownerTenant(fixture.athleteId, (client) =>
      client.query(
        "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='healthkit'",
        [fixture.athleteId],
      ),
    );
    const withdrawn = await database.tenant(fixture.athleteId, (tx) =>
      tx.query(
        `SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_lineage) AS lineage_count,
        (SELECT count(*)::int FROM healthkit_existing_binding) AS binding_count,
        (SELECT result FROM command_receipt WHERE idempotency_key=$1) AS receipt`,
        [`healthkit-bind-existing:${request.idempotencyKey}`],
      ),
    );
    expect(withdrawn.rows[0]).toEqual({
      raw_count: 0,
      lineage_count: 0,
      binding_count: 0,
      receipt: { purged: true },
    });
    await expect(repo.bindExisting(fixture.athleteId, request)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });

    const erased = await prepared();
    await repo.bindExisting(erased.athleteId, command(erased));
    await createOperationsRepository(database).eraseAccount(erased.athleteId);
    await expect(
      database.tenant(erased.athleteId, (tx) => tx.query('SELECT 1')),
    ).rejects.toMatchObject({
      message: 'ACCOUNT_ERASED',
    });
    const owner = await admin.query(
      'SELECT count(*)::int AS n FROM healthkit_existing_binding WHERE athlete_id=$1',
      [erased.athleteId],
    );
    expect(owner.rows[0]?.['n']).toBe(0);
  });
});
