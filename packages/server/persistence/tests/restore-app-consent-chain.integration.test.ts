import type { PlanDraft } from '@workout/contracts/planning';
import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
} from '@workout/server-coaching/runner';
import { createDatabase, type Database } from '../src/database.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';
import {
  grantOperations,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantCoachingRuns,
  grantCoachingRunWorker,
} from '../src/migrate.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  validateSuppressionRecord,
  type SuppressionRecord,
} from '../src/restore-suppression-records.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import {
  preflightSuppressionReplay,
  replayVerifiedSuppressionChain,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';

// Actual registered migrations and exact owner SQL. Synthetic authentication key
// proves this local boundary, never operational completeness or reopening.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `app_chain_owner_${suffix}`;
const names = [`app_chain_source_${suffix}`, `app_chain_target_${suffix}`];
const key = Buffer.alloc(32, 84),
  keyId = 'synthetic-app-chain',
  clusterId = '123456789';
let source: Pool, target: Pool;
let database: Database, workerDatabase: Database;
const runtimeRole = `app_chain_runtime_${suffix}`,
  workerRole = `app_chain_worker_${suffix}`;
function url(name: string, selectedRole = role) {
  const u = new URL(adminUrl as string);
  u.pathname = `/${name}`;
  u.username = selectedRole;
  u.password = 'isolated';
  return u.toString();
}
async function tenant<T>(pool: Pool, id: string, run: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const result = await run(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`);
    await migrate(url(name));
  }
  for (const selected of [runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${selected}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  const targetUrl = url(names[1] as string);
  await grantOperations(targetUrl, runtimeRole);
  await grantCoachingConstraints(targetUrl, runtimeRole);
  await grantCoachingThreads(targetUrl, runtimeRole);
  await grantCoreEvidenceSnapshots(targetUrl, runtimeRole);
  await grantCoachingRuns(targetUrl, runtimeRole);
  await grantCoachingRunWorker(targetUrl, workerRole);
  // Existing core-loop fixture write permissions. App binding/replay privileges
  // come solely from public grant* consumers, never ad hoc test helper grants.
  const setupOwner = new Pool({ connectionString: targetUrl });
  await setupOwner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,command_receipt,outbox TO "${runtimeRole}"`,
  );
  await setupOwner.query(
    `GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,check_in,session_completion,session_completion_collection_head,check_in_collection_head TO "${runtimeRole}"`,
  );
  await setupOwner.end();
  database = createDatabase({ connectionString: url(names[1] as string, runtimeRole) });
  workerDatabase = createDatabase({ connectionString: url(names[1] as string, workerRole) });
  source = new Pool({ connectionString: url(names[0] as string) });
  target = new Pool({ connectionString: url(names[1] as string) });
});
afterAll(async () => {
  await database?.close();
  await workerDatabase?.close();
  await source?.end();
  await target?.end();
  for (const name of names) await dropIsolatedDatabase(admin, name);
  for (const selected of [runtimeRole, workerRole, role])
    await admin.query(`DROP ROLE "${selected}"`);
  await admin.end();
});
async function fixture() {
  const id = randomUUID();
  for (const pool of [source, target])
    await pool.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [id, 'https://issuer.test', randomUUID()],
    );
  await tenant(source, id, async (c) => {
    await c.query("INSERT INTO consent VALUES($1,'app',true,1)", [id]);
    await c.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [id],
    );
    await c.query("UPDATE consent SET granted=true,revision=3 WHERE athlete_id=$1 AND kind='app'", [
      id,
    ]);
  });
  const rows = await tenant(source, id, (c) =>
    c.query(
      "SELECT e.*,e.occurred_at::text AS occurred_at FROM restore_suppression_event e WHERE athlete_id=$1 AND kind='app_consent_transition' ORDER BY consent_revision",
      [id],
    ),
  );
  const records = rows.rows.map((row) =>
    validateSuppressionRecord(
      new Map(
        Object.entries(row).map(([name, value]) => [
          name,
          value === null ? null : typeof value === 'boolean' ? (value ? 't' : 'f') : String(value),
        ]),
      ),
    ),
  );
  expect(records).toHaveLength(3);
  return { id, records };
}
function chain(records: readonly SuppressionRecord[]) {
  const body = {
    localRecordVersion: 1 as const,
    clusterId,
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: [...records] }],
  };
  const envelope: LocalReplayRecordEnvelope = {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
  const anchor: TrustedReplayAnchor = {
    clusterId,
    fromLsn: body.fromLsn,
    throughLsn: body.throughLsn,
    previousHash: null,
    finalLocalHash: envelope.sha256,
    ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
  };
  return { segments: [bytes], key, keyId, anchor };
}
async function state(id: string) {
  return tenant(
    target,
    id,
    async (c) =>
      (
        await c.query(
          `SELECT (SELECT revision FROM consent WHERE athlete_id=$1 AND kind='app') revision,(SELECT granted FROM consent WHERE athlete_id=$1 AND kind='app') granted,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND kind='app_consent_transition') events,(SELECT count(*)::int FROM restore_app_consent_replay_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND idempotency_key LIKE 'restore:app_consent:%') outbox`,
          [id],
        )
      ).rows[0],
  );
}
it('replays actual SQL v5 records through authenticated encrypted chain with exact epochs and idempotent receipts', async () => {
  const { id, records } = await fixture();
  const input = chain(records);
  expect(preflightSuppressionReplay(input).eventCount).toBe(3);
  await replayVerifiedSuppressionChain({ ...input, ownerPool: target });
  expect(await state(id)).toEqual({
    revision: 3,
    granted: true,
    events: 3,
    receipts: 3,
    outbox: 3,
  });
  const first = await state(id);
  await replayVerifiedSuppressionChain({ ...input, ownerPool: target });
  expect(await state(id)).toEqual(first);
  await expect(
    tenant(target, id, (c) => c.query('SELECT public.require_app_admission_revision(1)')),
  ).rejects.toThrow('STALE_APP_ADMISSION');
  expect(
    (
      await tenant(target, id, (c) =>
        c.query('SELECT public.require_app_admission_revision(3) AS revision'),
      )
    ).rows[0]?.['revision'],
  ).toBe(3);
});
it('rejects corrupted ciphertext, truncated tail, wrong key and forged anchor before any target mutation', async () => {
  const { id, records } = await fixture();
  const input = chain(records);
  const byte = Buffer.from(input.segments[0] as Buffer);
  byte[byte.length - 1] = (byte[byte.length - 1] ?? 0) ^ 1;
  for (const invalid of [
    { ...input, segments: [byte] },
    { ...input, segments: [] },
    { ...input, key: Buffer.alloc(32, 85) },
    { ...input, anchor: { ...input.anchor, throughLsn: '0/140' } },
    { ...input, anchor: { ...input.anchor, clusterId: '987654321' } },
  ]) {
    await expect(
      replayVerifiedSuppressionChain({ ...invalid, ownerPool: target }),
    ).rejects.toThrow();
    expect(await state(id)).toEqual({
      revision: null,
      granted: null,
      events: 0,
      receipts: 0,
      outbox: 0,
    });
  }
});
it('rolls back intermediate exact SQL replay failure and safely restarts the unchanged chain', async () => {
  const { id, records } = await fixture();
  const second = records[1];
  if (!second || second.kind !== 'app_consent_transition')
    throw new Error('Fixture app transition missing');
  const invalid = chain([
    records[0] as SuppressionRecord,
    { ...second, consentPreviousGranted: false },
    records[2] as SuppressionRecord,
  ]);
  await expect(replayVerifiedSuppressionChain({ ...invalid, ownerPool: target })).rejects.toThrow(
    'RESTORE_APP_STATE_CONFLICT',
  );
  expect(await state(id)).toEqual({
    revision: null,
    granted: null,
    events: 0,
    receipts: 0,
    outbox: 0,
  });
  await replayVerifiedSuppressionChain({ ...chain(records), ownerPool: target });
  expect(await state(id)).toEqual({
    revision: 3,
    granted: true,
    events: 3,
    receipts: 3,
    outbox: 3,
  });
});
it('rejects unknown owner, erased tenant and same-event foreign identity without partial writes', async () => {
  const { id, records } = await fixture();
  const first = records[0];
  if (!first) throw new Error('Fixture record missing');
  const unknown = randomUUID();
  await expect(
    replayVerifiedSuppressionChain({
      ...chain([{ ...first, athleteId: unknown }]),
      ownerPool: target,
    }),
  ).rejects.toThrow('RESTORE_APP_TENANT_UNKNOWN');
  await replayVerifiedSuppressionChain({ ...chain(records), ownerPool: target });
  const before = await state(id);
  const other = randomUUID();
  await target.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [other, 'https://issuer.test', randomUUID()],
  );
  await expect(
    replayVerifiedSuppressionChain({
      ...chain([{ ...first, athleteId: other }]),
      ownerPool: target,
    }),
  ).rejects.toThrow('RESTORE_APP_EVENT_CONFLICT');
  expect(await state(id)).toEqual(before);
  const erased = await fixture();
  await tenant(target, erased.id, (c) =>
    c.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erased.id]),
  );
  await expect(
    replayVerifiedSuppressionChain({ ...chain(erased.records), ownerPool: target }),
  ).rejects.toThrow('RESTORE_APP_TENANT_ERASED');
  expect(await state(erased.id)).toEqual({
    revision: null,
    granted: null,
    events: 0,
    receipts: 0,
    outbox: 0,
  });
});

