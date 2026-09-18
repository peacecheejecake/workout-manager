import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JointCoachingBasis } from '@workout/contracts/nutrition';
import type { NutritionPlanVersion } from '@workout/contracts/nutrition-core';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { createJointApprovalRepository } from '../src/joint-approval.js';
import {
  grantCoachingCandidates,
  grantCoachingRuns,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantNutritionCore,
  grantOperations,
  grantSupplementaryCore,
  migrate,
} from '../src/migrate.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCoachingConstraintRepository } from '../src/coaching-constraints.js';
import { createActivityRepository } from '../src/activities.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const policy = { id: 'joint-coaching-v3', version: '1' };
const repository = () => createJointApprovalRepository(database, { policy });
const happenedAt = '2026-09-18T08:00:00.000Z';
const countDefinition = {
  kind: 'repetitions' as const,
  basis: 'per_side' as const,
  definitionId: 'rep-per-side-v1',
};

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantSupplementaryCore(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await grantCoachingCandidates(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE ON consent,plan_snapshot,plan_head,plan_history,
      command_receipt,outbox,coaching_run TO workout_runtime`,
  );
  await admin.query('GRANT INSERT ON coaching_analysis_output TO workout_runtime');
  await admin.query(
    `GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,
      activity_overlay,activity_overlay_revision,activity_suppression,
      check_in,check_in_collection_head,session_completion,session_completion_collection_head,
      coaching_constraint_head TO workout_runtime`,
  );
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE ON coaching_constraint,coaching_constraint_head TO workout_runtime',
  );
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
      activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
      activity_import_receipt TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

function planDraft(): PlanDraft {
  return {
    title: 'Synthetic training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, all) => ({
      id: level,
      parentId: index === 0 ? null : (all[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Synthetic fixture',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session-1',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: '06:00',
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 5000,
        targetRpe: null,
        purpose: 'Synthetic',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
function mealDraft(trainingVersionId: string) {
  return {
    period: { from: '2080-01-01', toInclusive: '2080-01-31' },
    timezone: 'UTC',
    purpose: 'Training fuel',
    linkedTrainingPlanVersionId: trainingVersionId,
    items: [
      {
        id: randomUUID(),
        category: 'before' as const,
        title: 'Pre-session meal',
        anchor: {
          kind: 'relative' as const,
          entity: 'session' as const,
          entityId: 'session-1',
          point: 'start' as const,
          offsetMinutes: -30,
        },
        foods: [],
        targets: [],
        instructions: 'Prepare food',
        evidenceIds: [],
        source: 'user_confirmed' as const,
      },
    ],
  };
}
function proposedMeal(current: NutritionPlanVersion) {
  return {
    period: current.period,
    timezone: current.timezone,
    purpose: current.purpose,
    linkedTrainingPlanVersionId: current.linkedTrainingPlanVersionId,
    items: current.items.map(({ planVersionId: _planVersionId, ...item }) => item),
  };
}
function expectedBasis(
  training: PlanSnapshot,
  nutrition: NutritionPlanVersion,
  evidenceId: string,
  revisions: { activity: number; exercise: number; execution: number; sets: number },
): JointCoachingBasis {
  return {
    schemaVersion: 3,
    domains: {
      scope: 'combined',
      training: {
        planVersionId: training.id,
        activityDataRevision: revisions.activity,
        exerciseCatalogRevision: revisions.exercise,
      },
      nutrition: {
        planVersionId: nutrition.versionId,
        intakeDataRevision: 0,
        foodCatalogRevision: 0,
      },
    },
    contextDependencies: [
      { kind: 'supplementary-set-head', id: 'tenant', revision: String(revisions.sets) },
      {
        kind: 'supplementary-execution-head',
        id: 'tenant',
        revision: String(revisions.execution),
      },
      { kind: 'routine-catalog-head', id: 'tenant', revision: '0' },
      { kind: 'intake-head', id: 'tenant', revision: '0' },
      { kind: 'food-catalog-head', id: 'tenant', revision: '0' },
      { kind: 'activity-head', id: 'tenant', revision: String(revisions.activity) },
      { kind: 'session-completion-head', id: 'tenant', revision: '0' },
      { kind: 'check-in-head', id: 'tenant', revision: '0' },
      { kind: 'coaching-constraint-head', id: 'tenant', revision: '0' },
      { kind: 'ai-consent', id: 'tenant', revision: '1:true' },
    ],
    preferenceRevision: 0,
    constraintRevision: 0,
    conversationRevision: 1,
    policyVersion: '1',
    evidenceSnapshotId: evidenceId,
  };
}
async function seed(withSetPrerequisites = false) {
  const athleteId = randomUUID();
  const training = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: planDraft(),
  });
  const nutrition = await createNutritionRepository(database).savePlan(athleteId, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: mealDraft(training.id),
  });
  let setPrerequisites: { executionId: string; exerciseVersionId: string } | null = null;
  if (withSetPrerequisites) {
    const supplementary = createSupplementaryRepository(database);
    const exerciseVersionId = randomUUID();
    await supplementary.saveExercise(athleteId, {
      definition: {
        schemaVersion: 2,
        exerciseId: randomUUID(),
        versionId: exerciseVersionId,
        name: 'Single-leg balance',
        family: 'balance_stability',
        equipment: ['bodyweight'],
        tags: ['balance'],
        countDefinitions: [countDefinition],
        mediaAssetIds: [],
        resourceVersionIds: [],
        reviewState: 'unreviewed',
        description: 'User-defined movement',
        safetyNotes: '',
        supportedMetrics: ['count', 'effort'],
        createdAt: happenedAt,
      },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const activity = await createActivityRepository(database).createManualActivity(athleteId, {
      confirmed: true,
      activity: {
        title: 'Balance session',
        kind: 'strength',
        startedAt: happenedAt,
        durationSeconds: null,
        durationKind: 'unknown',
        timezone: 'UTC',
        distanceMeters: null,
      },
      report: { sessionRpe: null, note: null, planLink: null },
      idempotencyKey: randomUUID(),
    });
    const executionId = randomUUID();
    await supplementary.createExecution(athleteId, {
      schemaVersion: 2,
      executionId,
      plannedSession: null,
      activity: { kind: 'match_existing', activityId: activity.activityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    setPrerequisites = { executionId, exerciseVersionId };
  }
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: training.id,
      title: 'Joint fixture',
      scope: { kind: 'session', targetId: 'session-1' },
      message: 'Review training and food together',
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
  const runId = randomUUID();
  const outputId = randomUUID();
  const revisionRow = await database.tenant(athleteId, async (tx) => {
    const result = await tx.query(
      `SELECT activity_revision,exercise_revision,execution_revision,set_revision
         FROM integrated_dependency_head WHERE athlete_id=$1`,
      [athleteId],
    );
    return result.rows[0];
  });
  const basis = expectedBasis(training, nutrition, evidence.id, {
    activity: Number(revisionRow?.['activity_revision'] ?? 0),
    exercise: Number(revisionRow?.['exercise_revision'] ?? 0),
    execution: Number(revisionRow?.['execution_revision'] ?? 0),
    sets: Number(revisionRow?.['set_revision'] ?? 0),
  });
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,
        policy,source,basis,status) VALUES($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [
        athleteId,
        runId,
        thread.id,
        evidence.id,
        JSON.stringify(policy),
        JSON.stringify({ kind: 'deterministic_fixture', fixtureId: 'joint-v3' }),
        JSON.stringify(basis),
        JSON.stringify({ kind: 'analysis_ready', outputId }),
      ],
    );
    await tx.query(
      'INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athleteId, outputId, runId, JSON.stringify({ fixture: 'joint-v3' })],
    );
  });
  const captured = await repository().capture(athleteId, runId, 'combined', [nutrition.planId]);
  expect(captured.basis).toEqual(basis);
  return { athleteId, training, nutrition, runId, captured, setPrerequisites };
}
async function prepare(data: Awaited<ReturnType<typeof seed>>, invalidFood = false) {
  const proposed = structuredClone(data.training.draft);
  proposed.title = 'Adjusted plan';
  const session = proposed.sessions[0];
  if (!session) throw new Error('Missing fixture session');
  session.date = '2080-01-03';
  const foodVersionId = randomUUID();
  const meal = proposedMeal(data.nutrition);
  if (invalidFood) {
    const item = meal.items[0];
    if (!item) throw new Error('Missing fixture meal');
    item.foods.push({
      foodVersionId,
      description: 'Missing food',
      quantity: null,
      unit: 'unspecified',
      sourceBasis: 'unknown',
    });
  }
  return repository().prepareInternal(data.athleteId, {
    runId: data.runId,
    expectedBasis: data.captured.basis,
    expectedNutritionPlanHeads: data.captured.nutritionPlanHeads,
    training: { proposed, supplementaryLinks: [] },
    nutrition: [{ planId: data.nutrition.planId, proposed: meal }],
    idempotencyKey: randomUUID(),
  });
}
function approval(candidate: Awaited<ReturnType<typeof prepare>>, idempotencyKey = randomUUID()) {
  return {
    schemaVersion: 3 as const,
    confirmed: true as const,
    proposalId: candidate.proposalId,
    candidateId: candidate.id,
    proposalDigest: candidate.digest,
    expectedBasis: candidate.basis,
    idempotencyKey,
  };
}
async function counts(athleteId: string) {
  return database.tenant(
    athleteId,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) AS plans,
       (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS nutrition,
       (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='joint.candidate_approved') AS approvals,
       (SELECT count(*)::int FROM intake_entry WHERE athlete_id=$1) AS intakes`,
          [athleteId],
        )
      ).rows[0],
  );
}

