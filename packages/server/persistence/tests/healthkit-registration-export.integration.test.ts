import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { createOperationsRepository } from '../src/operations.js';
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
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl });
});
afterAll(async () => {
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
  if (artifact.schemaVersion !== 29) throw new Error('Expected v29');
  expect(artifact.data.healthKitWorkoutClaims.map((claim) => claim.sample_id)).toEqual(samples);
  expect(artifact.data.healthKitWorkoutClaims.every((claim) => claim.consent_revision === 1)).toBe(
    true,
  );
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
  if (withdrawn.schemaVersion !== 29) throw new Error('Expected v29');
  expect(withdrawn.data.healthKitWorkoutClaims).toEqual([]);
  expect(withdrawn.data.healthKitWorkoutRegistryHeads).toEqual([]);
  expect(withdrawn.data.healthKitWorkoutRegistrations).toEqual([]);
  const foreign = await operations.exportAccount(b);
  if (foreign.schemaVersion !== 29) throw new Error('Expected v29');
  expect(foreign.data.healthKitWorkoutClaims.map((claim) => claim.sample_id)).toEqual([
    foreignSample,
  ]);
});