async function seedTarget(athleteId: string, grantApp = true) {
  if (grantApp)
    await createConsentRepository(database).setConsent(athleteId, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  const draft: PlanDraft = {
    title: 'Training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const plan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: plan.id,
      title: 'Training question',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic private report',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  return {
    plan,
    thread,
    evidence,
    command: {
      schemaVersion: 1 as const,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      idempotencyKey: randomUUID(),
    },
  };
}

it('restored app tail keeps source-produced output readable and old binding stale without replaying a provider', async () => {
  const { id, records } = await fixture();
  const first = records[0];
  if (!first) throw new Error('Fixture record missing');
  await replayVerifiedSuppressionChain({ ...chain([first]), ownerPool: target });
  const seeded = await seedTarget(id, false);
  const options = {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture' as const, fixtureId: 'synthetic-v1' },
  };
  const repo = createCoachingRunRepository(database, options),
    store = createCoachingRunWorkerStore(workerDatabase, options);
  const stored = await repo.create(id, seeded.thread.id, seeded.command);
  expect(
    await runOneCoachingJob({
      athleteId: id,
      store,
      adapter: createDeterministicFixtureAdapter('synthetic-v1'),
    }),
  ).toBe('stored');
  const output = await repo.readOutput(id, stored.id);
  expect(output).not.toBeNull();
  const queued = await repo.create(id, seeded.thread.id, {
    ...seeded.command,
    idempotencyKey: randomUUID(),
  });
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = runOneCoachingJob({
    athleteId: id,
    store,
    adapter: {
      evaluate: async () => {
        enter();
        await held;
        return { kind: 'analysis', content: { synthetic: true } };
      },
    },
  });
  await entered;
  const preparedLater = await repo.create(id, seeded.thread.id, {
    ...seeded.command,
    idempotencyKey: randomUUID(),
  });
  await replayVerifiedSuppressionChain({ ...chain(records), ownerPool: target });
  release();
  expect(await inFlight).toBe('skipped');
  expect((await repo.read(id, queued.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'stale_basis',
  });
  expect(await repo.readOutput(id, stored.id)).toEqual(output);
  expect(await repo.create(id, seeded.thread.id, seeded.command)).toEqual(
    await repo.read(id, stored.id),
  );
  await expect(
    repo.create(id, seeded.thread.id, { ...seeded.command, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('STALE_APP_ADMISSION');
  let calls = 0;
  expect(
    await runOneCoachingJob({
      athleteId: id,
      store,
      adapter: {
        evaluate: async () => {
          calls++;
          return { kind: 'analysis', content: { synthetic: true } };
        },
      },
    }),
  ).toBe('skipped');
  expect(calls).toBe(0);
  expect((await repo.read(id, preparedLater.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'stale_basis',
  });
  const binding = await database.tenant(id, (tx) =>
    tx.query('SELECT app_revision FROM evidence_app_admission_binding WHERE athlete_id=$1', [id]),
  );
  expect(binding.rows).toEqual([{ app_revision: 1 }]);
  await expect(
    database.tenant(id, (tx) =>
      tx.query('SELECT public.replay_app_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)', [
        id,
        randomUUID(),
        '2026-09-30 00:00:00+00',
        null,
        null,
        1,
        true,
      ]),
    ),
  ).rejects.toThrow('permission denied');
});

it.skipIf(process.env['TEST_PGOUTPUT_CONTRACT'] !== '1')(
  'round-trips actual committed pgoutput v5 through encrypted replay into a separate owner database',
  async () => {
    const u = new URL(adminUrl as string);
    u.pathname = `/${names[0]}`;
    const replication = new Pool({ connectionString: u.toString() });
    const slot = `wm_suppression_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    try {
      const created = await replication.query(
        'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
        [slot, 'pgoutput'],
      );
      const fromLsn = created.rows[0]?.['lsn'];
      if (typeof fromLsn !== 'string') throw new Error('Slot boundary missing');
      const cluster = await replication.query(
        'SELECT system_identifier::text AS id FROM pg_control_system()',
      );
      const realCluster = cluster.rows[0]?.['id'];
      if (typeof realCluster !== 'string') throw new Error('Cluster identity missing');
      const { id, records } = await fixture();
      const { peekSuppressionPgoutput, makeLocalReplayRecordEnvelope } =
        await import('../src/restore-suppression-pgoutput.js');
      const messages = await peekSuppressionPgoutput(replication, slot);
      const envelope = makeLocalReplayRecordEnvelope({
        clusterId: realCluster,
        fromLsn,
        previousHash: null,
        messages,
      });
      expect(envelope.transactions.flatMap((t) => t.records)).toEqual(records);
      const bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
      const anchor: TrustedReplayAnchor = {
        clusterId: realCluster,
        fromLsn,
        throughLsn: envelope.throughLsn,
        previousHash: null,
        finalLocalHash: envelope.sha256,
        ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
      };
      await replayVerifiedSuppressionChain({
        segments: [bytes],
        key,
        keyId,
        anchor,
        ownerPool: target,
      });
      expect(await state(id)).toEqual({
        revision: 3,
        granted: true,
        events: 3,
        receipts: 3,
        outbox: 3,
      });
      const again = makeLocalReplayRecordEnvelope({
        clusterId: realCluster,
        fromLsn,
        previousHash: null,
        messages: await peekSuppressionPgoutput(replication, slot),
      });
      expect(again).toEqual(envelope);
    } finally {
      await replication.query('SELECT pg_drop_replication_slot($1)', [slot]).catch(() => undefined);
      await replication.end();
    }
  },
);

it('preserves mixed legacy AI HealthKit and race v4 exact replay beside app v5', async () => {
  const { id, records } = await fixture();
  const occurredAt = records[0]?.occurredAt;
  if (!occurredAt) throw new Error('Fixture timestamp missing');
  const legacy: SuppressionRecord[] = [];
  for (const kind of ['ai_consent_transition', 'healthkit_consent_transition'] as const) {
    legacy.push(
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        athleteId: id,
        occurredAt,
        kind,
        consentPreviousRevision: null,
        consentPreviousGranted: null,
        consentRevision: 1,
        consentGranted: true,
      },
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        athleteId: id,
        occurredAt,
        kind,
        consentPreviousRevision: 1,
        consentPreviousGranted: true,
        consentRevision: 2,
        consentGranted: false,
      },
    );
  }
  for (const kind of [
    'race_event_deleted',
    'race_result_deleted',
    'training_best_deleted',
  ] as const)
    legacy.push({
      schemaVersion: 4,
      eventId: randomUUID(),
      athleteId: id,
      occurredAt,
      kind,
      targetId: randomUUID(),
      racePreviousRevision: 1,
      raceDeletedRevision: 2,
    });
  const input = chain([...records, ...legacy]);
  await replayVerifiedSuppressionChain({ ...input, ownerPool: target });
  const observed = await tenant(target, id, (c) =>
    c.query('SELECT kind,revision,granted FROM consent WHERE athlete_id=$1 ORDER BY kind', [id]),
  );
  expect(observed.rows).toEqual([
    { kind: 'ai', revision: 2, granted: false },
    { kind: 'app', revision: 3, granted: true },
    { kind: 'healthkit', revision: 2, granted: false },
  ]);
  const race = await tenant(target, id, (c) =>
    c.query(
      'SELECT (SELECT count(*)::int FROM restore_race_deletion_replay_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::int FROM race_event WHERE athlete_id=$1 AND deleted AND values_json IS NULL) events,(SELECT count(*)::int FROM race_result WHERE athlete_id=$1 AND deleted AND values_json IS NULL) results,(SELECT count(*)::int FROM training_best WHERE athlete_id=$1 AND deleted AND values_json IS NULL) bests',
      [id],
    ),
  );
  expect(race.rows).toEqual([{ receipts: 3, events: 1, results: 1, bests: 1 }]);
  await replayVerifiedSuppressionChain({ ...input, ownerPool: target });
  expect(await state(id)).toEqual({
    revision: 3,
    granted: true,
    events: 3,
    receipts: 3,
    outbox: 3,
  });
});

it('registered grant consumers expose no runtime exact replay or worker approval authority', async () => {
  const privileges = await target.query(
    `SELECT has_function_privilege($1,'public.replay_app_consent_transition_exact(text,uuid,timestamp with time zone,integer,boolean,integer,boolean)','EXECUTE') runtime_replay,has_function_privilege($2,'public.replay_app_consent_transition_exact(text,uuid,timestamp with time zone,integer,boolean,integer,boolean)','EXECUTE') worker_replay,has_function_privilege($2,'public.record_approval_app_binding(text,uuid,text)','EXECUTE') worker_approval,has_table_privilege($2,'public.approval_app_admission_binding','SELECT') worker_approval_read`,
    [runtimeRole, workerRole],
  );
  expect(privileges.rows).toEqual([
    {
      runtime_replay: false,
      worker_replay: false,
      worker_approval: false,
      worker_approval_read: false,
    },
  ]);
});