describe('M1b-03 V022-A30–A32 atomic joint approval', () => {
  it('keeps only a prepare digest after consent purge while preserving replay and conflict checks', async () => {
    const data = await seed();
    const trainingText = `Private training proposal ${randomUUID()}`;
    const nutritionText = `Private nutrition proposal ${randomUUID()}`;
    const proposed = structuredClone(data.training.draft);
    proposed.title = trainingText;
    const meal = proposedMeal(data.nutrition);
    const item = meal.items[0];
    if (!item) throw new Error('Missing fixture meal');
    item.instructions = nutritionText;
    const command = {
      runId: data.runId,
      expectedBasis: data.captured.basis,
      expectedNutritionPlanHeads: data.captured.nutritionPlanHeads,
      training: { proposed, supplementaryLinks: [] },
      nutrition: [{ planId: data.nutrition.planId, proposed: meal }],
      idempotencyKey: randomUUID(),
    };
    const prepared = await repository().prepareInternal(data.athleteId, command);
    expect(await repository().prepareInternal(data.athleteId, command)).toEqual(prepared);
    const changedTraining = {
      ...command,
      training: { ...command.training, proposed: { ...proposed, title: 'Changed training' } },
    };
    await expect(
      repository().prepareInternal(data.athleteId, changedTraining),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const changedMeal = structuredClone(meal);
    const changedItem = changedMeal.items[0];
    if (!changedItem) throw new Error('Missing fixture meal');
    changedItem.instructions = 'Changed nutrition';
    const changedNutrition = {
      ...command,
      nutrition: [{ planId: data.nutrition.planId, proposed: changedMeal }],
    };
    await expect(
      repository().prepareInternal(data.athleteId, changedNutrition),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    await createConsentRepository(database).setConsent(data.athleteId, {
      kind: 'ai',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const persisted = await database.tenant(data.athleteId, async (tx) => {
      const receipts = await tx.query(
        `SELECT request FROM command_receipt
         WHERE athlete_id=$1 AND idempotency_key LIKE 'joint:prepare:%'`,
        [data.athleteId],
      );
      const bodies = await tx.query(
        `SELECT c.body AS candidate,p.body AS proposal,d.body AS decision,
                e.body AS evidence,o.body AS output
         FROM coaching_candidate c
         JOIN coaching_proposal p ON p.athlete_id=c.athlete_id AND p.id=c.proposal_id
         JOIN coaching_decision d ON d.athlete_id=p.athlete_id AND d.id=p.decision_id
         JOIN coaching_run r ON r.athlete_id=d.athlete_id AND r.id=d.run_id
         JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
         JOIN coaching_analysis_output o ON o.athlete_id=r.athlete_id AND o.run_id=r.id
         WHERE c.athlete_id=$1 AND c.id=$2`,
        [data.athleteId, prepared.id],
      );
      return { receipts: receipts.rows, bodies: bodies.rows };
    });
    expect(persisted.receipts).toHaveLength(1);
    expect(persisted.receipts[0]?.['request']).toEqual({
      kind: 'joint_prepare_v3',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(persisted)).not.toContain(trainingText);
    expect(JSON.stringify(persisted)).not.toContain(nutritionText);
    expect(persisted.bodies).toEqual([
      { candidate: null, proposal: null, decision: null, evidence: null, output: null },
    ]);
    await expect(repository().prepareInternal(data.athleteId, command)).rejects.toMatchObject({
      code: 'CANDIDATE_UNAVAILABLE',
    });
    await expect(
      repository().prepareInternal(data.athleteId, changedTraining),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('commits training and nutrition together and replays the original success', async () => {
    const data = await seed();
    const candidate = await prepare(data);
    expect(candidate.validation.status).toBe('checked');
    const command = approval(candidate);
    const first = await repository().approve(data.athleteId, command);
    expect(first.training?.version).toBe(2);
    expect(first.nutrition).toHaveLength(1);
    expect(first.nutrition[0]?.version).toBe(2);
    expect(first.nutrition[0]?.linkedTrainingPlanVersionId).toBe(first.training?.id);
    expect(await repository().approve(data.athleteId, command)).toEqual(first);
    expect(await counts(data.athleteId)).toMatchObject({
      plans: 2,
      nutrition: 2,
      approvals: 1,
      intakes: 0,
    });
  });

  it('rejects a changed intake dependency before any plan write', async () => {
    const data = await seed();
    const candidate = await prepare(data);
    const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
      value: null,
      unit,
      status: 'unknown' as const,
      evidenceIds: [],
    });
    await createNutritionRepository(database).createIntake(data.athleteId, {
      idempotencyKey: randomUUID(),
      intakeId: randomUUID(),
      confirmed: true,
      occurredAt: '2026-09-18T00:00:00Z',
      timezone: 'UTC',
      foods: [
        {
          foodVersionId: null,
          description: 'Unquantified meal',
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ],
      nutrientTotal: {
        energy: unknown('kcal'),
        carbohydrate: unknown('g'),
        protein: unknown('g'),
        fat: unknown('g'),
        fluid: unknown('mL'),
        sodium: unknown('mg'),
      },
      plannedItemId: null,
      relatedSessionIds: [],
      relatedActivityIds: [],
      source: 'user',
      sourceRecordId: null,
      notes: null,
    });
    await expect(repository().approve(data.athleteId, approval(candidate))).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    expect(await counts(data.athleteId)).toMatchObject({
      plans: 1,
      nutrition: 1,
      approvals: 0,
      intakes: 1,
    });
  });

  it('rejects a confirmed constraint change after proposal preparation', async () => {
    const data = await seed();
    const candidate = await prepare(data);
    await createCoachingConstraintRepository(database).create(data.athleteId, {
      expectedHeadRevision: null,
      confirmed: true,
      text: 'No training on Mondays',
      idempotencyKey: randomUUID(),
    });
    await expect(repository().approve(data.athleteId, approval(candidate))).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    expect(await counts(data.athleteId)).toMatchObject({ plans: 1, nutrition: 1, approvals: 0 });
  });

  it('rejects an actual supplementary set logged after proposal preparation', async () => {
    const data = await seed(true);
    const candidate = await prepare(data);
    const prerequisites = data.setPrerequisites;
    if (!prerequisites) throw new Error('Missing set prerequisites');
    await createSupplementaryRepository(database).createSetLog(data.athleteId, {
      schemaVersion: 2,
      executionId: prerequisites.executionId,
      logId: randomUUID(),
      expectedExecutionRevision: 1,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed',
      values: {
        targetSetId: null,
        blockId: null,
        roundIndex: null,
        exerciseVersionId: prerequisites.exerciseVersionId,
        side: 'left',
        state: 'partial',
        count: {
          actual: { value: 4, unit: 'count', status: 'reported', evidenceIds: [] },
          definition: countDefinition,
        },
        durationSeconds: { value: null, unit: 's', status: 'unknown', evidenceIds: [] },
        externalResistance: { kind: 'no_added_load' },
        effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
        occurredAt: happenedAt,
        reason: null,
      },
    });
    await expect(repository().approve(data.athleteId, approval(candidate))).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    expect(await counts(data.athleteId)).toMatchObject({ plans: 1, nutrition: 1, approvals: 0 });
  });

  it('serializes two requests for the same candidate and replays only the matching key', async () => {
    const data = await seed();
    const candidate = await prepare(data);
    const command = approval(candidate);
    const settled = await Promise.allSettled([
      repository().approve(data.athleteId, command),
      repository().approve(data.athleteId, command),
    ]);
    expect(settled.every((item) => item.status === 'fulfilled')).toBe(true);
    if (settled[0]?.status !== 'fulfilled' || settled[1]?.status !== 'fulfilled') return;
    expect(settled[1].value).toEqual(settled[0].value);
    expect(await counts(data.athleteId)).toMatchObject({ plans: 2, nutrition: 2, approvals: 1 });
  });

  it('allows only one winner when different keys race to approve the same candidate', async () => {
    const data = await seed();
    const candidate = await prepare(data);
    const settled = await Promise.allSettled([
      repository().approve(data.athleteId, approval(candidate)),
      repository().approve(data.athleteId, approval(candidate)),
    ]);
    const won = settled.filter((item) => item.status === 'fulfilled');
    const lost = settled.filter((item) => item.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    if (lost[0]?.status === 'rejected')
      expect(lost[0].reason).toMatchObject({ code: 'STALE_BASIS' });
    expect(await counts(data.athleteId)).toMatchObject({ plans: 2, nutrition: 2, approvals: 1 });
  });

  it('rolls back the training version when nutrition persistence fails', async () => {
    const data = await seed();
    const candidate = await prepare(data, true);
    await expect(repository().approve(data.athleteId, approval(candidate))).rejects.toMatchObject({
      code: 'NUTRITION_REFERENCE_INVALID',
    });
    expect(await counts(data.athleteId)).toMatchObject({
      plans: 1,
      nutrition: 1,
      approvals: 0,
      intakes: 0,
    });
  });

  it('persists a fresh training-only partial as a distinct candidate before approval', async () => {
    const data = await seed();
    const parent = await prepare(data);
    const selected = await repository().derivePartial(data.athleteId, parent.id, {
      selection: {
        includeTrainingTitle: true,
        trainingPeriodIds: [],
        trainingSessionIds: [],
        nutritionPlanIds: [],
      },
      idempotencyKey: randomUUID(),
    });
    expect(selected.parentCandidateId).toBe(parent.id);
    expect(selected.writes.scope).toBe('training');
    expect(selected.digest).not.toBe(parent.digest);
    const result = await repository().approve(data.athleteId, approval(selected));
    expect(result.training?.draft.title).toBe('Adjusted plan');
    expect(result.training?.draft.sessions[0]?.date).toBe('2080-01-02');
    expect(result.nutrition).toEqual([]);
  });
});
