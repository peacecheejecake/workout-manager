import { createConsentRepository } from '../src/repositories.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHealthKitActivityRepository } from '../src/healthkit-activity.js';
import { createHealthKitBindingRepository } from '../src/healthkit-binding.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthKitRegisteredIngestionBatch } from '@workout/contracts/healthkit-registration';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitDeregistrationRepository } from '../src/healthkit-deregistration.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { grantHealthKitIngestion, grantOperations, migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'];
if (!adminUrl || !runtimeUrl || !ownerUrl)
  throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
// Protected maintenance uses the actual plain schema owner; admin remains inspector.
const maintenanceOwner = new Pool({ connectionString: ownerUrl });
let database: Database;
let finalizerDatabase: Database;
const finalizerRole = `hk_test_finalizer_${randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  await migrate(adminUrl);
  const ownerIdentity = await maintenanceOwner.query(`SELECT
    current_user=pg_get_userbyid(relowner) AS owner_matches,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unsafe
    FROM pg_class WHERE oid='public.restore_generation'::regclass`);
  expect(ownerIdentity.rows).toEqual([{ owner_matches: true, unsafe: false }]);
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
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await finalizerDatabase?.close();
  await database?.close();
  await maintenanceOwner.end();
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

function release(sampleId: string, claimEpoch: string, expectedRegistryRevision = 1) {
  return {
    schemaVersion: 1 as const,
    sampleId,
    claimEpoch,
    expectedConsentRevision: 1,
    expectedRegistryRevision,
    confirmRelatedRecordDeletion: true as const,
    idempotencyKey: randomUUID(),
  };
}
describe('M3-02l product HealthKit deregistration', () => {
  it('keeps an unknown historical v1 receipt fail closed and rolls back every deregistration write', async () => {
    const athlete = randomUUID(),
      sample = randomUUID();
    await declareSyntheticAppConsent(athlete);
    await consent(athlete);
    const registration = createHealthKitRegistrationRepository(database);
    const ingestion = createHealthKitIngestionRepository(database);
    const deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(athlete, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('Missing synthetic epoch');
    await ingestion.ingestBatch(athlete, batch(sample, epoch), 1);
    const legacy = {
      schemaVersion: 1,
      installationId: randomUUID(),
      batchId: randomUUID(),
      events: [{ kind: 'delete', sampleId: sample }],
    };
    function canonical(value: unknown): string {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      if (value !== null && typeof value === 'object')
        return (
          '{' +
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
            .join(',') +
          '}'
        );
      return JSON.stringify(value);
    }
    const client = await maintenanceOwner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query(
        `INSERT INTO healthkit_workout_batch_receipt(
        athlete_id,installation_id,batch_id,request_digest,accepted_count,
        protocol_version,pre_registration_historical)
        VALUES($1,$2,$3,$4,1,1,true)`,
        [
          athlete,
          legacy.installationId,
          legacy.batchId,
          createHash('sha256').update(canonical(legacy)).digest('hex'),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const facts = async () => {
      const result = await database.tenant(athlete, (tx) =>
        tx.query(
          `SELECT
        (SELECT count(*)::integer FROM healthkit_workout_sample) raw,
        (SELECT count(*)::integer FROM healthkit_workout_claim) claims,
        (SELECT count(*)::integer FROM healthkit_workout_deregistration) operations,
        (SELECT count(*)::integer FROM healthkit_workout_batch_receipt) batches,
        (SELECT count(*)::integer FROM outbox) outbox,
        (SELECT revision FROM healthkit_workout_registry_head) registry_revision,
        (SELECT sample_ids FROM healthkit_workout_batch_receipt WHERE batch_id=$1) historical_membership
      `,
          [legacy.batchId],
        ),
      );
      // The immutable suppression ledger is owner-only, so inspect its bounded count separately.
      const audit = await admin.query(
        'SELECT count(*)::integer AS suppression FROM restore_suppression_event WHERE athlete_id=$1',
        [athlete],
      );
      return { ...result.rows[0], suppression: audit.rows[0]?.['suppression'] };
    };
    const before = await facts();
    expect(before).toMatchObject({
      raw: 1,
      claims: 1,
      operations: 0,
      batches: 2,
      registry_revision: 1,
      historical_membership: null,
    });
    await expect(deletion.deregisterWorkout(athlete, release(sample, epoch))).rejects.toMatchObject(
      { code: 'RECEIPT_MEMBERSHIP_REQUIRED' },
    );
    expect(await facts()).toEqual(before);
    await expect(ingestion.ingestBatch(athlete, legacy, 1)).rejects.toMatchObject({
      code: 'LEGACY_BATCH_UNSUPPORTED',
    });
    expect(await facts()).toEqual(before);
    await expect(
      ingestion.ingestBatch(
        athlete,
        {
          ...legacy,
          schemaVersion: 2,
          events: [{ kind: 'delete', sampleId: sample, claimEpoch: epoch }],
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await facts()).toEqual(before);
    await expect(deletion.deregisterWorkout(athlete, release(sample, epoch))).rejects.toMatchObject(
      { code: 'RECEIPT_MEMBERSHIP_REQUIRED' },
    );
    expect(await facts()).toEqual(before);
  });

  it('retains the global UUID during cleanup, blocks ingestion and permits B only after final commit', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      sample = randomUUID();
    await declareSyntheticAppConsent(a);
    await Promise.all([consent(a), consent(b)]);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    await ingestion.ingestBatch(a, batch(sample, epoch), 1);
    const command = release(sample, epoch);
    const pending = await deletion.deregisterWorkout(a, command);
    expect(pending).toMatchObject({ status: 'pending_cleanup', registryRevision: 2 });
    expect(await deletion.deregisterWorkout(a, command)).toEqual(pending);
    expect(await counts(a)).toMatchObject({ claims: 1, raw: 0, registrations: 0 });
    expect((await registration.listWorkouts(a, {})).claims).toEqual([]);
    await expect(ingestion.ingestBatch(a, batch(sample, epoch), 1)).rejects.toMatchObject({
      code: 'DEREGISTRATION_PENDING',
    });
    await expect(registration.registerWorkouts(b, register([sample]))).rejects.toMatchObject({
      code: 'CLAIM_CONFLICT',
    });
    await expect(deletion.getStatus(b, pending.operationId)).rejects.toMatchObject({
      code: 'DEREGISTRATION_NOT_FOUND',
    });
    await expect(
      deletion.deregisterWorkout(a, { ...command, claimEpoch: randomUUID() }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const released = await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
      a,
      pending.operationId,
    );
    expect(released).toMatchObject({ status: 'released', registryRevision: 3 });
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toEqual(released);
    const next = (await registration.registerWorkouts(b, register([sample]))).claims[0];
    expect(next?.claimEpoch).not.toBe(epoch);
    await expect(ingestion.ingestBatch(a, batch(sample, epoch), 1)).rejects.toMatchObject({
      code: 'REGISTRATION_REQUIRED',
    });
  });
  it('rolls back raw, claim status, suppression and outbox together if the command fails', async () => {
    const a = randomUUID(),
      sample = randomUUID();
    await consent(a);
    const registration = createHealthKitRegistrationRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    const injected = {
      ...database,
      tenant: async <T>(
        athleteId: string,
        operation: Parameters<Database['tenant']>[1],
      ): Promise<T> =>
        database.tenant(athleteId, async (tx) => {
          await operation(tx);
          throw new Error('INJECTED_ROLLBACK');
        }),
    };
    await expect(
      createHealthKitDeregistrationRepository(injected).deregisterWorkout(
        a,
        release(sample, epoch),
      ),
    ).rejects.toThrow('INJECTED_ROLLBACK');
    expect((await registration.listWorkouts(a, {})).claims).toHaveLength(1);
    const facts = await database.tenant(a, (tx) =>
      tx.query(`SELECT (SELECT count(*)::int FROM healthkit_workout_deregistration) operations,
   (SELECT count(*)::int FROM outbox WHERE topic LIKE 'healthkit.workout.dereg%') events`),
    );
    expect(facts.rows[0]).toEqual({ operations: 0, events: 0 });
    expect(await deletion.deregisterWorkout(a, release(sample, epoch))).toMatchObject({
      status: 'pending_cleanup',
    });
  });
  it('requires completed prefix cleanup database facts for a HealthKit-owned Activity', async () => {
    const a = randomUUID(),
      sample = randomUUID();
    await declareSyntheticAppConsent(a);
    await consent(a);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    await ingestion.ingestBatch(a, batch(sample, epoch), 1);
    const activity = await database.tenant(a, (tx) =>
      tx.query(
        'SELECT public.create_healthkit_canonical($1,(SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1)) AS id',
        [sample],
      ),
    );
    const id = activity.rows[0]?.['id'];
    expect(id).toBeTruthy();
    const pending = await deletion.deregisterWorkout(a, release(sample, epoch));
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toMatchObject({
      status: 'pending_cleanup',
    });
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      await client.query(
        "UPDATE object_scope_purge SET completed_at=clock_timestamp(),passes=1 WHERE athlete_id=$1 AND scope_kind='activity' AND scope_id=$2",
        [a, id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toMatchObject({ status: 'released' });
  });
  it('purges pending operation on withdrawal and never lets its old finalizer remove B registration', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      sample = randomUUID();
    await Promise.all([consent(a), consent(b)]);
    const registration = createHealthKitRegistrationRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    const pending = await deletion.deregisterWorkout(a, release(sample, epoch));
    await database.tenant(a, (tx) =>
      tx.query(
        "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
        [a],
      ),
    );
    const next = await registration.registerWorkouts(b, register([sample]));
    const nextEpoch = next.claims[0]?.claimEpoch;
    if (!nextEpoch) throw new Error('next epoch');
    await declareSyntheticAppConsent(b);
    await createHealthKitIngestionRepository(database).ingestBatch(b, batch(sample, nextEpoch), 1);
    await expect(
      createHealthKitDeregistrationRepository(finalizerDatabase).finalize(a, pending.operationId),
    ).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect((await registration.listWorkouts(b, {})).claims).toEqual(next.claims);
    expect(await counts(b)).toMatchObject({ claims: 1, raw: 1, batches: 1 });
  });
  it('removes a linked HealthKit supplement while preserving its independent manual canonical', async () => {
    const a = randomUUID(),
      sample = randomUUID(),
      activity = randomUUID();
    await declareSyntheticAppConsent(a);
    await consent(a);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    await ingestion.ingestBatch(a, batch(sample, epoch), 1);
    const original = {
      title: 'synthetic independent manual',
      kind: 'running',
      startedAt: '2026-09-20T00:00:00Z',
      durationSeconds: 120,
      durationKind: 'elapsed',
      timezone: 'Asia/Seoul',
      distanceMeters: 100,
    };
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      await client.query(
        'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3)',
        [a, activity, original],
      );
      await client.query(
        "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'manual',$2,1,$3,$4)",
        [a, randomUUID(), 'a'.repeat(64), activity],
      );
      await client.query(
        `INSERT INTO healthkit_existing_binding(athlete_id,sample_id,activity_id,sample_digest,target_revision)
        SELECT $1,$2,$3,payload_digest,1 FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2`,
        [a, sample, activity],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const pending = await deletion.deregisterWorkout(a, release(sample, epoch));
    const rows = await database.tenant(a, (tx) =>
      tx.query('SELECT revision,deleted,original FROM activity_canonical WHERE id=$1', [activity]),
    );
    expect(rows.rows[0]).toEqual({ revision: 1, deleted: false, original });
    expect(await counts(a)).toMatchObject({ raw: 0, claims: 1 });
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toMatchObject({ status: 'released' });
  });
  it('serializes in-flight ingestion with deregistration and fences direct legacy v2 raw writes', async () => {
    const a = randomUUID(),
      sample = randomUUID();
    await declareSyntheticAppConsent(a);
    await consent(a);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    const results = await Promise.allSettled([
      ingestion.ingestBatch(a, batch(sample, epoch), 1),
      deletion.deregisterWorkout(a, release(sample, epoch)),
    ]);
    expect(results[1]?.status).toBe('fulfilled');
    if (results[0]?.status === 'rejected')
      expect(results[0].reason).toMatchObject({ code: 'DEREGISTRATION_PENDING' });
    expect(await counts(a)).toMatchObject({ raw: 0, claims: 1 });
    await expect(
      database.tenant(a, (tx) =>
        tx.query(
          `INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,deleted_at)
      VALUES($1,$2,$3,'deleted',clock_timestamp())`,
          [a, sample, randomUUID()],
        ),
      ),
    ).rejects.toThrow('DEREGISTRATION_PENDING');
    expect(await counts(a)).toMatchObject({ raw: 0, claims: 1 });
  });
  it('waits conservatively for own historical course purges after lineage removal and ignores B queues', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      sample = randomUUID(),
      ownCourse = randomUUID(),
      foreignCourse = randomUUID();
    await declareSyntheticAppConsent(a);
    await consent(a);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(a, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    await ingestion.ingestBatch(a, batch(sample, epoch), 1);
    const created = await database.tenant(a, (tx) =>
      tx.query(
        'SELECT public.create_healthkit_canonical($1,(SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1)) AS id',
        [sample],
      ),
    );
    const activity = created.rows[0]?.['id'];
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [a]);
      await client.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [a, activity],
      );
      await client.query(
        "INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at) VALUES($1,'course',$2,clock_timestamp(),clock_timestamp()),($3,'course',$4,clock_timestamp(),clock_timestamp())",
        [a, ownCourse, b, foreignCourse],
      );
      await client.query(
        "UPDATE object_scope_purge SET completed_at=clock_timestamp(),passes=1 WHERE athlete_id=$1 AND scope_kind='activity' AND scope_id=$2",
        [a, activity],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const pending = await deletion.deregisterWorkout(a, release(sample, epoch));
    const scopes = await database.tenant(a, (tx) =>
      tx.query('SELECT object_scopes FROM healthkit_workout_deregistration WHERE operation_id=$1', [
        pending.operationId,
      ]),
    );
    expect(scopes.rows[0]?.['object_scopes']).toEqual(
      expect.arrayContaining([
        { kind: 'activity', id: activity },
        { kind: 'course', id: ownCourse },
      ]),
    );
    expect(scopes.rows[0]?.['object_scopes']).not.toEqual(
      expect.arrayContaining([{ kind: 'course', id: foreignCourse }]),
    );
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toMatchObject({
      status: 'pending_cleanup',
    });
    await admin.query(
      "UPDATE object_scope_purge SET completed_at=clock_timestamp(),passes=1 WHERE athlete_id=$1 AND scope_kind='course' AND scope_id=$2",
      [a, ownCourse],
    );
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        a,
        pending.operationId,
      ),
    ).toMatchObject({ status: 'released' });
    const foreign = await admin.query(
      "SELECT completed_at FROM object_scope_purge WHERE athlete_id=$1 AND scope_kind='course' AND scope_id=$2",
      [b, foreignCourse],
    );
    expect(foreign.rows[0]?.['completed_at']).toBeNull();
  });
  it('redacts only sample-related receipts and preserves unrelated ACK/create/bind retries and actuals', async () => {
    const athlete = randomUUID(),
      target = randomUUID(),
      other = randomUUID(),
      bound = randomUUID(),
      manual = randomUUID();
    await declareSyntheticAppConsent(athlete);
    await consent(athlete);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const registrationResult = await registration.registerWorkouts(
      athlete,
      register([target, other, bound]),
    );
    const epochs = new Map(
      registrationResult.claims.map((claim) => [claim.sampleId, claim.claimEpoch]),
    );
    const targetEpoch = epochs.get(target),
      otherEpoch = epochs.get(other),
      boundEpoch = epochs.get(bound);
    if (!targetEpoch || !otherEpoch || !boundEpoch) throw new Error('epochs');
    const targetBatch = batch(target, targetEpoch),
      otherBatch = batch(other, otherEpoch),
      boundBatch = batch(bound, boundEpoch);
    const [targetAck, otherAck, boundAck] = await Promise.all([
      ingestion.ingestBatch(athlete, targetBatch, 1),
      ingestion.ingestBatch(athlete, otherBatch, 1),
      ingestion.ingestBatch(athlete, boundBatch, 1),
    ]);
    const mixed = {
      ...batch(target, targetEpoch),
      events: [...targetBatch.events, ...otherBatch.events],
    };
    await ingestion.ingestBatch(athlete, mixed, 1);
    const digests = await database.tenant(athlete, (tx) =>
      tx.query('SELECT sample_id,payload_digest FROM healthkit_workout_sample ORDER BY sample_id'),
    );
    const digestById = new Map(
      digests.rows.map((row) => [row['sample_id'], row['payload_digest']]),
    );
    const create = {
      sampleId: other,
      expectedSampleDigest: String(digestById.get(other)),
      confirmed: true as const,
      idempotencyKey: randomUUID(),
    };
    const created = await createHealthKitActivityRepository(database).createActivity(
      athlete,
      create,
    );
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query(
        'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3)',
        [
          athlete,
          manual,
          {
            title: 'synthetic manual',
            kind: 'running',
            startedAt: '2026-09-20T00:00:00Z',
            durationSeconds: 120,
            durationKind: 'elapsed',
            timezone: 'Asia/Seoul',
            distanceMeters: 100,
          },
        ],
      );
      await client.query(
        "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'manual',$2,1,$3,$4)",
        [athlete, randomUUID(), 'a'.repeat(64), manual],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const bind = {
      sampleId: bound,
      targetActivityId: manual,
      expectedActivityRevision: 1,
      expectedSampleDigest: String(digestById.get(bound)),
      confirmed: true as const,
      idempotencyKey: randomUUID(),
    };
    const binding = await createHealthKitBindingRepository(database).bindExisting(athlete, bind);
    const targetBind = {
      ...bind,
      sampleId: target,
      expectedSampleDigest: String(digestById.get(target)),
      idempotencyKey: randomUUID(),
    };
    await createHealthKitBindingRepository(database).bindExisting(athlete, targetBind);
    const before = await database.tenant(athlete, (tx) =>
      tx.query('SELECT id,revision,deleted,original FROM activity_canonical ORDER BY id'),
    );
    const pending = await deletion.deregisterWorkout(athlete, release(target, targetEpoch));
    expect(await ingestion.ingestBatch(athlete, otherBatch, 1)).toEqual(otherAck);
    expect(await ingestion.ingestBatch(athlete, boundBatch, 1)).toEqual(boundAck);
    expect(
      await createHealthKitActivityRepository(database).createActivity(athlete, create),
    ).toEqual(created);
    expect(await createHealthKitBindingRepository(database).bindExisting(athlete, bind)).toEqual(
      binding,
    );
    const redacted = await database.tenant(athlete, (tx) =>
      tx.query('SELECT request,result FROM command_receipt WHERE idempotency_key=$1', [
        `healthkit-bind-existing:${targetBind.idempotencyKey}`,
      ]),
    );
    expect(redacted.rows[0]).toEqual({ request: { purged: true }, result: { purged: true } });
    await expect(
      createHealthKitBindingRepository(database).bindExisting(athlete, targetBind),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const after = await database.tenant(athlete, (tx) =>
      tx.query('SELECT id,revision,deleted,original FROM activity_canonical ORDER BY id'),
    );
    expect(after.rows).toEqual(before.rows);
    expect(await counts(athlete)).toMatchObject({ raw: 2, claims: 3 });
    const receipts = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT batch_id,request_digest,purged_at,sample_ids FROM healthkit_workout_batch_receipt ORDER BY batch_id',
      ),
    );
    for (const id of [targetBatch.batchId, mixed.batchId])
      expect(receipts.rows.find((row) => row['batch_id'] === id)).toMatchObject({
        request_digest: null,
        sample_ids: null,
        purged_at: expect.any(Date),
      });
    for (const id of [otherBatch.batchId, boundBatch.batchId])
      expect(receipts.rows.find((row) => row['batch_id'] === id)).toMatchObject({
        purged_at: null,
        request_digest: expect.any(String),
      });
    await expect(ingestion.ingestBatch(athlete, mixed, 1)).rejects.toMatchObject({
      code: 'DEREGISTRATION_PENDING',
    });
    expect(
      await createHealthKitDeregistrationRepository(finalizerDatabase).finalize(
        athlete,
        pending.operationId,
      ),
    ).toMatchObject({
      status: 'released',
    });
    await expect(ingestion.ingestBatch(athlete, mixed, 1)).rejects.toMatchObject({
      code: 'REGISTRATION_REQUIRED',
    });
    expect(targetAck.acceptedCount).toBe(1);
    expect(await counts(athlete)).toMatchObject({ raw: 2, claims: 2 });
  });
  it('blocks unknown receipt membership until an exact original v2 retry proves its UUID set', async () => {
    const athlete = randomUUID(),
      sample = randomUUID();
    await declareSyntheticAppConsent(athlete);
    await consent(athlete);
    const registration = createHealthKitRegistrationRepository(database),
      ingestion = createHealthKitIngestionRepository(database),
      deletion = createHealthKitDeregistrationRepository(database);
    const epoch = (await registration.registerWorkouts(athlete, register([sample]))).claims[0]
      ?.claimEpoch;
    if (!epoch) throw new Error('epoch');
    await ingestion.ingestBatch(athlete, batch(sample, epoch), 1);
    const historical = batch(sample, epoch);
    function canonical(value: unknown): string {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      if (value !== null && typeof value === 'object')
        return (
          '{' +
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
            .join(',') +
          '}'
        );
      return JSON.stringify(value);
    }
    const digest = createHash('sha256').update(canonical(historical)).digest('hex');
    const client = await maintenanceOwner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      // Models an authentic pre-096 v2 receipt; no membership is inferred from raw rows.
      await client.query(
        `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,request_digest,accepted_count,protocol_version,pre_registration_historical)
        VALUES($1,$2,$3,$4,1,2,true)`,
        [athlete, historical.installationId, historical.batchId, digest],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await expect(deletion.deregisterWorkout(athlete, release(sample, epoch))).rejects.toMatchObject(
      { code: 'RECEIPT_MEMBERSHIP_REQUIRED' },
    );
    expect(await counts(athlete)).toMatchObject({ raw: 1, claims: 1 });
    expect(await ingestion.ingestBatch(athlete, historical, 1)).toMatchObject({
      schemaVersion: 2,
      acceptedCount: 1,
    });
    const proven = await database.tenant(athlete, (tx) =>
      tx.query('SELECT sample_ids FROM healthkit_workout_batch_receipt WHERE batch_id=$1', [
        historical.batchId,
      ]),
    );
    expect(proven.rows[0]?.['sample_ids']).toEqual([sample]);
    expect(await deletion.deregisterWorkout(athlete, release(sample, epoch))).toMatchObject({
      status: 'pending_cleanup',
    });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `INSERT INTO healthkit_workout_batch_receipt(athlete_id,installation_id,batch_id,request_digest,accepted_count,protocol_version)
      VALUES($1,$2,$3,$4,1,2)`,
          [athlete, randomUUID(), randomUUID(), 'a'.repeat(64)],
        ),
      ),
    ).rejects.toThrow('RECEIPT_MEMBERSHIP_REQUIRED');
  });
});

// Explicit synthetic user permission for named positive collection scenarios only.
async function declareSyntheticAppConsent(athleteId: string): Promise<void> {
  expect(
    await createConsentRepository(database).setConsent(athleteId, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    }),
  ).toEqual({ kind: 'app', granted: true, revision: 1 });
}
