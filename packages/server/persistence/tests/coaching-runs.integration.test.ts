import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { coachingFixtureCandidateContentV1Schema } from '@workout/contracts/coaching-runs';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
} from '@workout/server-coaching/runner';
import {
  grantCoachingConstraints,
  grantCoachingRuns,
  grantCoachingRunWorker,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantOperations,
  migrate,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';
import { enqueue } from '../src/outbox.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let workerDatabase: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='workout_coaching_worker')
    THEN CREATE ROLE workout_coaching_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF; END $$`);
  await grantCoachingRunWorker(adminUrl, 'workout_coaching_worker');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,command_receipt,outbox TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,check_in,session_completion,session_completion_collection_head,check_in_collection_head TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  const workerUrl = new URL(runtimeUrl);
  workerUrl.username = 'workout_coaching_worker';
  workerUrl.password = '';
  workerDatabase = createDatabase({ connectionString: workerUrl.toString(), max: 8 });
});
afterAll(async () => {
  await database?.close();
  await workerDatabase?.close();
  await admin.end();
});

const repository = () =>
  createCoachingRunRepository(database, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  });
const workerStore = (
  sourceDatabase: Database = workerDatabase,
  leaseSeconds = 120,
  currentPolicy?: () => { id: string; version: string },
) =>
  createCoachingRunWorkerStore(sourceDatabase, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    leaseSeconds,
    ...(currentPolicy ? { currentPolicy } : {}),
  });

async function seed(athleteId: string) {
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

it('creates one tenant-owned queued attempt and ID-only event despite concurrent replay', async () => {
  const athleteId = randomUUID();
  const { thread, evidence, command } = await seed(athleteId);
  const repo = repository();
  const [first, replay] = await Promise.all([
    repo.create(athleteId, thread.id, command),
    repo.create(athleteId, thread.id, command),
  ]);
  expect(replay).toEqual(first);
  expect(first).toMatchObject({
    threadId: thread.id,
    evidenceSnapshotId: evidence.id,
    conversationRevision: 1,
    status: { kind: 'queued' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  });
  expect(await repo.read(randomUUID(), first.id)).toBeNull();
  expect(await repo.list(randomUUID(), thread.id)).toBeNull();
  expect(await repo.list(athleteId, thread.id, { offset: 1 })).toEqual({ total: 1, items: [] });
  expect(await repo.list(athleteId, thread.id)).toEqual({ total: 1, items: [first] });
  await expect(
    repo.create(athleteId, thread.id, {
      ...command,
      expectedConversationRevision: 2,
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await database.tenant(athleteId, async (tx) => {
    const events = await tx.query(
      "SELECT payload FROM outbox WHERE athlete_id=$1 AND topic='coaching.run_queued'",
      [athleteId],
    );
    expect(events.rows).toEqual([{ payload: { runId: first.id } }]);
    const stored = await tx.query('SELECT basis FROM coaching_run WHERE athlete_id=$1 AND id=$2', [
      athleteId,
      first.id,
    ]);
    expect(stored.rows[0]?.['basis']).toMatchObject({
      scope: 'running-core-v2-training',
      evidenceSnapshotId: evidence.id,
    });
  });
  await expect(
    database.tenant(athleteId, (tx) =>
      tx.query(
        `UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp()
         WHERE athlete_id=$1 AND id=$2`,
        [
          athleteId,
          first.id,
          JSON.stringify({ kind: 'cancelled', reason: 'user_requested', extra: true }),
        ],
      ),
    ),
  ).rejects.toThrow();
  expect((await repo.read(athleteId, first.id))?.status).toEqual({ kind: 'queued' });
  const cancelled = await repo.cancel(athleteId, first.id);
  expect(cancelled?.status).toEqual({ kind: 'cancelled', reason: 'user_requested' });
  expect(await repo.cancel(athleteId, first.id)).toEqual(cancelled);
  expect(await repo.create(athleteId, thread.id, command)).toEqual(cancelled);
  await expect(
    database.tenant(athleteId, (tx) =>
      tx.query('UPDATE coaching_run SET thread_id=$3 WHERE athlete_id=$1 AND id=$2', [
        athleteId,
        first.id,
        randomUUID(),
      ]),
    ),
  ).rejects.toThrow();
});

it('cancels queued work and scrubs internal output with the evidence when AI consent is withdrawn', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const repo = repository();
  const run = await repo.create(athleteId, thread.id, command);
  const connection = await admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await connection.query(
      'INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athleteId, randomUUID(), run.id, JSON.stringify({ draft: 'sensitive synthetic output' })],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect((await repo.read(athleteId, run.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'consent_withdrawn',
  });
  const auditor = await admin.connect();
  try {
    await auditor.query('BEGIN');
    await auditor.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const scrubbed = await auditor.query(
      'SELECT body,purged_reason FROM coaching_analysis_output WHERE athlete_id=$1 AND run_id=$2',
      [athleteId, run.id],
    );
    expect(scrubbed.rows).toEqual([{ body: null, purged_reason: 'consent_withdrawn' }]);
    await auditor.query('ROLLBACK');
  } finally {
    auditor.release();
  }
  await expect(
    repo.create(athleteId, thread.id, { ...command, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
});

it.each(['consent_withdrawn', 'source_deleted'] as const)(
  'redacts terminal question and failure text after %s without changing their outcomes',
  async (purgeReason) => {
    const athleteId = randomUUID();
    const { thread, evidence, command } = await seed(athleteId);
    const repo = repository();
    const questionRun = await repo.create(athleteId, thread.id, command);
    const failureCommand = { ...command, idempotencyKey: randomUUID() };
    const failureRun = await repo.create(athleteId, thread.id, failureCommand);
    await database.tenant(athleteId, async (tx) => {
      await tx.query(
        `UPDATE coaching_run SET status='{"kind":"running","stage":"preparing_evidence"}'::jsonb,
         updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2`,
        [athleteId, questionRun.id],
      );
      await tx.query(
        `UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp()
         WHERE athlete_id=$1 AND id=$2`,
        [
          athleteId,
          questionRun.id,
          JSON.stringify({ kind: 'needs_question', question: 'Synthetic private report question' }),
        ],
      );
      await tx.query(
        `UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp()
         WHERE athlete_id=$1 AND id=$2`,
        [
          athleteId,
          failureRun.id,
          JSON.stringify({
            kind: 'unable_to_evaluate',
            code: 'invalid_output',
            reason: 'Synthetic private report failure',
          }),
        ],
      );
    });
    if (purgeReason === 'consent_withdrawn') {
      await createConsentRepository(database).setConsent(athleteId, {
        kind: 'ai',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    } else {
      const owner = await admin.connect();
      try {
        await owner.query('BEGIN');
        await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
        await owner.query(
          `UPDATE core_evidence_snapshot SET body=NULL,purged_reason='source_deleted'
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, evidence.id],
        );
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      } finally {
        owner.release();
      }
    }
    const question = await repo.read(athleteId, questionRun.id);
    const failure = await repo.read(athleteId, failureRun.id);
    expect(question?.status).toEqual({
      kind: 'needs_question',
      question: 'Question removed after evidence withdrawal',
    });
    expect(failure?.status).toEqual({
      kind: 'unable_to_evaluate',
      code: 'invalid_output',
      reason: 'Reason removed after evidence withdrawal',
    });
    const listed = await repo.list(athleteId, thread.id);
    expect(listed?.items).toEqual(expect.arrayContaining([question, failure]));
    expect(await repo.create(athleteId, thread.id, command)).toEqual(question);
    expect(await repo.create(athleteId, thread.id, failureCommand)).toEqual(failure);
    expect(JSON.stringify({ question, failure, listed })).not.toContain('Synthetic private report');
  },
);

