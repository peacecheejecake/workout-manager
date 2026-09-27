import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthKitIngestionBatch } from '@workout/contracts/healthkit-ingestion';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitProjectionRepository } from '../src/healthkit-projection.js';
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
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

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
        observedTo: '2026-09-20T06:35:00+09:00',
        durationSeconds: 2100,
        distanceMeters: 5000,
        energyKilocalories: null,
      },
    ],
  };
}

async function grantConsent(athleteId: string) {
  await database.tenant(athleteId, (tx) =>
    tx.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    ),
  );
}

describe('M3-02a raw HealthKit ingestion', () => {
  it('locks only the session tenant consent without granting the caller consent table reads', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const role = `wm_hk_probe_${randomUUID().replaceAll('-', '')}`;
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role}`);
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.healthkit_ingestion_consent_locked() TO ${role}`,
      );
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const own = await client.query(
        `SELECT public.healthkit_ingestion_consent_locked() AS granted,
                has_table_privilege(current_user,'consent','SELECT') AS can_read_consent`,
      );
      expect(own.rows[0]).toEqual({ granted: true, can_read_consent: false });
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [randomUUID()]);
      const absent = await client.query(
        'SELECT public.healthkit_ingestion_consent_locked() AS granted',
      );
      expect(absent.rows[0]?.['granted']).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('requires current consent and never creates a canonical Activity', async () => {
    const athlete = randomUUID();
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    await expect(repo.ingestBatch(athlete, batch)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await grantConsent(athlete);
    const ack = await repo.ingestBatch(athlete, batch);
    expect(ack).toEqual({
      schemaVersion: 1,
      installationId: batch.installationId,
      batchId: batch.batchId,
      acceptedCount: 1,
    });
    const state = await database.tenant(athlete, (tx) =>
      tx.query(`SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt) AS receipt_count,
        (SELECT count(*)::int FROM activity_canonical) AS canonical_count,
        (SELECT count(*)::int FROM healthkit_workout_lineage WHERE state='pending_review') AS pending_count`),
    );
    expect(state.rows[0]).toEqual({
      raw_count: 1,
      receipt_count: 1,
      canonical_count: 0,
      pending_count: 1,
    });
  });

  it('returns the original ACK for concurrent identical batches, and rejects changed payloads', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    const firstEvent = batch.events[0];
    if (firstEvent?.kind !== 'upsert') throw new Error('Expected workout fixture');
    const [first, second] = await Promise.all([
      repo.ingestBatch(athlete, batch),
      repo.ingestBatch(athlete, batch),
    ]);
    expect(first).toEqual(second);
    expect(await repo.ingestBatch(athlete, batch)).toEqual(first);
    await expect(
      repo.ingestBatch(athlete, {
        ...batch,
        events: [{ ...firstEvent, distanceMeters: 6000 }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const result = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM healthkit_workout_sample'),
    );
    expect(result.rows[0]?.['n']).toBe(1);
  });

  it('preserves an explicit suppression across a later duplicate upsert', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    const sampleId = batch.events[0]?.sampleId;
    if (!sampleId) throw new Error('Expected workout fixture');
    await repo.ingestBatch(athlete, batch);
    await admin.query(
      "UPDATE healthkit_workout_lineage SET state='suppressed' WHERE athlete_id=$1 AND sample_id=$2",
      [athlete, sampleId],
    );
    await repo.ingestBatch(athlete, { ...batch, batchId: randomUUID() });
    expect(await createHealthKitProjectionRepository(database).listLineage(athlete, 100)).toEqual([
      { sampleId, state: 'suppressed' },
    ]);
    const result = await database.tenant(athlete, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM activity_canonical'),
    );
    expect(result.rows[0]?.['n']).toBe(0);
  });

  it('grants review lineage reads only to the runtime role', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const batch = workout();
    await createHealthKitIngestionRepository(database).ingestBatch(athlete, batch);
    const permissions = await database.tenant(athlete, (tx) =>
      tx.query(`SELECT
        has_table_privilege(current_user,'healthkit_workout_lineage','SELECT') AS can_read,
        has_table_privilege(current_user,'healthkit_workout_lineage','INSERT') AS can_insert,
        has_table_privilege(current_user,'healthkit_workout_lineage','UPDATE') AS can_update,
        has_table_privilege(current_user,'healthkit_workout_lineage','DELETE') AS can_delete`),
    );
    expect(permissions.rows[0]).toEqual({
      can_read: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    });
    const foreign = await database.tenant(randomUUID(), (tx) =>
      tx.query('SELECT sample_id,state FROM healthkit_workout_lineage'),
    );
    expect(foreign.rows).toEqual([]);
  });

  it('rolls back raw rows and ACK when the same-transaction projection fails', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    const sampleId = batch.events[0]?.sampleId;
    if (!sampleId) throw new Error('Expected workout fixture');
    const checkName = `hk_projection_reject_${sampleId.replaceAll('-', '')}`;
    try {
      await admin.query(
        `ALTER TABLE healthkit_workout_lineage ADD CONSTRAINT ${checkName}
         CHECK (sample_id <> '${sampleId}'::uuid)`,
      );
      await expect(repo.ingestBatch(athlete, batch)).rejects.toThrow();
      const failed = await database.tenant(athlete, (tx) =>
        tx.query(
          `SELECT
          (SELECT count(*)::int FROM healthkit_workout_sample WHERE sample_id=$1) AS raw_count,
          (SELECT count(*)::int FROM healthkit_workout_lineage WHERE sample_id=$1) AS lineage_count,
          (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE batch_id=$2) AS receipt_count`,
          [sampleId, batch.batchId],
        ),
      );
      expect(failed.rows[0]).toEqual({ raw_count: 0, lineage_count: 0, receipt_count: 0 });
    } finally {
      await admin.query(
        `ALTER TABLE healthkit_workout_lineage DROP CONSTRAINT IF EXISTS ${checkName}`,
      );
    }
    expect((await repo.ingestBatch(athlete, batch)).acceptedCount).toBe(1);
  });

  it('makes deletion irreversible for the HealthKit UUID and isolates tenants', async () => {
    const athlete = randomUUID();
    const other = randomUUID();
    await grantConsent(athlete);
    await grantConsent(other);
    const repo = createHealthKitIngestionRepository(database);
    const original = workout();
    const sampleId = original.events[0]?.sampleId;
    if (!sampleId) throw new Error('Expected workout fixture');
    await repo.ingestBatch(athlete, original);
    const deletion: HealthKitIngestionBatch = {
      schemaVersion: 1,
      installationId: original.installationId,
      batchId: randomUUID(),
      events: [{ kind: 'delete', sampleId }],
    };
    await repo.ingestBatch(athlete, deletion);
    await repo.ingestBatch(athlete, { ...original, batchId: randomUUID() });
    const first = await database.tenant(athlete, (tx) =>
      tx.query('SELECT state,source_bundle_id,deleted_at FROM healthkit_workout_sample'),
    );
    expect(first.rows[0]).toMatchObject({ state: 'deleted', source_bundle_id: null });
    expect(first.rows[0]?.['deleted_at']).toBeInstanceOf(Date);
    expect(await createHealthKitProjectionRepository(database).listLineage(athlete, 100)).toEqual([
      { sampleId, state: 'deleted' },
    ]);
    const invisible = await database.tenant(other, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM healthkit_workout_sample'),
    );
    expect(invisible.rows[0]?.['n']).toBe(0);
    expect(await createHealthKitProjectionRepository(database).listLineage(other, 100)).toEqual([]);
    await expect(
      database.tenant(other, (tx) =>
        tx.query('SELECT state FROM healthkit_workout_sample WHERE athlete_id=$1', [athlete]),
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('purges raw data on withdrawal and blocks replay of a purged receipt after re-consent', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    await repo.ingestBatch(athlete, batch);
    await database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [athlete],
      ),
    );
    const purged = await database.tenant(athlete, (tx) =>
      tx.query(`SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE purged_at IS NOT NULL) AS purged_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE request_digest IS NOT NULL) AS digest_count,
        (SELECT count(*)::int FROM healthkit_workout_lineage) AS lineage_count`),
    );
    expect(purged.rows[0]).toEqual({
      raw_count: 0,
      purged_count: 1,
      digest_count: 0,
      lineage_count: 0,
    });
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    if (exported.schemaVersion !== 26) throw new Error('Expected current export version');
    expect(exported.data.healthKitWorkoutBatchReceipts[0]).not.toHaveProperty('request_digest');
    await expect(repo.ingestBatch(athlete, batch)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE consent SET granted=true,revision=3 WHERE athlete_id=$1 AND kind='healthkit'",
        [athlete],
      ),
    );
    await expect(repo.ingestBatch(athlete, batch)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('serializes an in-flight ingest with consent withdrawal and purges after the ingest commits', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const gatedDatabase: Database = {
      ...database,
      tenant: (id, work) =>
        database.tenant(id, (tx) =>
          work({
            ...tx,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.includes('SELECT public.healthkit_ingestion_consent_locked()')) {
                signalLocked();
                await release;
              }
              return result;
            },
          }),
        ),
    };
    const ingest = createHealthKitIngestionRepository(gatedDatabase).ingestBatch(
      athlete,
      workout(),
    );
    await locked;
    const withdrawal = database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [athlete],
      ),
    );
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const activity = await admin.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE wait_event='transactionid' AND query LIKE 'UPDATE consent SET granted=false%'
           AND pid<>pg_backend_pid()`,
        );
        if (activity.rowCount) {
          waiting = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(waiting).toBe(true);
    } finally {
      releaseLock();
    }
    await ingest;
    await withdrawal;
    const result = await database.tenant(athlete, (tx) =>
      tx.query(`SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE purged_at IS NOT NULL) AS purged_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE request_digest IS NOT NULL) AS digest_count`),
    );
    expect(result.rows[0]).toEqual({ raw_count: 0, purged_count: 1, digest_count: 0 });
  });

  it('includes raw source and tombstone state in owner export, and erases all HealthKit rows', async () => {
    const athlete = randomUUID();
    await grantConsent(athlete);
    const repo = createHealthKitIngestionRepository(database);
    const batch = workout();
    await repo.ingestBatch(athlete, batch);
    const operations = createOperationsRepository(database);
    const exported = await operations.exportAccount(athlete);
    expect(exported.schemaVersion).toBe(26);
    if (exported.schemaVersion !== 26) throw new Error('Expected current export version');
    expect(exported.data.healthKitWorkoutSamples).toHaveLength(1);
    expect(exported.data.healthKitWorkoutBatchReceipts).toHaveLength(1);
    expect(exported.data.healthKitWorkoutLineage).toEqual([
      { sample_id: batch.events[0]?.sampleId, state: 'pending_review' },
    ]);
    await operations.eraseAccount(athlete);
    const remaining = await admin.query(
      `SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample WHERE athlete_id=$1) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_lineage WHERE athlete_id=$1) AS lineage_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt WHERE athlete_id=$1) AS receipt_count`,
      [athlete],
    );
    expect(remaining.rows[0]).toEqual({ raw_count: 0, lineage_count: 0, receipt_count: 0 });
  });
});
