import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
  type CoachingEvaluationAdapter,
} from '@workout/server-coaching/runner';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantCoachingCandidates,
  grantCoachingConstraints,
  grantCoachingRuns,
  grantCoachingRunWorker,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantOperations,
  migrate,
} from '../src/migrate.js';
import {
  createTrainingCandidateRepository,
  digestTrainingCandidate,
} from '../src/coaching-candidates.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoachingConstraintRepository } from '../src/coaching-constraints.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let workerDatabase: Database;
const policy = { id: 'running-core-v2-training', version: '1' };
const source = { kind: 'deterministic_fixture' as const, fixtureId: 'synthetic-v1' };

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await grantCoachingCandidates(adminUrl, 'workout_runtime');
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
  workerDatabase = createDatabase({ connectionString: workerUrl.toString(), max: 4 });
});
afterAll(async () => {
  await database?.close();
  await workerDatabase?.close();
  await admin.end();
});

const candidates = () => createTrainingCandidateRepository(database, { policy, source });
const runs = () => createCoachingRunRepository(database, { policy, source });
function plan(): PlanDraft {
  return {
    title: 'Synthetic training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Maintain the training purpose',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Endurance',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
const strategy = {
  summary: 'Private strategy receipt marker',
  preservedIntent: 'Keep the endurance purpose',
  rationale: 'Fixture-only structural comparison',
  unconfirmedInformation: ['Current recovery is unknown'],
  revisitWhen: 'Review before the planned session',
};
async function seed(
  athleteId: string,
  adapter: CoachingEvaluationAdapter = createDeterministicFixtureAdapter('synthetic-v1'),
) {
  const savedPlan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: plan(),
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: savedPlan.id,
      title: 'Synthetic coaching',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic private input',
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
  const run = await runs().create(athleteId, thread.id, {
    schemaVersion: 1,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(
    await runOneCoachingJob({
      athleteId,
      store: createCoachingRunWorkerStore(workerDatabase, { policy, source }),
      adapter,
    }),
  ).toBe('stored');
  expect((await runs().read(athleteId, run.id))?.status.kind).toBe('analysis_ready');
  return { savedPlan, thread, evidence, run };
}

async function candidateRowCounts(athleteId: string) {
  return database.tenant(athleteId, async (tx) => {
    const rows = await tx.query(
      `SELECT (SELECT count(*)::integer FROM coaching_decision WHERE athlete_id=$1) AS decisions,
        (SELECT count(*)::integer FROM coaching_proposal WHERE athlete_id=$1) AS proposals,
        (SELECT count(*)::integer FROM coaching_candidate WHERE athlete_id=$1) AS candidates`,
      [athleteId],
    );
    return rows.rows[0];
  });
}
function command(runId: string) {
  const proposed = structuredClone(plan());
  proposed.title = 'Private proposed plan receipt marker';
  const session = proposed.sessions[0];
  if (!session) throw new Error('Fixture session missing');
  session.durationSeconds = 2100;
  return { runId, proposed, strategy, idempotencyKey: randomUUID() };
}

async function expectMinimalCandidateReceipt(athleteId: string, candidateId: string) {
  await database.tenant(athleteId, async (tx) => {
    const receipts = await tx.query(
      "SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'coaching:candidate:%'",
      [athleteId],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toEqual({
      request: { requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      result: { candidateId },
    });
    const serialized = JSON.stringify(receipts.rows[0]);
    expect(serialized).not.toContain('Private strategy receipt marker');
    expect(serialized).not.toContain('Private proposed plan receipt marker');
  });
}

it('seals one tenant-owned candidate atomically and replays concurrent requests without a plan write', async () => {
  const athleteId = randomUUID();
  const { savedPlan, run } = await seed(athleteId);
  const repo = candidates();
  const input = command(run.id);
  const [first, replay] = await Promise.all([
    repo.create(athleteId, input),
    repo.create(athleteId, input),
  ]);
  expect(replay).toEqual(first);
  await expectMinimalCandidateReceipt(athleteId, first.candidate.id);
  expect(first.candidate).toMatchObject({
    runId: run.id,
    proposalId: first.proposal.id,
    decisionId: first.decision.id,
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    validation: { status: 'checked', errors: [] },
  });
  expect(first.candidate.before.id).toBe(savedPlan.id);
  const unsealed = first.candidate;
  const reordered = {
    validation: unsealed.validation,
    diff: unsealed.diff,
    strategy: unsealed.strategy,
    asOfLocalDate: unsealed.asOfLocalDate,
    proposed: {
      sessions: unsealed.proposed.sessions,
      periods: unsealed.proposed.periods,
      title: unsealed.proposed.title,
      timezone: unsealed.proposed.timezone,
    },
    before: unsealed.before,
    basis: unsealed.basis,
    scope: unsealed.scope,
    schemaVersion: unsealed.schemaVersion,
  };
  const ids = {
    runId: run.id,
    decisionId: first.decision.id,
    proposalId: first.proposal.id,
    candidateId: first.candidate.id,
  };
  expect(digestTrainingCandidate({ ...ids, draft: reordered })).toBe(first.candidate.digest);
  expect(digestTrainingCandidate({ ...ids, candidateId: randomUUID(), draft: reordered })).not.toBe(
    first.candidate.digest,
  );
  expect(await createPlanningRepository(database).read(athleteId)).toMatchObject({
    head: { id: savedPlan.id, version: savedPlan.version },
  });
  expect((await runs().read(athleteId, run.id))?.status).toEqual({
    kind: 'validated_final',
    decisionId: first.decision.id,
  });
  expect(await repo.read(athleteId, first.candidate.id)).toEqual(first);
  expect(await repo.list(athleteId, run.id)).toEqual([first]);
  expect(await repo.read(randomUUID(), first.candidate.id)).toBeNull();
  expect(await repo.list(randomUUID(), run.id)).toEqual([]);
  await expect(repo.create(athleteId, { ...input, proposed: plan() })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await database.tenant(randomUUID(), async (tx) => {
    const foreign = await tx.query('SELECT id FROM coaching_candidate WHERE id=$1', [
      first.candidate.id,
    ]);
    expect(foreign.rows).toEqual([]);
  });
  await expect(
    database.tenant(athleteId, (tx) =>
      tx.query('UPDATE coaching_candidate SET digest=$3 WHERE athlete_id=$1 AND id=$2', [
        athleteId,
        first.candidate.id,
        'b'.repeat(64),
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    database.tenant(athleteId, (tx) =>
      tx.query('DELETE FROM coaching_candidate WHERE athlete_id=$1 AND id=$2', [
        athleteId,
        first.candidate.id,
      ]),
    ),
  ).rejects.toThrow();
});

it('derives a sealed candidate from the stored fixture instruction with one scoped duration change', async () => {
  const athleteId = randomUUID();
  const { savedPlan, run } = await seed(athleteId);
  const repo = candidates();
  const input = { runId: run.id, idempotencyKey: randomUUID() };
  const injected = { ...input, proposed: plan(), strategy };
  expect(() => repo.createFromFixture(athleteId, injected)).toThrowError('Unrecognized keys');
  const [first, replay] = await Promise.all([
    repo.createFromFixture(athleteId, input),
    repo.createFromFixture(athleteId, input),
  ]);
  expect(replay).toEqual(first);
  expect(first.candidate.before.id).toBe(savedPlan.id);
  expect(first.candidate.proposed).toEqual({
    ...savedPlan.draft,
    sessions: savedPlan.draft.sessions.map((session) => ({
      ...session,
      durationSeconds: session.id === 'session' ? 2100 : session.durationSeconds,
    })),
  });
  expect(first.candidate.diff.sessionChanges).toEqual([
    expect.objectContaining({ id: 'session', kind: 'modified' }),
  ]);
  expect(first.candidate.validation).toMatchObject({ status: 'checked', errors: [] });
  expect(await repo.read(athleteId, first.candidate.id)).toEqual(first);
  expect(await repo.read(randomUUID(), first.candidate.id)).toBeNull();
  expect(await repo.list(randomUUID(), run.id)).toEqual([]);
  expect(await createPlanningRepository(database).read(athleteId)).toMatchObject({
    head: { id: savedPlan.id, version: savedPlan.version },
  });
  await database.tenant(athleteId, async (tx) => {
    const receipts = await tx.query(
      "SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'coaching:candidate:fixture:%'",
      [athleteId],
    );
    expect(receipts.rows).toEqual([
      {
        request: { requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        result: { candidateId: first.candidate.id },
      },
    ]);
    expect(JSON.stringify(receipts.rows)).not.toContain('Synthetic duration alternative');
    expect(JSON.stringify(receipts.rows)).not.toContain('Synthetic fixture duration proposal');
  });
  await expect(
    repo.createFromFixture(athleteId, { ...input, runId: randomUUID() }),
  ).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(await candidateRowCounts(athleteId)).toEqual({
    decisions: 1,
    proposals: 1,
    candidates: 1,
  });
});

it('rejects a malformed stored fixture before any decision or plan write', async () => {
  const athleteId = randomUUID();
  const { savedPlan, run } = await seed(athleteId, {
    async evaluate() {
      return {
        kind: 'analysis',
        content: {
          schemaVersion: 1,
          scope: 'running-core-v2-training',
          intent: {
            kind: 'set_session_duration_seconds',
            sessionId: 'missing',
            durationSeconds: 2100,
          },
          strategy,
          summary: 'Synthetic fixture duration proposal; not validated or approved.',
          extra: 'untrusted output must be rejected',
        },
      };
    },
  });
  await expect(
    candidates().createFromFixture(athleteId, { runId: run.id, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'INVALID_FIXTURE_OUTPUT' });
  expect(await candidateRowCounts(athleteId)).toEqual({
    decisions: 0,
    proposals: 0,
    candidates: 0,
  });
  expect((await runs().read(athleteId, run.id))?.status.kind).toBe('analysis_ready');
  expect((await createPlanningRepository(database).read(athleteId))?.head?.id).toBe(savedPlan.id);
});

it('rejects a well-shaped fixture instruction that names no pinned session', async () => {
  const athleteId = randomUUID();
  const { run } = await seed(athleteId, {
    async evaluate() {
      return {
        kind: 'analysis',
        content: {
          schemaVersion: 1,
          scope: 'running-core-v2-training',
          intent: {
            kind: 'set_session_duration_seconds',
            sessionId: 'missing',
            durationSeconds: 2100,
          },
          strategy,
          summary: 'Synthetic fixture duration proposal; not validated or approved.',
        },
      };
    },
  });
  await expect(
    candidates().createFromFixture(athleteId, { runId: run.id, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'INVALID_FIXTURE_OUTPUT' });
  expect(await candidateRowCounts(athleteId)).toEqual({
    decisions: 0,
    proposals: 0,
    candidates: 0,
  });
});

it('rejects a fixture candidate when a non-plan head changes after analysis', async () => {
  const athleteId = randomUUID();
  const { run } = await seed(athleteId);
  await createCoachingConstraintRepository(database).create(athleteId, {
    expectedHeadRevision: null,
    confirmed: true,
    text: 'Synthetic scheduling constraint after fixture analysis',
    idempotencyKey: randomUUID(),
  });
  await expect(
    candidates().createFromFixture(athleteId, { runId: run.id, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  expect(await candidateRowCounts(athleteId)).toEqual({
    decisions: 0,
    proposals: 0,
    candidates: 0,
  });
});

it('serializes fixture candidate creation with consent withdrawal and never leaves a readable body', async () => {
  const athleteId = randomUUID();
  const { run } = await seed(athleteId);
  const outcomes = await Promise.allSettled([
    candidates().createFromFixture(athleteId, { runId: run.id, idempotencyKey: randomUUID() }),
    createConsentRepository(database).setConsent(athleteId, {
      kind: 'ai',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    }),
  ]);
  expect(outcomes[1]?.status).toBe('fulfilled');
  expect(await candidates().list(athleteId, run.id)).toEqual([]);
  const created = outcomes[0];
  if (created?.status === 'fulfilled') {
    expect(await candidates().read(athleteId, created.value.candidate.id)).toBeNull();
    await database.tenant(athleteId, async (tx) => {
      const rows = await tx.query(
        'SELECT body,digest,purged_reason FROM coaching_candidate WHERE athlete_id=$1 AND id=$2',
        [athleteId, created.value.candidate.id],
      );
      expect(rows.rows).toEqual([{ body: null, digest: null, purged_reason: 'consent_withdrawn' }]);
    });
  } else {
    expect(created?.reason).toMatchObject({ code: expect.any(String) });
    expect(await candidateRowCounts(athleteId)).toEqual({
      decisions: 0,
      proposals: 0,
      candidates: 0,
    });
  }
});

it('refuses stale context before sealing and leaves no partial decision, proposal or candidate', async () => {
  const athleteId = randomUUID();
  const { savedPlan, run } = await seed(athleteId);
  const proposed = structuredClone(savedPlan.draft);
  proposed.title = 'Changed manual plan';
  await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: savedPlan.id,
    idempotencyKey: randomUUID(),
    draft: proposed,
  });
  await expect(candidates().create(athleteId, command(run.id))).rejects.toMatchObject({
    code: 'STALE_BASIS',
  });
  expect((await runs().read(athleteId, run.id))?.status.kind).toBe('analysis_ready');
  await database.tenant(athleteId, async (tx) => {
    for (const table of ['coaching_decision', 'coaching_proposal', 'coaching_candidate']) {
      const count = await tx.query(
        `SELECT count(*)::integer AS count FROM ${table} WHERE athlete_id=$1`,
        [athleteId],
      );
      expect(count.rows[0]?.['count']).toBe(0);
    }
  });
});

it('rejects a changed non-plan dependency before sealing', async () => {
  const athleteId = randomUUID();
  const { run } = await seed(athleteId);
  await createCoachingConstraintRepository(database).create(athleteId, {
    expectedHeadRevision: null,
    confirmed: true,
    text: 'Synthetic newly confirmed scheduling constraint',
    idempotencyKey: randomUUID(),
  });
  await expect(candidates().create(athleteId, command(run.id))).rejects.toMatchObject({
    code: 'STALE_BASIS',
  });
  expect((await runs().read(athleteId, run.id))?.status.kind).toBe('analysis_ready');
});

it('scrubs all sealed bodies and digest after consent withdrawal while retaining only redacted metadata', async () => {
  const athleteId = randomUUID();
  const { run } = await seed(athleteId);
  const input = command(run.id);
  const created = await candidates().create(athleteId, input);
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await candidates().read(athleteId, created.candidate.id)).toBeNull();
  expect(await candidates().list(athleteId, run.id)).toEqual([]);
  await expectMinimalCandidateReceipt(athleteId, created.candidate.id);
  await expect(candidates().create(athleteId, input)).rejects.toMatchObject({
    code: 'CANDIDATE_UNAVAILABLE',
  });
  await database.tenant(athleteId, async (tx) => {
    for (const table of ['coaching_decision', 'coaching_proposal', 'coaching_candidate']) {
      const result = await tx.query(
        `SELECT body,purged_reason${table === 'coaching_candidate' ? ',digest' : ''} FROM ${table} WHERE athlete_id=$1`,
        [athleteId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ body: null, purged_reason: 'consent_withdrawn' });
      if (table === 'coaching_candidate') expect(result.rows[0]?.['digest']).toBeNull();
    }
  });
});

it('scrubs source-derived bodies without leaving proposed text in the idempotency receipt', async () => {
  const athleteId = randomUUID();
  const { evidence, run } = await seed(athleteId);
  const input = command(run.id);
  const created = await candidates().create(athleteId, input);
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
  expect(await candidates().read(athleteId, created.candidate.id)).toBeNull();
  await expectMinimalCandidateReceipt(athleteId, created.candidate.id);
  await expect(candidates().create(athleteId, input)).rejects.toMatchObject({
    code: 'CANDIDATE_UNAVAILABLE',
  });
});