it('rejects stale conversation, changed heads, missing consent, foreign evidence, and purged evidence', async () => {
  const athleteId = randomUUID();
  const { thread, evidence, command, plan } = await seed(athleteId);
  const repo = repository();
  await expect(repo.create(athleteId, randomUUID(), command)).rejects.toMatchObject({
    code: 'THREAD_NOT_FOUND',
  });
  await expect(
    repo.create(athleteId, thread.id, { ...command, evidenceSnapshotId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
  await createCoachingThreadRepository(database).append(athleteId, thread.id, {
    expectedRevision: 1,
    message: 'New report',
    idempotencyKey: randomUUID(),
  });
  await expect(repo.create(athleteId, thread.id, command)).rejects.toMatchObject({
    code: 'CONVERSATION_REVISION_CONFLICT',
  });
  const newThread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: plan.id,
      title: 'Second',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Second',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  const secondEvidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    newThread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...plan.draft, title: 'Changed head' },
  });
  await expect(
    repo.create(athleteId, newThread.id, {
      ...command,
      evidenceSnapshotId: secondEvidence.id,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    await createCoreEvidenceSnapshotRepository(database).read(athleteId, evidence.id),
  ).toMatchObject({
    status: 'purged',
    reason: 'consent_withdrawn',
  });
  await expect(
    repo.create(athleteId, newThread.id, {
      ...command,
      evidenceSnapshotId: secondEvidence.id,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
  const receipts = await database.tenant(athleteId, (tx) =>
    tx.query(
      "SELECT count(*)::integer AS n FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'coaching:run:%'",
      [athleteId],
    ),
  );
  expect(receipts.rows[0]?.['n']).toBe(0);
});

it('erases attempts before evidence and blocks tenant resurrection', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const repo = repository();
  const run = await repo.create(athleteId, thread.id, command);
  await createOperationsRepository(database).eraseAccount(athleteId);
  await expect(repo.read(athleteId, run.id)).rejects.toBeInstanceOf(TenantErasedError);
});

it('claims only coaching jobs and persists one untrusted fixture output without a decision', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  await database.tenant(athleteId, (tx) =>
    enqueue(tx, {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      topic: 'unrelated.event',
      payload: { kind: 'unrelated' },
    }).then(() => undefined),
  );
  expect(
    await runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: createDeterministicFixtureAdapter('synthetic-v1'),
    }),
  ).toBe('stored');
  const updated = await repository().read(athleteId, run.id);
  expect(updated?.status.kind).toBe('analysis_ready');
  const outputId = updated?.status.kind === 'analysis_ready' ? updated.status.outputId : null;
  const fixtureContent = expect.objectContaining({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    intent: {
      kind: 'set_session_duration_seconds',
      sessionId: 'session',
      durationSeconds: 2100,
    },
    summary: 'Synthetic fixture duration proposal; not validated or approved.',
  });
  const result = await database.tenant(athleteId, (tx) =>
    tx.query(
      `SELECT o.id,o.body,r.status,
       (SELECT count(*)::integer FROM outbox WHERE athlete_id=$1 AND topic='unrelated.event'
        AND completed_at IS NULL) AS unrelated_pending
       FROM coaching_analysis_output o JOIN coaching_run r
        ON r.athlete_id=o.athlete_id AND r.id=o.run_id
       WHERE o.athlete_id=$1 AND o.run_id=$2`,
      [athleteId, run.id],
    ),
  );
  expect(result.rows).toEqual([
    expect.objectContaining({
      id: outputId,
      body: {
        schemaVersion: 1,
        content: fixtureContent,
      },
      unrelated_pending: 1,
    }),
  ]);
  const readOutput = await repository().readOutput(athleteId, run.id);
  expect(readOutput).toMatchObject({
    schemaVersion: 1,
    runId: run.id,
    outputId,
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    trust: 'untrusted_fixture',
    validation: 'unvalidated',
    content: fixtureContent,
  });
  coachingFixtureCandidateContentV1Schema.parse(readOutput?.content);
  expect(await repository().readOutput(randomUUID(), run.id)).toBeNull();
  expect(await repository().readOutput(athleteId, randomUUID())).toBeNull();
  expect(
    await createCoachingRunRepository(database, {
      policy: { id: 'running-core-v2-training', version: '2' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    }).readOutput(athleteId, run.id),
  ).toBeNull();
  await createCoachingThreadRepository(database).append(athleteId, thread.id, {
    expectedRevision: 1,
    message: 'Changed synthetic context after analysis',
    idempotencyKey: randomUUID(),
  });
  expect(await repository().readOutput(athleteId, run.id)).toBeNull();
  await repository().cancel(athleteId, run.id);
  expect(await repository().readOutput(athleteId, run.id)).toBeNull();
  expect(await workerStore().claim(athleteId)).toBeNull();
  await expect(
    workerDatabase.tenant(athleteId, (tx) =>
      tx.query('SELECT body FROM coaching_analysis_output WHERE athlete_id=$1', [athleteId]),
    ),
  ).rejects.toThrow();
});

it.each(['consent_withdrawn', 'source_deleted'] as const)(
  'hides and scrubs completed fixture output after %s',
  async (purgeReason) => {
    const athleteId = randomUUID();
    const { thread, evidence, command } = await seed(athleteId);
    const repo = repository();
    const run = await repo.create(athleteId, thread.id, command);
    expect(
      await runOneCoachingJob({
        athleteId,
        store: workerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    expect(await repo.readOutput(athleteId, run.id)).not.toBeNull();
    if (purgeReason === 'consent_withdrawn') {
      await createConsentRepository(database).setConsent(athleteId, {
        kind: 'ai',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    } else {
      const owner = await admin.connect();
      try {
        await owner.query('BEGIN');
        await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
        await owner.query(
          `UPDATE core_evidence_snapshot SET body=NULL,purged_reason='source_deleted'
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, evidence.id],
        );
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      } finally {
        owner.release();
      }
    }
    expect(await repo.readOutput(athleteId, run.id)).toBeNull();
    expect((await repo.read(athleteId, run.id))?.status).toEqual({
      kind: 'cancelled',
      reason: purgeReason,
    });
  },
);

it('does not claim another tenant’s event', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  expect(await workerStore().claim(randomUUID())).toBeNull();
  expect((await repository().read(athleteId, run.id))?.status).toEqual({ kind: 'queued' });
});

it('acknowledges the sixth claim as a bounded terminal failure without calling the adapter', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  await database.tenant(athleteId, (tx) =>
    tx
      .query(
        `UPDATE outbox SET attempts=5 WHERE athlete_id=$1 AND topic='coaching.run_queued'
       AND payload->>'runId'=$2`,
        [athleteId, run.id],
      )
      .then(() => undefined),
  );
  let called = false;
  expect(
    await runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: {
        evaluate: async () => {
          called = true;
          return { kind: 'analysis', content: {} };
        },
      },
    }),
  ).toBe('skipped');
  expect(called).toBe(false);
  expect((await repository().read(athleteId, run.id))?.status).toEqual({
    kind: 'unable_to_evaluate',
    code: 'internal_error',
    reason: 'Evaluation could not be completed',
  });
  expect(await workerStore().claim(athleteId)).toBeNull();
});

it('rejects a policy version change before evaluation and after an in-flight evaluation', async () => {
  const beforeAthlete = randomUUID();
  const beforeSeed = await seed(beforeAthlete);
  const beforeRun = await repository().create(
    beforeAthlete,
    beforeSeed.thread.id,
    beforeSeed.command,
  );
  const changed = () => ({ id: 'running-core-v2-training', version: '2' });
  expect(
    await runOneCoachingJob({
      athleteId: beforeAthlete,
      store: workerStore(workerDatabase, 120, changed),
      adapter: {
        evaluate: async () => {
          throw new Error('ADAPTER_MUST_NOT_RUN');
        },
      },
    }),
  ).toBe('skipped');
  expect((await repository().read(beforeAthlete, beforeRun.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'stale_basis',
  });

  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  let version = '1';
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runOneCoachingJob({
    athleteId,
    store: workerStore(workerDatabase, 120, () => ({ id: 'running-core-v2-training', version })),
    adapter: {
      evaluate: async () => {
        enter();
        await held;
        return { kind: 'analysis', content: { summary: 'Discard after policy change' } };
      },
    },
  });
  await entered;
  version = '2';
  release();
  expect(await pending).toBe('skipped');
  expect((await repository().read(athleteId, run.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'stale_basis',
  });
});

it.each(['throw', 'malformed', 'oversized', 'jsonb_expansion'] as const)(
  'maps %s adapter output to a bounded terminal failure without saving output',
  async (kind) => {
    const athleteId = randomUUID();
    const { thread, command } = await seed(athleteId);
    const run = await repository().create(athleteId, thread.id, command);
    expect(
      await runOneCoachingJob({
        athleteId,
        store: workerStore(),
        adapter: {
          evaluate: async () => {
            if (kind === 'throw') throw new Error('Synthetic secret that must not be persisted');
            if (kind === 'malformed') return { kind: 'analysis', content: undefined };
            if (kind === 'jsonb_expansion') {
              const content = Array(400_000).fill(0);
              expect(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, content }))).toBeLessThan(
                1_000_000,
              );
              return { kind: 'analysis', content };
            }
            return { kind: 'analysis', content: { text: 'x'.repeat(1_000_001) } };
          },
        },
      }),
    ).toBe('stored');
    expect((await repository().read(athleteId, run.id))?.status).toEqual({
      kind: 'unable_to_evaluate',
      code: kind === 'throw' ? 'provider_unavailable' : 'invalid_output',
      reason:
        kind === 'throw' ? 'Evaluation could not be completed' : 'Model output could not be used',
    });
    const output = await database.tenant(athleteId, (tx) =>
      tx.query(
        'SELECT count(*)::integer AS n FROM coaching_analysis_output WHERE athlete_id=$1 AND run_id=$2',
        [athleteId, run.id],
      ),
    );
    expect(output.rows[0]?.['n']).toBe(0);
  },
);

it('stores a bounded clarification question as terminal metadata without an analysis output', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  expect(
    await runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: {
        evaluate: async () => ({
          kind: 'needs_question',
          question: 'Please clarify the synthetic training goal.',
        }),
      },
    }),
  ).toBe('stored');
  expect((await repository().read(athleteId, run.id))?.status).toEqual({
    kind: 'needs_question',
    question: 'Please clarify the synthetic training goal.',
  });
  expect(await workerStore().claim(athleteId)).toBeNull();
});

it('fails the preflight before invoking an adapter when the conversation changed', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  await createCoachingThreadRepository(database).append(athleteId, thread.id, {
    expectedRevision: 1,
    message: 'Changed synthetic report',
    idempotencyKey: randomUUID(),
  });
  expect(
    await runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: {
        evaluate: async () => {
          throw new Error('ADAPTER_MUST_NOT_RUN');
        },
      },
    }),
  ).toBe('skipped');
  expect((await repository().read(athleteId, run.id))?.status).toEqual({
    kind: 'cancelled',
    reason: 'stale_basis',
  });
});

it.each(['conversation', 'consent', 'cancel'] as const)(
  'discards in-flight output after %s changes during evaluation',
  async (change) => {
    const athleteId = randomUUID();
    const { thread, command } = await seed(athleteId);
    const run = await repository().create(athleteId, thread.id, command);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: {
        evaluate: async () => {
          enter();
          await held;
          return { kind: 'analysis', content: { summary: 'Must be discarded' } };
        },
      },
    });
    await entered;
    if (change === 'conversation') {
      await createCoachingThreadRepository(database).append(athleteId, thread.id, {
        expectedRevision: 1,
        message: 'Updated synthetic report',
        idempotencyKey: randomUUID(),
      });
    } else if (change === 'consent') {
      await createConsentRepository(database).setConsent(athleteId, {
        kind: 'ai',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    } else {
      await repository().cancel(athleteId, run.id);
    }
    release();
    expect(await pending).toBe('skipped');
    const current = await repository().read(athleteId, run.id);
    expect(current?.status).toEqual({
      kind: 'cancelled',
      reason:
        change === 'conversation'
          ? 'stale_basis'
          : change === 'consent'
            ? 'consent_withdrawn'
            : 'user_requested',
    });
    const output = await database.tenant(athleteId, (tx) =>
      tx.query(
        'SELECT count(*)::integer AS n FROM coaching_analysis_output WHERE athlete_id=$1 AND run_id=$2',
        [athleteId, run.id],
      ),
    );
    expect(output.rows[0]?.['n']).toBe(0);
  },
);

it('reclaims an expired lease and prevents the losing worker from writing output', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loser = runOneCoachingJob({
    athleteId,
    store: workerStore(),
    adapter: {
      evaluate: async () => {
        enter();
        await held;
        return { kind: 'analysis', content: { worker: 'loser' } };
      },
    },
  });
  await entered;
  await database.tenant(athleteId, (tx) =>
    tx
      .query(
        `UPDATE outbox SET lease_until=clock_timestamp()-interval '1 second'
      WHERE athlete_id=$1 AND topic='coaching.run_queued' AND payload->>'runId'=$2`,
        [athleteId, run.id],
      )
      .then(() => undefined),
  );
  expect(
    await runOneCoachingJob({
      athleteId,
      store: workerStore(),
      adapter: { evaluate: async () => ({ kind: 'analysis', content: { worker: 'winner' } }) },
    }),
  ).toBe('stored');
  release();
  expect(await loser).toBe('skipped');
  const output = await database.tenant(athleteId, (tx) =>
    tx.query('SELECT body FROM coaching_analysis_output WHERE athlete_id=$1 AND run_id=$2', [
      athleteId,
      run.id,
    ]),
  );
  expect(output.rows).toEqual([{ body: { schemaVersion: 1, content: { worker: 'winner' } } }]);
});

it('rolls output and status back when the bound outbox acknowledgement fails', async () => {
  const athleteId = randomUUID();
  const { thread, command } = await seed(athleteId);
  const run = await repository().create(athleteId, thread.id, command);
  const brokenDatabase: Database = {
    tenant: (owner, operation) =>
      workerDatabase.tenant(owner, (tx) =>
        operation({
          ...tx,
          query: (sql, values) =>
            sql.startsWith('UPDATE outbox SET completed_at')
              ? Promise.resolve({ rows: [], rowCount: 0 })
              : tx.query(sql, values),
        }),
      ),
    exclusiveTenant: workerDatabase.exclusiveTenant,
    close: workerDatabase.close,
  };
  await expect(
    runOneCoachingJob({
      athleteId,
      store: workerStore(brokenDatabase),
      adapter: createDeterministicFixtureAdapter('synthetic-v1'),
    }),
  ).rejects.toThrow('COACHING_WORKER_LEASE_LOST');
  expect((await repository().read(athleteId, run.id))?.status).toEqual({
    kind: 'running',
    stage: 'evaluating',
  });
  const output = await database.tenant(athleteId, (tx) =>
    tx.query(
      'SELECT count(*)::integer AS n FROM coaching_analysis_output WHERE athlete_id=$1 AND run_id=$2',
      [athleteId, run.id],
    ),
  );
  expect(output.rows[0]?.['n']).toBe(0);
});
