import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { HealthKitRegisteredIngestionBatch } from '@workout/contracts/healthkit-registration';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

it('rolls back a failed withdrawal atomically and retains the v2 fence rather than accepting a legacy rollback client', async () => {
  const athlete = randomUUID(),
    sampleId = randomUUID();
  await database.tenant(athlete, (tx) =>
    tx.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athlete],
    ),
  );
  const registrations = createHealthKitRegistrationRepository(database);
  const request = {
    schemaVersion: 1 as const,
    sampleIds: [sampleId],
    accountAttributionDeclared: true as const,
    expectedConsentRevision: 1,
    expectedRegistryRevision: 0,
    idempotencyKey: randomUUID(),
  };
  const registered = await registrations.registerWorkouts(athlete, request);
  const claim = registered.claims[0];
  if (!claim) throw new Error('Missing synthetic claim');
  const batch: HealthKitRegisteredIngestionBatch = {
    schemaVersion: 2,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId,
        claimEpoch: claim.claimEpoch,
        sourceBundleId: 'synthetic.test',
        sourceVersion: null,
        activityType: 37,
        observedFrom: '2026-10-04T00:00:00Z',
        observedTo: '2026-10-04T00:10:00Z',
        durationSeconds: 600,
        distanceMeters: null,
        energyKilocalories: null,
      },
    ],
  };
  const ingestion = createHealthKitIngestionRepository(database);
  const ack = await ingestion.ingestBatch(athlete, batch, 1);
  await expect(
    database.tenant(athlete, async (tx) => {
      await tx.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [athlete],
      );
      const count = await tx.query('SELECT count(*)::int AS count FROM healthkit_workout_claim');
      expect(count.rows[0]?.['count']).toBe(0);
      throw new Error('SYNTHETIC_DOWNSTREAM_FAILURE');
    }),
  ).rejects.toThrow('SYNTHETIC_DOWNSTREAM_FAILURE');
  expect(await registrations.registerWorkouts(athlete, request)).toEqual(registered);
  expect(await ingestion.ingestBatch(athlete, batch, 1)).toEqual(ack);
  const state = await database.tenant(athlete, (tx) =>
    tx.query(`SELECT
    (SELECT revision FROM consent WHERE kind='healthkit') AS revision,
    (SELECT count(*)::int FROM healthkit_workout_sample) AS samples,
    (SELECT count(*)::int FROM healthkit_workout_registration_receipt) AS receipts,
    (SELECT count(*)::int FROM healthkit_workout_registry_head) AS heads`),
  );
  expect(state.rows[0]).toEqual({ revision: 1, samples: 1, receipts: 1, heads: 1 });
  const { claimEpoch: _epoch, ...legacyEvent } = batch.events[0] ?? {};
  await expect(
    ingestion.ingestBatch(athlete, { ...batch, schemaVersion: 1, events: [legacyEvent] }, 1),
  ).rejects.toMatchObject({ code: 'LEGACY_BATCH_UNSUPPORTED' });
  // This proves transaction rollback and retention of the deployed v2 gate.
  // Replacing this server with a pre-registration binary is not a safe rollback.
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized test latch');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it.each(['commit', 'rollback'] as const)(
  'blocks another account until withdrawal %s finishes',
  async (outcome) => {
    const a = randomUUID(),
      b = randomUUID(),
      sampleId = randomUUID();
    for (const athlete of [a, b])
      await database.tenant(athlete, (tx) =>
        tx.query(
          "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
          [athlete],
        ),
      );
    const registrations = createHealthKitRegistrationRepository(database);
    const command = {
      schemaVersion: 1 as const,
      sampleIds: [sampleId],
      accountAttributionDeclared: true as const,
      expectedConsentRevision: 1,
      expectedRegistryRevision: 0,
      idempotencyKey: randomUUID(),
    };
    const original = await registrations.registerWorkouts(a, command);
    const purged = deferred<number>();
    const finish = deferred<undefined>();
    const withdrawal = database
      .tenant(a, async (tx) => {
        await tx.query(
          "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
          [a],
        );
        const state = await tx.query(`SELECT pg_backend_pid() AS pid,
      (SELECT count(*)::int FROM healthkit_workout_claim) AS claims,
      (SELECT count(*)::int FROM healthkit_workout_registration_receipt) AS receipts,
      (SELECT count(*)::int FROM healthkit_workout_registry_head) AS heads`);
        expect(state.rows[0]).toMatchObject({ claims: 0, receipts: 0, heads: 0 });
        const pid = state.rows[0]?.['pid'];
        if (typeof pid !== 'number') throw new Error('Missing withdrawal PID');
        purged.resolve(pid);
        await finish.promise;
        if (outcome === 'rollback') throw new Error('SYNTHETIC_WITHDRAWAL_ROLLBACK');
      })
      .then(
        () => ({ committed: true }),
        (error) => ({ committed: false, error }),
      );
    const holder = await purged.promise;
    const registration = registrations
      .registerWorkouts(b, { ...command, idempotencyKey: randomUUID() })
      .then(
        (result) => ({ accepted: true as const, result }),
        (error) => ({ accepted: false as const, error }),
      );
    try {
      // Observe PostgreSQL's actual wait graph, not a delay interpreted as blocking.
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline) {
        const wait = await admin.query(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
          AND query LIKE 'INSERT INTO healthkit_workout_claim%') AS blocked`,
          [holder],
        );
        if (wait.rows[0]?.['blocked'] === true) {
          blocked = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(blocked).toBe(true);
    } finally {
      finish.resolve(undefined);
    }
    const completed = await withdrawal;
    const registered = await registration;
    expect(completed.committed).toBe(outcome === 'commit');
    if (outcome === 'commit') {
      expect(registered.accepted).toBe(true);
      if (!registered.accepted) throw new Error('Expected new explicit registration');
      expect(registered.result.claims[0]?.claimEpoch).not.toBe(original.claims[0]?.claimEpoch);
    } else {
      expect(registered).toMatchObject({ accepted: false, error: { code: 'CLAIM_CONFLICT' } });
      expect(await registrations.registerWorkouts(a, command)).toEqual(original);
    }
  },
);

it('rejects a legacy receipt fixture and runtime historical relabeling while current v2 writes work', async () => {
  const athlete = randomUUID();
  await database.tenant(athlete, (tx) =>
    tx.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athlete],
    ),
  );
  const legacySql = `INSERT INTO healthkit_workout_batch_receipt
    (athlete_id,installation_id,batch_id,request_digest,accepted_count)
    VALUES($1,$2,$3,$4,1)`;
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query(legacySql, [athlete, randomUUID(), randomUUID(), 'c'.repeat(64)]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query(
        `INSERT INTO healthkit_workout_batch_receipt
    (athlete_id,installation_id,batch_id,request_digest,accepted_count,pre_registration_historical)
    VALUES($1,$2,$3,$4,1,true)`,
        [athlete, randomUUID(), randomUUID(), 'c'.repeat(64)],
      ),
    ),
  ).rejects.toThrow('HEALTHKIT_HISTORICAL_RECEIPT_OWNER_REQUIRED');
  const state = await database.tenant(athlete, (tx) =>
    tx.query('SELECT count(*)::int AS receipts FROM healthkit_workout_batch_receipt'),
  );
  expect(state.rows[0]).toEqual({ receipts: 0 });
});
