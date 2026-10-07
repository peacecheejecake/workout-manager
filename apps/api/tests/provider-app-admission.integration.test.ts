import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  runGarminCollection,
  type GarminActivityCollector,
} from '@workout/server-integrations/garmin-collection';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import * as grants from '@workout/server-persistence/migrate';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { createHealthKitRegistrationRepository } from '@workout/server-persistence/healthkit-registration';
import { createHealthKitIngestionRepository } from '@workout/server-persistence/healthkit-ingestion';
import { createHealthKitBindingRepository } from '@workout/server-persistence/healthkit-binding';
import { createHealthKitActivityRepository } from '@workout/server-persistence/healthkit-activity';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createGarminUnofficialStore } from '@workout/server-persistence/garmin-unofficial';

// Real normal105 transactions; synthetic declared HK workouts and sealed Garmin
// envelope/collector only. No provider, HealthKit device or admission authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
  name = `provider_app_${suffix}`;
const roles = { owner: `pa_owner_${suffix}`, runtime: `pa_runtime_${suffix}` };
function url(role: string) {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = 'isolated';
  u.pathname = `/${name}`;
  return u.toString();
}
let database: Database, owner: Pool;
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${name}" OWNER "${roles.owner}"`);
  await grants.migrate(url(roles.owner), 105);
  for (const grant of [
    grants.grantCorePlanning,
    grants.grantOperations,
    grants.grantHealthKitIngestion,
    grants.grantGarminUnofficial,
  ])
    await grant(url(roles.owner), roles.runtime);
  // Exact Activity ACL from the normal configured ext-oidc-local/identity composition.
  // This is not a public grant helper or additional owner/global capability.
  const configured = new Pool({ connectionString: url(roles.owner), max: 1 });
  try {
    await configured.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_overlay TO "${roles.runtime}"`,
    );
    await configured.query(
      `GRANT SELECT,INSERT ON activity_source_revision,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${roles.runtime}"`,
    );
  } finally {
    await configured.end();
  }
  database = createDatabase({ connectionString: url(roles.runtime), max: 8 });
  owner = new Pool({ connectionString: url(roles.owner), max: 4 });
}, 30000);
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
const consents = () => createConsentRepository(database);
async function app(id: string, granted: boolean, revision: number) {
  return consents().setConsent(id, {
    kind: 'app',
    granted,
    expectedRevision: revision,
    idempotencyKey: randomUUID(),
  });
}
async function hk(id = randomUUID(), count = 1) {
  for (const kind of ['healthkit', 'provider', 'ai'] as const)
    await consents().setConsent(id, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  const sampleIds = Array.from({ length: count }, () => randomUUID());
  const registered = await createHealthKitRegistrationRepository(database).registerWorkouts(id, {
    schemaVersion: 1,
    sampleIds,
    accountAttributionDeclared: true,
    expectedConsentRevision: 1,
    expectedRegistryRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const batch = {
    schemaVersion: 2 as const,
    installationId: randomUUID(),
    batchId: randomUUID(),
    events: registered.claims.map((claim) => ({
      kind: 'upsert' as const,
      sampleId: claim.sampleId,
      claimEpoch: claim.claimEpoch,
      sourceBundleId: 'synthetic.fixture',
      sourceVersion: null,
      activityType: 37,
      observedFrom: '2026-09-20T00:00:00Z',
      observedTo: '2026-09-20T00:30:00Z',
      durationSeconds: 1800,
      distanceMeters: 5000,
      energyKilocalories: null,
    })),
  };
  return { id, batch };
}
async function counts(id: string) {
  return database.tenant(id, async (tx) => {
    const result: Record<string, number> = {};
    for (const table of [
      'healthkit_workout_sample',
      'healthkit_workout_batch_receipt',
      'activity_canonical',
      'command_receipt',
      'outbox',
      'garmin_unofficial_run',
      'garmin_activity_ledger',
      'garmin_activity_ledger_source',
    ])
      result[table] = z
        .number()
        .int()
        .nonnegative()
        .parse(
          (await tx.query(`SELECT count(*)::integer AS n FROM ${table} WHERE athlete_id=$1`, [id]))
            .rows[0]?.['n'],
        );
    return result;
  });
}
const fit = (id: string) => ({
  idempotencyKey: randomUUID(),
  source: { kind: 'fit' as const, sourceId: id, revision: 1, contentHash: 'a'.repeat(64) },
  activity: {
    title: null,
    kind: 'running' as const,
    startedAt: '2026-09-20T00:00:00Z',
    timezone: null,
    durationSeconds: 1800,
    durationKind: 'timer' as const,
    distanceMeters: 5000,
  },
});
it('HK/provider/AI permission cannot replace absent or false app; mixed batch rolls back and delete-only cleanup remains', async () => {
  const s = await hk(undefined, 2),
    repo = createHealthKitIngestionRepository(database),
    before = await counts(s.id);
  await expect(repo.ingestBatch(s.id, s.batch, 1)).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(s.id)).toEqual(before);
  await app(s.id, false, 0);
  const denied = await counts(s.id);
  await expect(repo.ingestBatch(s.id, s.batch, 1)).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(s.id)).toEqual(denied);
  await app(s.id, true, 1);
  const ack = await repo.ingestBatch(s.id, s.batch, 1);
  await app(s.id, false, 2);
  expect(await repo.ingestBatch(s.id, s.batch, 1)).toEqual(ack);
  const first = s.batch.events[0],
    second = s.batch.events[1];
  if (!first || !second) throw new Error('Expected declared samples');
  const mixed = {
    ...s.batch,
    batchId: randomUUID(),
    events: [
      { kind: 'delete' as const, sampleId: first.sampleId, claimEpoch: first.claimEpoch },
      second,
    ],
  };
  const existing = await counts(s.id);
  await expect(repo.ingestBatch(s.id, mixed, 1)).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(s.id)).toEqual(existing);
  expect(
    (
      await database.tenant(s.id, (tx) =>
        tx.query(
          'SELECT state FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2',
          [s.id, first.sampleId],
        ),
      )
    ).rows,
  ).toEqual([{ state: 'active' }]);
  await repo.ingestBatch(s.id, { ...mixed, batchId: randomUUID(), events: [mixed.events[0]] }, 1);
  expect(
    (
      await database.tenant(s.id, (tx) =>
        tx.query(
          'SELECT state,payload_digest FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2',
          [s.id, first.sampleId],
        ),
      )
    ).rows,
  ).toEqual([{ state: 'deleted', payload_digest: null }]);
});
it('HK create/bind exact successful receipts survive app withdrawal; new commands deny and HK withdrawal still wins', async () => {
  const s = await hk(undefined, 2);
  await app(s.id, true, 0);
  await createHealthKitIngestionRepository(database).ingestBatch(s.id, s.batch, 1);
  const commands = await database.tenant(s.id, async (tx) =>
    Promise.all(
      s.batch.events.map(async (event) => ({
        sampleId: event.sampleId,
        confirmed: true as const,
        expectedSampleDigest: z
          .string()
          .parse(
            (
              await tx.query(
                'SELECT payload_digest FROM healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2',
                [s.id, event.sampleId],
              )
            ).rows[0]?.['payload_digest'],
          ),
        idempotencyKey: randomUUID(),
      })),
    ),
  );
  const create = commands[0],
    bind = commands[1];
  if (!create || !bind) throw new Error('Expected two samples');
  // Existing independent FIT target is an explicit plain-owner storage fixture;
  // runtime rights come only from normal public helpers, never ad hoc Activity DML grants.
  const target = { activityId: randomUUID() };
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [s.id]);
    await connection.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      s.id,
    ]);
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [s.id]);
    await connection.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [s.id, target.activityId, JSON.stringify(fit(randomUUID()).activity)],
    );
    await connection.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fit',$2,1,$3,$4)",
      [s.id, randomUUID(), 'a'.repeat(64), target.activityId],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }

  const bindCommand = { ...bind, targetActivityId: target.activityId, expectedActivityRevision: 1 };
  const activity = createHealthKitActivityRepository(database),
    binding = createHealthKitBindingRepository(database);
  const result = await activity.createActivity(s.id, create),
    linked = await binding.bindExisting(s.id, bindCommand);
  await app(s.id, false, 1);
  const before = await counts(s.id);
  expect(await activity.createActivity(s.id, create)).toEqual(result);
  expect(await binding.bindExisting(s.id, bindCommand)).toEqual(linked);
  await expect(
    activity.createActivity(s.id, { ...create, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('APP_CONSENT_REQUIRED');
  await expect(
    binding.bindExisting(s.id, { ...bindCommand, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(s.id)).toEqual(before);
  await consents().setConsent(s.id, {
    kind: 'healthkit',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(activity.createActivity(s.id, create)).rejects.toThrow('CONSENT_REQUIRED');
  await expect(binding.bindExisting(s.id, bindCommand)).rejects.toThrow('CONSENT_REQUIRED');
});
const sealed = {
  keyId: 'synthetic',
  iv: 'i'.repeat(16),
  ciphertext: 'synthetic-no-provider-credential',
  tag: 't'.repeat(22),
};
async function garmin(id = randomUUID()) {
  const store = createGarminUnofficialStore(database);
  await store.beginLogin(id, new Date());
  expect(
    await store.commitLogin({
      athleteId: id,
      profileHash: 'a'.repeat(64),
      encryptedSession: sealed,
      now: new Date(),
    }),
  ).toBe('connected');
  await store.setSchedule(id, true, new Date());
  return { id, store };
}
it('Garmin dispatch denies absent/false app without deleting credentials; acquired app epoch is invalid after withdrawal and regrant and cleanup stays available', async () => {
  const s = await garmin();
  let calls = 0;
  const collector: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    collect: async () => {
      calls++;
      return { kind: 'finished', complete: true, credential: null };
    },
  };
  const options = {
    store: s.store,
    collector,
    cipher: { open: () => 'synthetic', seal: () => sealed },
    activities: createActivityRepository(database),
    accountHash: () => 'a'.repeat(64),
  };
  expect(await runGarminCollection(options, s.id)).toBeNull();
  await app(s.id, false, 0);
  expect(await runGarminCollection(options, s.id)).toBeNull();
  expect(calls).toBe(0);
  expect((await s.store.view(s.id, new Date())).state).toBe('connected');
  await app(s.id, true, 1);
  const leaseId = randomUUID(),
    runId = randomUUID(),
    lease = await s.store.acquireRun({ athleteId: s.id, leaseId, runId, now: new Date() });
  expect(lease?.appRevision).toBe(2);
  await app(s.id, false, 2);
  await app(s.id, true, 3);
  expect(await s.store.holdsRun(s.id, leaseId, new Date(), 2)).toBe(false);
  await s.store.finishRun({
    athleteId: s.id,
    leaseId,
    runId,
    now: new Date(),
    state: 'cancelled',
    counts: { listed: 0, imported: 0, unchanged: 0, suppressed: 0, skipped: 0, failed: 0 },
    complete: null,
  });
  expect((await s.store.view(s.id, new Date())).state).toBe('connected');
  await app(s.id, false, 4);
  await s.store.disconnect(s.id);
  expect((await s.store.view(s.id, new Date())).state).toBe('not_connected');
});
it('in-flight synthetic Garmin collector cannot commit import or attribution after withdrawal/regrant', async () => {
  const s = await garmin();
  await app(s.id, true, 0);
  let entered: () => void = () => undefined,
    release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const collector: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    collect: async (request) => {
      entered();
      await hold;
      await request.accept({ id: '1234', imports: [fit(randomUUID())] });
      return { kind: 'finished', complete: true, credential: null };
    },
  };
  const pending = runGarminCollection(
    {
      store: s.store,
      collector,
      cipher: { open: () => 'synthetic', seal: () => sealed },
      activities: createActivityRepository(database),
      accountHash: () => 'a'.repeat(64),
    },
    s.id,
  );
  await ready;
  await app(s.id, false, 1);
  await app(s.id, true, 2);
  release();
  expect(await pending).toBe('cancelled');
  expect((await counts(s.id))['activity_canonical']).toBe(0);
  expect((await counts(s.id))['garmin_activity_ledger']).toBe(0);
  await expect(
    s.store.recordCollected({
      athleteId: s.id,
      garminActivityId: '1234',
      provider: 'garmin-connect-unofficial',
      appRevision: 1,
      outcome: 'imported',
      sources: [],
      now: new Date(),
    }),
  ).rejects.toThrow('STALE_APP_ADMISSION');
});
it('collector check→withdrawal/regrant→real import commit rejects the pinned epoch inside its own transaction', async () => {
  const s = await garmin();
  await app(s.id, true, 0);
  let entered: () => void = () => undefined,
    release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const actual = createActivityRepository(database);
  let importFailure: unknown;
  const collector: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    collect: async (request) => {
      await request.accept({ id: '9876', imports: [fit(randomUUID())] });
      return { kind: 'finished', complete: true, credential: null };
    },
  };
  const pending = runGarminCollection(
    {
      store: s.store,
      collector,
      cipher: { open: () => 'synthetic', seal: () => sealed },
      accountHash: () => 'a'.repeat(64),
      activities: {
        importActivity: async (tenant, input, execution) => {
          expect(execution).toEqual({ expectedAppRevision: 1 });
          entered();
          await hold;
          try {
            return await actual.importActivity(tenant, input, execution);
          } catch (error) {
            importFailure = error;
            throw error;
          }
        },
      },
    },
    s.id,
  );
  await ready;
  await app(s.id, false, 1);
  await app(s.id, true, 2);
  release();
  expect(await pending).toBe('cancelled');
  expect(importFailure).toMatchObject({ code: 'STALE_APP_ADMISSION' });
  expect((await counts(s.id))['activity_canonical']).toBe(0);
  expect((await counts(s.id))['garmin_activity_ledger']).toBe(0);
  expect(
    (
      await database.tenant(s.id, (tx) =>
        tx.query('SELECT count(*)::integer AS n FROM activity_import_receipt WHERE athlete_id=$1', [
          s.id,
        ]),
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
async function waitingOnTenant(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await owner.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",
      [pid],
    );
    if (result.rows[0]?.['waiting'] === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected real advisory waiter');
}
it('a committed app withdrawal holding tenant0 serializes and denies the later HK ingest with no batch rows', async () => {
  const s = await hk();
  await app(s.id, true, 0);
  const connection = await owner.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [s.id]);
    await connection.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      s.id,
    ]);
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [s.id]);
    await connection.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [s.id],
    );
    pending = createHealthKitIngestionRepository(database).ingestBatch(s.id, s.batch, 1);
    const denied = expect(pending).rejects.toThrow('APP_CONSENT_REQUIRED');
    // Observe the actual runtime advisory wait; no assertion from a timer or a mock.
    let runtimePid: number | undefined;
    for (let attempt = 0; attempt < 100 && !runtimePid; attempt++) {
      const rows = (
        await owner.query(
          "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.usename=$1 AND l.locktype='advisory' AND NOT l.granted",
          [roles.runtime],
        )
      ).rows;
      if (rows[0]) runtimePid = z.number().int().parse(rows[0]['pid']);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (runtimePid === undefined) throw new Error('Runtime waiter missing');
    await waitingOnTenant(runtimePid);
    await connection.query('COMMIT');
    await denied;
    expect((await counts(s.id))['healthkit_workout_sample']).toBe(0);
    expect((await counts(s.id))['healthkit_workout_batch_receipt']).toBe(0);
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    if (pending) await pending.catch(() => undefined);
  }
});
it('HK ingestion holding tenant0 commits first; subsequent app withdrawal waits and retains previously committed source data', async () => {
  const s = await hk();
  await app(s.id, true, 0);
  let entered: () => void = () => undefined,
    release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const holding: Database = {
    ...database,
    tenant: (tenant, action) =>
      database.tenant(tenant, async (tx) => {
        const result = await action(tx);
        entered();
        await hold;
        return result;
      }),
  };
  const ingest = createHealthKitIngestionRepository(holding).ingestBatch(s.id, s.batch, 1);
  await ready;
  const connection = await owner.connect();
  let revoke: Promise<unknown> | undefined;
  try {
    const pid = z
      .number()
      .int()
      .parse((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [s.id]);
    await connection.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      s.id,
    ]);
    revoke = connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [s.id]);
    await waitingOnTenant(pid);
    release();
    await ingest;
    await revoke;
    await connection.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [s.id],
    );
    await connection.query('COMMIT');
    expect((await counts(s.id))['healthkit_workout_sample']).toBe(1);
    expect((await counts(s.id))['healthkit_workout_batch_receipt']).toBe(1);
  } finally {
    release();
    await ingest.catch(() => undefined);
    if (revoke) await revoke.catch(() => undefined);
    await connection.query('ROLLBACK');
    connection.release();
  }
});

