import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthKitRegisteredIngestionBatch } from '@workout/contracts/healthkit-registration';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
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
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function consent(athleteId: string) {
  await database.tenant(athleteId, (tx) =>
    tx.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    ),
  );
}

function register(sampleIds: string[], expectedRegistryRevision = 0) {
  return {
    schemaVersion: 1 as const,
    sampleIds,
    accountAttributionDeclared: true as const,
    expectedConsentRevision: 1,
    expectedRegistryRevision,
    idempotencyKey: randomUUID(),
  };
}

function batch(sampleId: string, claimEpoch: string): HealthKitRegisteredIngestionBatch {
  return {
    schemaVersion: 2,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: [
      {
        kind: 'upsert',
        sampleId,
        claimEpoch,
        sourceBundleId: 'com.example.synthetic',
        sourceVersion: null,
        activityType: 37,
        observedFrom: '2026-09-20T06:00:00+09:00',
        observedTo: '2026-09-20T06:35:00+09:00',
        durationSeconds: 2100,
        distanceMeters: null,
        energyKilocalories: 0,
      },
    ],
  };
}

async function counts(athleteId: string) {
  const result = await database.tenant(athleteId, (tx) =>
    tx.query(`SELECT
      (SELECT count(*)::int FROM healthkit_workout_claim) AS claims,
      (SELECT count(*)::int FROM healthkit_workout_registration_receipt) AS registrations,
      (SELECT count(*)::int FROM healthkit_workout_sample) AS raw,
      (SELECT count(*)::int FROM healthkit_workout_batch_receipt) AS batches`),
  );
  return result.rows[0];
}

