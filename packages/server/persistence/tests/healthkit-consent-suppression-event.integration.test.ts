import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HealthKitIngestionBatch } from '@workout/contracts/healthkit-ingestion';

import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const runtime = new Pool({ connectionString: runtimeUrl });
let database: Database;

type ConsentEvent = {
  event_id: string;
  athlete_id: string;
  kind: string;
  target_id: string | null;
  consent_previous_revision: number | null;
  consent_previous_granted: boolean | null;
  consent_revision: number;
  consent_granted: boolean;
};

async function events(tenant: string): Promise<ConsentEvent[]> {
  const rows = await admin.query<ConsentEvent>(
    `SELECT event_id,athlete_id,kind,target_id::text,consent_previous_revision,
       consent_previous_granted,consent_revision,consent_granted
     FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='healthkit_consent_transition' ORDER BY consent_revision`,
    [tenant],
  );
  return rows.rows;
}

function batch(): HealthKitIngestionBatch {
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId: randomUUID(),
        sourceBundleId: 'synthetic.test',
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

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 5 });
});

afterAll(async () => {
  await database?.close();
  await runtime.end();
  await admin.end();
});

describe('transaction-local HealthKit consent epoch event', () => {
  it('records grant, withdrawal and re-consent without restoring old raw data', async () => {
    const tenant = randomUUID();
    const consents = createConsentRepository(database);
    const ingestion = createHealthKitIngestionRepository(database);
    const grant = {
      kind: 'healthkit',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    await consents.setConsent(tenant, grant);
    const oldBatch = batch();
    await ingestion.ingestBatch(tenant, oldBatch, 1);
    const withdrawal = {
      kind: 'healthkit',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as const;
    await consents.setConsent(tenant, withdrawal);
    const purged = await database.tenant(tenant, (tx) =>
      tx.query(`SELECT
        (SELECT count(*)::int FROM healthkit_workout_sample) AS raw_count,
        (SELECT count(*)::int FROM healthkit_workout_batch_receipt
          WHERE purged_at IS NOT NULL AND request_digest IS NULL) AS purged_receipts`),
    );
    expect(purged.rows[0]).toEqual({ raw_count: 0, purged_receipts: 1 });
    const regrant = {
      kind: 'healthkit',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    } as const;
    await consents.setConsent(tenant, regrant);

    const recorded = await events(tenant);
    expect(recorded).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'healthkit_consent_transition',
        target_id: null,
        consent_previous_revision: null,
        consent_previous_granted: null,
        consent_revision: 1,
        consent_granted: true,
      },
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'healthkit_consent_transition',
        target_id: null,
        consent_previous_revision: 1,
        consent_previous_granted: true,
        consent_revision: 2,
        consent_granted: false,
      },
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        kind: 'healthkit_consent_transition',
        target_id: null,
        consent_previous_revision: 2,
        consent_previous_granted: false,
        consent_revision: 3,
        consent_granted: true,
      },
    ]);
    expect(await consents.setConsent(tenant, grant)).toMatchObject({ revision: 1 });
    expect(await consents.setConsent(tenant, withdrawal)).toMatchObject({ revision: 2 });
    expect(await consents.setConsent(tenant, regrant)).toMatchObject({ revision: 3 });
    expect(await events(tenant)).toEqual(recorded);
    await expect(
      ingestion.ingestBatch(tenant, { ...oldBatch, batchId: randomUUID() }, 1),
    ).rejects.toMatchObject({ code: 'CONSENT_EPOCH_EXPIRED' });
    await expect(ingestion.ingestBatch(tenant, oldBatch, 3)).rejects.toMatchObject({
      code: 'CONSENT_EPOCH_EXPIRED',
    });
    const freshBatch = batch();
    await expect(ingestion.ingestBatch(tenant, freshBatch, 3)).resolves.toMatchObject({
      acceptedCount: 1,
    });
    const visible = await database.tenant(tenant, (tx) =>
      tx.query('SELECT sample_id FROM healthkit_workout_sample'),
    );
    expect(visible.rows).toEqual([{ sample_id: freshBatch.events[0]?.sampleId }]);
    const payload = await admin.query(
      `SELECT to_jsonb(e) AS value FROM restore_suppression_event e
       WHERE athlete_id=$1 AND kind='healthkit_consent_transition'`,
      [tenant],
    );
    expect(JSON.stringify(payload.rows)).not.toContain('synthetic.test');
    expect(JSON.stringify(payload.rows)).not.toContain(oldBatch.events[0]?.sampleId);
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect(await events(tenant)).toEqual(recorded);
  });

  it('rolls back a consent event with its command and denies another tenant', async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const consents = createConsentRepository(database);
    const request = {
      kind: 'healthkit',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    } as const;
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(createConsentRepository(broken).setConsent(tenant, request)).rejects.toThrow(
      'injected outbox failure',
    );
    expect(await events(tenant)).toEqual([]);
    expect(await consents.getConsent(tenant, 'healthkit')).toMatchObject({ revision: 0 });
    await consents.setConsent(tenant, request);
    const foreign = await database.tenant(other, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='healthkit'",
        [tenant],
      ),
    );
    expect(foreign.rowCount).toBe(0);
    expect(await events(other)).toEqual([]);
    expect(await events(tenant)).toHaveLength(1);
  });

  it('rejects incomplete or impossible consent transition records', async () => {
    const tenant = randomUUID();
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,occurred_at)
       VALUES($1,'healthkit_consent_transition',now())`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,occurred_at,
        consent_previous_revision,consent_previous_granted,consent_revision,consent_granted)
       VALUES($1,'healthkit_consent_transition',now(),1,true,3,false)`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