it('real Activity import exact receipt retains the original result after app withdrawal without a new write', async () => {
  const id = randomUUID(),
    repository = createActivityRepository(database),
    command = fit(randomUUID());
  await app(id, true, 0);
  const receipt = await repository.importActivity(id, command, { expectedAppRevision: 1 });
  expect(receipt.outcome).toBe('imported');
  await app(id, false, 1);
  const before = await counts(id);
  expect(await repository.importActivity(id, command, { expectedAppRevision: 1 })).toEqual(receipt);
  await expect(
    repository.importActivity(
      id,
      { ...command, idempotencyKey: randomUUID() },
      { expectedAppRevision: 1 },
    ),
  ).rejects.toThrow('APP_CONSENT_REQUIRED');
  expect(await counts(id)).toEqual(before);
});

it('withdrawal/regrant between a committed import and its ledger transaction cancels attribution without rewriting the actual', async () => {
  const s = await garmin();
  await app(s.id, true, 0);
  const actual = createActivityRepository(database);
  let attempted = false;
  const result = await runGarminCollection(
    {
      store: {
        ...s.store,
        recordCollected: async (input) => {
          attempted = true;
          expect(input.appRevision).toBe(1);
          expect((await counts(s.id))['activity_canonical']).toBe(1);
          await app(s.id, false, 1);
          await app(s.id, true, 2);
          await s.store.recordCollected(input);
        },
      },
      collector: {
        provider: 'garmin-connect-unofficial',
        official: false,
        collect: async (request) => {
          await request.accept({ id: '7777', imports: [fit(randomUUID())] });
          return { kind: 'finished', complete: true, credential: null };
        },
      },
      cipher: { open: () => 'synthetic', seal: () => sealed },
      accountHash: () => 'a'.repeat(64),
      activities: actual,
    },
    s.id,
  );
  expect(attempted).toBe(true);
  expect(result).toBe('cancelled');
  expect((await counts(s.id))['activity_canonical']).toBe(1);
  expect((await counts(s.id))['garmin_activity_ledger']).toBe(0);
});