describe('M3-02k HealthKit active UUID ownership', () => {
  it('allows one owner in a concurrent A/B registration race and hides its claim under RLS', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const sampleId = randomUUID();
    await Promise.all([consent(a), consent(b)]);
    const repository = createHealthKitRegistrationRepository(database);
    const results = await Promise.allSettled([
      repository.registerWorkouts(a, register([sampleId])),
      repository.registerWorkouts(b, register([sampleId])),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'CLAIM_CONFLICT' } });
    expect(Number((await counts(a))?.['claims']) + Number((await counts(b))?.['claims'])).toBe(1);
    const winner = results[0]?.status === 'fulfilled' ? a : b;
    const loser = winner === a ? b : a;
    expect(await repository.listWorkouts(loser, {})).toMatchObject({ claims: [] });
    expect(await counts(loser)).toMatchObject({ claims: 0, registrations: 0 });
  });

  it('rejects v1 and unregistered v2 before receipt/raw, then ACKs one claimed v2 batch exactly', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const sampleId = randomUUID();
    await Promise.all([consent(a), consent(b)]);
    const registrations = createHealthKitRegistrationRepository(database);
    const ingestion = createHealthKitIngestionRepository(database);
    const unclaimed = batch(sampleId, randomUUID());
    await expect(
      ingestion.ingestBatch(a, { ...unclaimed, schemaVersion: 1 }, 1),
    ).rejects.toMatchObject({
      code: 'LEGACY_BATCH_UNSUPPORTED',
    });
    await expect(ingestion.ingestBatch(a, unclaimed, 1)).rejects.toMatchObject({
      code: 'REGISTRATION_REQUIRED',
    });
    expect(await counts(a)).toMatchObject({ raw: 0, batches: 0 });
    const claim = (await registrations.registerWorkouts(a, register([sampleId]))).claims[0];
    if (!claim) throw new Error('missing synthetic claim');
    const owned = batch(sampleId, claim.claimEpoch);
    await expect(ingestion.ingestBatch(b, owned, 1)).rejects.toMatchObject({
      code: 'REGISTRATION_REQUIRED',
    });
    const first = await ingestion.ingestBatch(a, owned, 1);
    expect(first).toMatchObject({ schemaVersion: 2, acceptedCount: 1 });
    expect(await ingestion.ingestBatch(a, owned, 1)).toEqual(first);
    await expect(
      ingestion.ingestBatch(
        a,
        { ...owned, events: [{ ...owned.events[0], claimEpoch: randomUUID() }] },
        1,
      ),
    ).rejects.toMatchObject({ code: 'CLAIM_EPOCH_EXPIRED' });
    expect(await counts(a)).toMatchObject({ claims: 1, raw: 1, batches: 1 });
    expect(await counts(b)).toMatchObject({ claims: 0, raw: 0, batches: 0 });
  });

  it('returns exact registration result, rejects altered reuse, and invalidates stale list cursors', async () => {
    const athlete = randomUUID();
    const otherAthlete = randomUUID();
    await Promise.all([consent(athlete), consent(otherAthlete)]);
    const repository = createHealthKitRegistrationRepository(database);
    const sampleIds = [randomUUID(), randomUUID()].sort();
    const request = register(sampleIds);
    const first = await repository.registerWorkouts(athlete, request);
    expect(await repository.registerWorkouts(athlete, request)).toEqual(first);
    await expect(
      repository.registerWorkouts(athlete, { ...request, sampleIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // A different command for an active claim conflicts; callers list the
    // existing epoch rather than implicitly renewing registration.
    await expect(
      repository.registerWorkouts(athlete, register([sampleIds[0] ?? ''], 1)),
    ).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
    const page = await repository.listWorkouts(athlete, { limit: '1' });
    expect(page.claims).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await repository.listWorkouts(athlete, {
      limit: '1',
      cursor: page.nextCursor ?? '',
    });
    expect(next.claims).toHaveLength(1);
    expect(next.claims[0]?.sampleId).not.toBe(page.claims[0]?.sampleId);
    await repository.registerWorkouts(otherAthlete, register([randomUUID(), randomUUID()]));
    await expect(
      repository.listWorkouts(otherAthlete, { limit: '1', cursor: page.nextCursor ?? '' }),
    ).rejects.toMatchObject({ code: 'REGISTRY_REVISION_CONFLICT' });
    await repository.registerWorkouts(athlete, register([randomUUID()], 1));
    await expect(
      repository.listWorkouts(athlete, { limit: '1', cursor: page.nextCursor ?? '' }),
    ).rejects.toMatchObject({ code: 'REGISTRY_REVISION_CONFLICT' });
  });

  it('purges claims atomically on account erasure and permits a new explicit B claim', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const sampleId = randomUUID();
    await Promise.all([consent(a), consent(b)]);
    const repository = createHealthKitRegistrationRepository(database);
    const first = await repository.registerWorkouts(a, register([sampleId]));
    expect(first.claims).toHaveLength(1);
    await database.exclusiveTenant(a, (tx) => tx.query('SELECT public.erase_account($1)', [a]));
    const erased = await admin.connect();
    try {
      await erased.query('BEGIN');
      await erased.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      const result = await erased.query(
        `SELECT
        (SELECT count(*)::int FROM healthkit_workout_claim WHERE athlete_id=$1) AS claims,
        (SELECT count(*)::int FROM healthkit_workout_registration_receipt WHERE athlete_id=$1) AS registrations,
        (SELECT count(*)::int FROM healthkit_workout_registry_head WHERE athlete_id=$1) AS heads`,
        [a],
      );
      expect(result.rows[0]).toEqual({ claims: 0, registrations: 0, heads: 0 });
    } finally {
      await erased.query('ROLLBACK');
      erased.release();
    }
    const second = await repository.registerWorkouts(b, register([sampleId]));
    expect(second.claims[0]?.sampleId).toBe(sampleId);
    expect(second.claims[0]?.claimEpoch).not.toBe(first.claims[0]?.claimEpoch);
  });

  it('rolls back a consent withdrawal with its claim purge, then permits B only after commit', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const sampleId = randomUUID();
    await Promise.all([consent(a), consent(b)]);
    const registration = createHealthKitRegistrationRepository(database);
    const ingestion = createHealthKitIngestionRepository(database);
    const first = await registration.registerWorkouts(a, register([sampleId]));
    const bExisting = await registration.registerWorkouts(b, register([randomUUID()]));
    const claimEpoch = first.claims[0]?.claimEpoch;
    if (!claimEpoch) throw new Error('missing synthetic claim epoch');
    const oldBatch = batch(sampleId, claimEpoch);
    await ingestion.ingestBatch(a, oldBatch, 1);

    await expect(
      database.tenant(a, async (tx) => {
        await tx.query(
          "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
          [a],
        );
        throw new Error('ROLLBACK_SYNTHETIC_WITHDRAWAL');
      }),
    ).rejects.toThrow('ROLLBACK_SYNTHETIC_WITHDRAWAL');
    expect(await counts(a)).toMatchObject({ claims: 1, registrations: 1, raw: 1 });
    await expect(registration.registerWorkouts(b, register([sampleId], 1))).rejects.toMatchObject({
      code: 'CLAIM_CONFLICT',
    });

    await database.tenant(a, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [a],
      ),
    );
    expect(await counts(a)).toMatchObject({ claims: 0, registrations: 0, raw: 0 });
    const head = await admin.query(
      'SELECT count(*)::int AS count FROM healthkit_workout_registry_head WHERE athlete_id=$1',
      [a],
    );
    expect(head.rows[0]?.['count']).toBe(0);
    const second = await registration.registerWorkouts(b, register([sampleId], 1));
    const secondEpoch = second.claims[0]?.claimEpoch;
    expect(secondEpoch).toBeTruthy();
    expect(secondEpoch).not.toBe(claimEpoch);
    await database.tenant(a, (tx) =>
      tx.query(
        "UPDATE consent SET granted=true,revision=3 WHERE athlete_id=$1 AND kind='healthkit'",
        [a],
      ),
    );
    await expect(
      ingestion.ingestBatch(a, { ...oldBatch, batchId: randomUUID() }, 3),
    ).rejects.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    const bClaims = (await registration.listWorkouts(b, {})).claims;
    expect(bClaims).toEqual(expect.arrayContaining([...bExisting.claims, ...second.claims]));
    expect(bClaims).toHaveLength(2);
    expect(await counts(b)).toMatchObject({ claims: 2, registrations: 2, raw: 0 });
  });

  it('only accepts a deletion UUID already claimed by the same account', async () => {
    const athlete = randomUUID();
    await consent(athlete);
    const registrations = createHealthKitRegistrationRepository(database);
    const ingestion = createHealthKitIngestionRepository(database);
    const sampleId = randomUUID();
    const claim = (await registrations.registerWorkouts(athlete, register([sampleId]))).claims[0];
    if (!claim) throw new Error('missing synthetic claim');
    const deletion = batch(sampleId, claim.claimEpoch);
    deletion.events = [{ kind: 'delete', sampleId, claimEpoch: claim.claimEpoch }];
    await ingestion.ingestBatch(athlete, deletion, 1);
    await ingestion.ingestBatch(athlete, batch(sampleId, claim.claimEpoch), 1);
    const state = await database.tenant(athlete, (tx) =>
      tx.query('SELECT state,payload_digest FROM healthkit_workout_sample WHERE sample_id=$1', [
        sampleId,
      ]),
    );
    expect(state.rows[0]).toEqual({ state: 'deleted', payload_digest: null });
    await expect(
      ingestion.ingestBatch(
        athlete,
        {
          ...deletion,
          batchId: randomUUID(),
          events: [{ kind: 'delete', sampleId: randomUUID(), claimEpoch: claim.claimEpoch }],
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  });
});
