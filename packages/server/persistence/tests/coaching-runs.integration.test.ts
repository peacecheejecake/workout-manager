import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import {
  grantCoachingConstraints,
  grantCoachingRuns,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantOperations,
  migrate,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCoachingRunRepository } from '../src/coaching-runs.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,command_receipt,outbox TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,check_in,session_completion,session_completion_collection_head,check_in_collection_head TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

const repository = () =>
  createCoachingRunRepository(database, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
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
        durationSeconds: null,
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
