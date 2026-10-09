import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitDeregistrationRepository } from '../src/healthkit-deregistration.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { createOperationsRepository } from '../src/operations.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let finalizerDatabase: Database;
const finalizerRole = `hk_test_finalizer_${randomUUID().replaceAll('-', '')}`;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  // Tests for the low-level cleanup gate use a distinct role; the production API stays denied.
  await admin.query(`CREATE ROLE "${finalizerRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${finalizerRole}"`);
  await admin.query(`GRANT SELECT ON tenant_erasure TO "${finalizerRole}"`);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION public.finalize_healthkit_deregistration(uuid) TO "${finalizerRole}"`,
  );
  const finalizerUrl = new URL(runtimeUrl);
  finalizerUrl.username = finalizerRole;
  finalizerUrl.password = '';
  finalizerDatabase = createDatabase({ connectionString: finalizerUrl.toString() });
  database = createDatabase({ connectionString: runtimeUrl });
});
afterAll(async () => {
  await finalizerDatabase?.close();
  await database?.close();
  await admin.end();
});

it('exports only own attribution facts, excludes receipt/fencing internals, and removes withdrawn registration facts', async () => {
  const a = randomUUID(),
    b = randomUUID();
  for (const athlete of [a, b])
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
        [athlete],
      ),
    );
  const registration = createHealthKitRegistrationRepository(database);
  const samples = [randomUUID(), randomUUID()].sort();
  const key = randomUUID();
  const command = {
    schemaVersion: 1 as const,
    sampleIds: samples,
    accountAttributionDeclared: true as const,
    expectedConsentRevision: 1,
    expectedRegistryRevision: 0,
    idempotencyKey: key,
  };
  const result = await registration.registerWorkouts(a, command);
  const foreignSample = randomUUID();
  await registration.registerWorkouts(b, {
    ...command,
    sampleIds: [foreignSample],
    idempotencyKey: randomUUID(),
  });
  const operations = createOperationsRepository(database);
  const artifact = await operations.exportAccount(a);
  if (artifact.schemaVersion !== 33) throw new Error('Expected v33');
  expect(artifact.data.healthKitWorkoutClaims.map((claim) => claim.sample_id)).toEqual(samples);
  expect(artifact.data.healthKitWorkoutClaims.every((claim) => claim.consent_revision === 1)).toBe(
    true,
  );
  expect(artifact.data.healthKitWorkoutClaims.every((claim) => claim.state === 'active')).toBe(
    true,
  );
  expect(artifact.data.healthKitWorkoutDeregistrations).toEqual([]);
  expect(artifact.data.healthKitWorkoutRegistryHeads).toEqual([{ revision: 1 }]);
  expect(artifact.data.healthKitWorkoutRegistrations).toEqual([
    { registry_revision: 1, registered_count: 2 },
  ]);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of [
    b,
    foreignSample,
    key,
    ...result.claims.map((claim) => claim.claimEpoch),
    'request_digest',
    'result_json',
    'claim_epoch',
    'idempotency_key',
  ])
    expect(serialized).not.toContain(forbidden);
  await database.tenant(a, (tx) =>
    tx.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
      [a],
    ),
  );
  const withdrawn = await operations.exportAccount(a);
  if (withdrawn.schemaVersion !== 33) throw new Error('Expected v33');
  expect(withdrawn.data.healthKitWorkoutClaims).toEqual([]);
  expect(withdrawn.data.healthKitWorkoutRegistryHeads).toEqual([]);
  expect(withdrawn.data.healthKitWorkoutRegistrations).toEqual([]);
  const foreign = await operations.exportAccount(b);
  if (foreign.schemaVersion !== 33) throw new Error('Expected v33');
  expect(foreign.data.healthKitWorkoutClaims.map((claim) => claim.sample_id)).toEqual([
    foreignSample,
  ]);
});

it('exports owner-only pending and released cleanup facts without executable ownership fields', async () => {
  const a = randomUUID(),
    b = randomUUID(),
    sample = randomUUID();
  for (const athlete of [a, b])
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
        [athlete],
      ),
    );
  const registered = await createHealthKitRegistrationRepository(database).registerWorkouts(a, {
    schemaVersion: 1,
    sampleIds: [sample],
    accountAttributionDeclared: true,
    expectedConsentRevision: 1,
    expectedRegistryRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const claim = registered.claims[0];
  if (!claim) throw new Error('Missing synthetic registration');
  const key = randomUUID();
  const deregistration = createHealthKitDeregistrationRepository(database);
  const pending = await deregistration.deregisterWorkout(a, {
    schemaVersion: 1,
    sampleId: sample,
    claimEpoch: claim.claimEpoch,
    expectedConsentRevision: 1,
    expectedRegistryRevision: 1,
    confirmRelatedRecordDeletion: true,
    idempotencyKey: key,
  });
  const operations = createOperationsRepository(database);
  const artifact = await operations.exportAccount(a);
  if (artifact.schemaVersion !== 33) throw new Error('Expected v33');
  expect(artifact.data.healthKitWorkoutClaims).toMatchObject([
    { sample_id: sample, state: 'pending_cleanup' },
  ]);
  expect(artifact.data.healthKitWorkoutDeregistrations).toMatchObject([
    {
      operation_id: pending.operationId,
      sample_id: sample,
      state: 'pending_cleanup',
      registry_revision: 2,
      released_at: null,
    },
  ]);
  const foreign = await operations.exportAccount(b);
  if (foreign.schemaVersion !== 33) throw new Error('Expected v33');
  expect(foreign.data.healthKitWorkoutClaims).toEqual([]);
  expect(foreign.data.healthKitWorkoutDeregistrations).toEqual([]);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of [
    key,
    claim.claimEpoch,
    'claim_epoch',
    'idempotency_key',
    'request_digest',
    'object_scopes',
    'result_json',
  ])
    expect(serialized).not.toContain(forbidden);
  // No objects existed for this registered synthetic UUID: the real DB gate can release it.
  const final = await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
    a,
    pending.operationId,
  );
  expect(final.status).toBe('released');
  const released = await operations.exportAccount(a);
  if (released.schemaVersion !== 33) throw new Error('Expected v33');
  expect(released.data.healthKitWorkoutClaims).toEqual([]);
  expect(released.data.healthKitWorkoutDeregistrations).toMatchObject([
    { operation_id: pending.operationId, state: 'released' },
  ]);
  expect(released.data.healthKitWorkoutDeregistrations[0]?.released_at).not.toBeNull();
  await database.tenant(a, (tx) =>
    tx.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
      [a],
    ),
  );
  const withdrawn = await operations.exportAccount(a);
  if (withdrawn.schemaVersion !== 33) throw new Error('Expected v33');
  expect(withdrawn.data.healthKitWorkoutDeregistrations).toEqual([]);
});
