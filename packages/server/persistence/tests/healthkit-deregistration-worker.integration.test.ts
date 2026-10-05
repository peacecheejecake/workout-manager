import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createActivityTrackTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  validateObjectKey,
} from '@workout/server-media';
import { createDatabase, type Database } from '../src/database.js';
import { createHealthKitRegistrationRepository } from '../src/healthkit-registration.js';
import { createHealthKitIngestionRepository } from '../src/healthkit-ingestion.js';
import { createHealthKitDeregistrationRepository } from '../src/healthkit-deregistration.js';
import { createHealthKitDeregistrationWorkerRepository } from '../src/healthkit-deregistration-worker.js';
import {
  createResourceObjectCleanupRepository,
  processOneObjectScopePurge,
} from '../src/resource-object-cleanup.js';
import {
  grantHealthKitIngestion,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';

const clusterAdminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const clusterRuntimeUrl = process.env['TEST_DATABASE_URL'];
if (!clusterAdminUrl || !clusterRuntimeUrl) throw new Error('Use isolated real PostgreSQL');
const databaseName = `hk_worker_${randomUUID().replaceAll('-', '')}`;
const isolatedAdmin = new URL(clusterAdminUrl);
const isolatedRuntime = new URL(clusterRuntimeUrl);
isolatedAdmin.pathname = `/${databaseName}`;
isolatedRuntime.pathname = `/${databaseName}`;
const adminUrl = isolatedAdmin.toString();
const runtimeUrl = isolatedRuntime.toString();
const cluster = new Pool({ connectionString: clusterAdminUrl });
const admin = new Pool({ connectionString: adminUrl });
const workerRole = `hk_cleanup_${randomUUID().replaceAll('-', '')}`;
const workerUrl = new URL(runtimeUrl);
workerUrl.username = workerRole;
workerUrl.password = '';
const worker = new Pool({ connectionString: workerUrl.toString() });
let database: Database;
let root: string;
let store: Awaited<ReturnType<typeof createLocalFilesystemObjectStorage>>;
let cleanup: ReturnType<typeof createResourceObjectCleanupRepository>;
let finalizer: ReturnType<typeof createHealthKitDeregistrationWorkerRepository>;
beforeAll(async () => {
  await cluster.query(`CREATE DATABASE "${databaseName}"`);
  await migrate(adminUrl);
  await grantHealthKitIngestion(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantResourceObjectCleanupWorker(adminUrl, workerRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
  root = await mkdtemp(join(tmpdir(), 'hk-deregistration-cleanup-'));
  store = await createLocalFilesystemObjectStorage(root);
  cleanup = createResourceObjectCleanupRepository({
    connectionString: workerUrl.toString(),
    max: 2,
  });
  finalizer = createHealthKitDeregistrationWorkerRepository({
    connectionString: workerUrl.toString(),
    max: 2,
  });
});
afterAll(async () => {
  await Promise.all([cleanup?.close(), finalizer?.close(), database?.close(), worker.end()]);
  await admin.end();
  await cluster.query(`DROP DATABASE "${databaseName}"`);
  await cluster.end();
  if (root) await rm(root, { recursive: true, force: true });
});
const register = (sampleId: string) => ({
  schemaVersion: 1 as const,
  sampleIds: [sampleId],
  accountAttributionDeclared: true as const,
  expectedConsentRevision: 1,
  expectedRegistryRevision: 0,
  idempotencyKey: randomUUID(),
});
async function consent(athleteId: string) {
  await database.tenant(athleteId, (tx) =>
    tx.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athleteId],
    ),
  );
}
async function fixture(withActivity = false) {
  const athleteId = randomUUID(),
    other = randomUUID(),
    sampleId = randomUUID();
  await Promise.all([consent(athleteId), consent(other)]);
  const registration = createHealthKitRegistrationRepository(database);
  const claim = (await registration.registerWorkouts(athleteId, register(sampleId))).claims[0];
  if (!claim) throw new Error('Missing synthetic claim');
  let activityId: string | null = null;
  if (withActivity) {
    await createHealthKitIngestionRepository(database).ingestBatch(
      athleteId,
      {
        schemaVersion: 2,
        installationId: randomUUID(),
        batchId: randomUUID(),
        events: [
          {
            kind: 'upsert',
            sampleId,
            claimEpoch: claim.claimEpoch,
            sourceBundleId: 'com.example.synthetic',
            sourceVersion: null,
            activityType: 37,
            observedFrom: '2026-09-20T06:00:00+09:00',
            observedTo: '2026-09-20T06:01:00+09:00',
            durationSeconds: 60,
            distanceMeters: null,
            energyKilocalories: null,
          },
        ],
      },
      1,
    );
    const activity = await database.tenant(athleteId, (tx) =>
      tx.query(
        'SELECT public.create_healthkit_canonical($1,(SELECT payload_digest FROM healthkit_workout_sample WHERE sample_id=$1)) AS id',
        [sampleId],
      ),
    );
    activityId = z.uuid().parse(activity.rows[0]?.['id']);
  }
  const pending = await createHealthKitDeregistrationRepository(database).deregisterWorkout(
    athleteId,
    {
      schemaVersion: 1,
      sampleId,
      claimEpoch: claim.claimEpoch,
      expectedConsentRevision: 1,
      expectedRegistryRevision: 1,
      confirmRelatedRecordDeletion: true,
      idempotencyKey: randomUUID(),
    },
  );
  return { athleteId, other, sampleId, activityId, pending, registration };
}
async function due(athleteId: string) {
  await admin.query(
    'UPDATE healthkit_deregistration_work SET available_at=clock_timestamp() WHERE athlete_id=$1',
    [athleteId],
  );
}
it('releases only after real temporary-filesystem prefix deletion and committed database cleanup facts', async () => {
  const item = await fixture(true);
  if (!item.activityId) throw new Error('Missing synthetic activity');
  const key = createActivityTrackTemporaryObjectKey({
    tenantId: item.athleteId,
    activityId: item.activityId,
    trackId: randomUUID(),
    uploadId: randomUUID(),
    artifactKind: 'raw',
  });
  async function* bytes() {
    yield new TextEncoder().encode('synthetic track');
  }
  await store.writeTemporary(key, bytes());
  expect(await store.stat(key)).not.toBeNull();
  expect(await finalizer.processOne()).toBe('pending_cleanup');
  await expect(
    item.registration.registerWorkouts(item.other, register(item.sampleId)),
  ).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
  const outcome = await processOneObjectScopePurge(cleanup, {
    listScopeObjects: (scope, limit) => store.listScopeObjects(scope, limit),
    delete: (key) => store.delete(validateObjectKey(key)),
    stat: (key) => store.stat(validateObjectKey(key)),
  });
  expect(outcome).toBe('passed');
  expect(await store.stat(key)).toBeNull();
  await due(item.athleteId);
  expect(await finalizer.processOne()).toBe('released');
  expect(
    await createHealthKitDeregistrationRepository(database).getStatus(
      item.athleteId,
      item.pending.operationId,
    ),
  ).toMatchObject({ status: 'released' });
  expect(
    (await item.registration.registerWorkouts(item.other, register(item.sampleId))).claims,
  ).toHaveLength(1);
  expect(await finalizer.processOne()).toBe('empty');
});
it('keeps the claim pending on physical deletion failure without publishing completion', async () => {
  const item = await fixture(true);
  if (!item.activityId) throw new Error('Missing synthetic activity');
  const key = createActivityTrackTemporaryObjectKey({
    tenantId: item.athleteId,
    activityId: item.activityId,
    trackId: randomUUID(),
    uploadId: randomUUID(),
    artifactKind: 'raw',
  });
  async function* bytes() {
    yield new Uint8Array([1]);
  }
  await store.writeTemporary(key, bytes());
  expect(
    await processOneObjectScopePurge(cleanup, {
      listScopeObjects: (scope, limit) => store.listScopeObjects(scope, limit),
      delete: async () => {
        throw new Error('EACCES');
      },
      stat: (key) => store.stat(validateObjectKey(key)),
    }),
  ).toBe('retry_scheduled');
  expect(await finalizer.processOne()).toBe('pending_cleanup');
  expect(await store.stat(key)).not.toBeNull();
  await expect(
    item.registration.registerWorkouts(item.other, register(item.sampleId)),
  ).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
});
it('fences concurrent leases, wrong tenants and expired tokens using database time', async () => {
  const item = await fixture();
  const workerId = randomUUID(),
    rival = randomUUID();
  const leases = await Promise.all([
    worker.query('SELECT * FROM public.lease_healthkit_deregistration($1,$2::interval)', [
      workerId,
      '1 minute',
    ]),
    worker.query('SELECT * FROM public.lease_healthkit_deregistration($1,$2::interval)', [
      rival,
      '1 minute',
    ]),
  ]);
  const picked = leases.find(
    (result) => result.rows[0]?.['operation_id'] === item.pending.operationId,
  );
  expect(picked).toBeDefined();
  const lease = z
    .object({ athlete_id: z.string(), operation_id: z.uuid(), lease_token: z.uuid() })
    .parse(picked?.rows[0]);
  const owner = picked === leases[0] ? workerId : rival;
  const finish = async (tenant: string, token = lease.lease_token) =>
    (
      await worker.query('SELECT public.finish_healthkit_deregistration($1,$2,$3,$4) AS outcome', [
        owner,
        tenant,
        lease.operation_id,
        token,
      ])
    ).rows[0]?.['outcome'];
  expect(await finish(item.other)).toBe('lease_lost');
  expect(await finish(item.athleteId, randomUUID())).toBe('lease_lost');
  await admin.query(
    "UPDATE healthkit_deregistration_work SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
    [lease.operation_id],
  );
  expect(await finish(item.athleteId)).toBe('lease_lost');
  await due(item.athleteId);
  const renewed = await worker.query(
    'SELECT * FROM public.lease_healthkit_deregistration($1,$2::interval)',
    [owner, '1 minute'],
  );
  expect(renewed.rows[0]?.['lease_token']).not.toBe(lease.lease_token);
  expect(await finish(item.athleteId)).toBe('lease_lost');
  const token = z.uuid().parse(renewed.rows[0]?.['lease_token']);
  expect(await finish(item.athleteId, token)).toBe('released');
});
it('denies API finalization and worker table reads, and cancels a leased job on withdrawal', async () => {
  const item = await fixture();
  await expect(
    database.tenant(item.athleteId, (tx) =>
      tx.query('SELECT public.finalize_healthkit_deregistration($1)', [item.pending.operationId]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(worker.query('SELECT * FROM healthkit_deregistration_work')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(worker.query('SELECT * FROM healthkit_workout_claim')).rejects.toMatchObject({
    code: '42501',
  });
  const owner = randomUUID();
  const leased = await worker.query(
    'SELECT * FROM public.lease_healthkit_deregistration($1,$2::interval)',
    [owner, '1 minute'],
  );
  const token = z.uuid().parse(leased.rows[0]?.['lease_token']);
  await database.tenant(item.athleteId, (tx) =>
    tx.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
      [item.athleteId],
    ),
  );
  expect(
    (
      await worker.query('SELECT public.finish_healthkit_deregistration($1,$2,$3,$4) AS outcome', [
        owner,
        item.athleteId,
        item.pending.operationId,
        token,
      ])
    ).rows[0]?.['outcome'],
  ).toBe('lease_lost');
  expect(
    (await item.registration.registerWorkouts(item.other, register(item.sampleId))).claims,
  ).toHaveLength(1);
});

it('reports exhausted jobs as bounded dead letters and retains ownership instead of silent release', async () => {
  const item = await fixture();
  await admin.query('UPDATE healthkit_deregistration_work SET failures=20 WHERE operation_id=$1', [
    item.pending.operationId,
  ]);
  expect(await finalizer.deadLetterCount()).toBe(1);
  expect(await finalizer.processOne()).toBe('empty');
  expect(
    await createHealthKitDeregistrationRepository(database).getStatus(
      item.athleteId,
      item.pending.operationId,
    ),
  ).toMatchObject({ status: 'pending_cleanup' });
  await expect(
    item.registration.registerWorkouts(item.other, register(item.sampleId)),
  ).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
});
