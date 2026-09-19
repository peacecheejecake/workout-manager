import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  integratedCandidatePrepareV4Schema,
  type IntegratedCandidatePrepareV4,
} from '@workout/contracts/integrated-coaching';
import type {
  IntegratedApprovalV023,
  IntegratedCoachingBasisV023,
} from '@workout/contracts/routines';
import { createDatabase, type Database } from '../src/database.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createIntegratedApprovalV4Repository } from '../src/integrated-approval-v4.js';
import {
  grantCoachingThreads,
  grantCoachingConstraints,
  grantCoreEvidenceSnapshots,
  grantCheckIns,
  grantIntegratedApprovalV4,
  grantNutritionCore,
  grantOperations,
  grantRecoveryCore,
  grantRoutineCore,
  grantSessionCompletions,
  migrate,
} from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const repository = () =>
  createIntegratedApprovalV4Repository(database, { policyVersion: 'v4-test' });

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantRoutineCore(adminUrl, 'workout_runtime');
  await grantRecoveryCore(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await grantSessionCompletions(adminUrl, 'workout_runtime');
  await grantIntegratedApprovalV4(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE ON consent,plan_snapshot,plan_head,plan_history,
      command_receipt,outbox,activity_canonical,activity_source_head,activity_source_revision,
      activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime`,
  );
  await admin.query(
    `GRANT SELECT ON coaching_constraint_head,check_in_collection_head,
      session_completion_collection_head,integrated_dependency_head TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const planDraft = (title: string) => ({
  title,
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2080-01-01',
    endDateExclusive: '2080-02-01',
    timezone: 'UTC',
    intent: 'fixture',
    isPartial: false,
  })),
  sessions: [],
});

interface Seed {
  athleteId: string;
  planVersionId: string;
  evidenceId: string;
  threadId: string;
  blueprintId: string;
  blueprintVersionId: string;
}

async function seed(aiConsentGranted: boolean | null = true): Promise<Seed> {
  const athleteId = randomUUID();
  const planVersionId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const blueprintId = randomUUID();
  const blueprintVersionId = randomUUID();
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [athleteId, planVersionId, JSON.stringify(planDraft('Before'))],
    );
    await tx.query('INSERT INTO plan_head(athlete_id,aggregate_id,version_id) VALUES($1,$2,$2)', [
      athleteId,
      planVersionId,
    ]);
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [athleteId, planVersionId],
    );
    if (aiConsentGranted !== null)
      await tx.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',$2,1)", [
        athleteId,
        aiConsentGranted,
      ]);
    await tx.query(
      `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision)
       VALUES($1,$2,$3,'v4 fixture','{"kind":"block","targetId":"block"}'::jsonb,1)`,
      [athleteId, threadId, planVersionId],
    );
    await tx.query(
      `INSERT INTO coaching_message(athlete_id,id,thread_id,revision,content)
       VALUES($1,$2,$3,1,'Review all four domains')`,
      [athleteId, messageId, threadId],
    );
    const blueprint = {
      schemaVersion: 4,
      routineId: blueprintId,
      versionId: blueprintVersionId,
      title: 'Fixture routine',
      intent: 'atomic approval fixture',
      status: 'published',
      tags: [],
      steps: [],
      choiceGroups: [],
      estimatedDurationSeconds: 0,
      createdAt: '2080-01-01T00:00:00.000Z',
    };
    await tx.query(
      `INSERT INTO routine_blueprint_version
       (athlete_id,routine_id,version_id,version,previous_version_id,record_json,created_at)
       VALUES($1,$2,$3,1,NULL,$4::jsonb,$5)`,
      [athleteId, blueprintId, blueprintVersionId, JSON.stringify(blueprint), blueprint.createdAt],
    );
    await tx.query(
      `INSERT INTO routine_blueprint_head
       (athlete_id,routine_id,version_id,version,visibility) VALUES($1,$2,$3,1,'active')`,
      [athleteId, blueprintId, blueprintVersionId],
    );
  });
  const snapshot = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    threadId,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-02-01', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  if (snapshot.status !== 'available') throw new Error('Expected available evidence fixture');
  const evidenceId = snapshot.id;
  return { athleteId, planVersionId, evidenceId, threadId, blueprintId, blueprintVersionId };
}

async function basis(seedData: Seed): Promise<IntegratedCoachingBasisV023> {
  return database.tenant(seedData.athleteId, async (tx) => {
    const row =
      (
        await tx.query(
          `SELECT coalesce(intake_revision,0) intake,coalesce(activity_revision,0) activity,
         coalesce(execution_revision,0) execution,coalesce(set_revision,0) sets,
         coalesce(food_revision,0) food,coalesce(exercise_revision,0) exercise,
         coalesce(routine_revision,0) supplementary_routine,
         coalesce(routine_run_revision,0) routine_run,
         coalesce(routine_occurrence_revision,0) routine_occurrence,
         coalesce(routine_blueprint_revision,0) routine_blueprint,
         coalesce(recovery_action_revision,0) recovery_action,
         coalesce(recovery_method_revision,0) recovery_method
         FROM integrated_dependency_head WHERE athlete_id=$1`,
          [seedData.athleteId],
        )
      ).rows[0] ?? {};
    const dependency = (kind: string, value: unknown) => ({
      kind,
      id: 'tenant',
      revision: String(value ?? 0),
    });
    return {
      schemaVersion: 4,
      planHeads: [],
      contextDependencies: [
        dependency('activity-head', row['activity']),
        dependency('intake-head', row['intake']),
        dependency('supplementary-execution-head', row['execution']),
        dependency('supplementary-set-head', row['sets']),
        dependency('food-catalog-head', row['food']),
        dependency('exercise-catalog-head', row['exercise']),
        dependency('routine-catalog-head', row['supplementary_routine']),
        dependency('routine-run-head', row['routine_run']),
        dependency('routine-occurrence-head', row['routine_occurrence']),
        dependency('routine-blueprint-head', row['routine_blueprint']),
        dependency('recovery-action-head', row['recovery_action']),
        dependency('recovery-method-head', row['recovery_method']),
        dependency('check-in-head', 0),
        dependency('session-completion-head', 0),
        dependency('coaching-constraint-head', 0),
        dependency('ai-consent', '1:true'),
      ],
      preferenceRevision: 0,
      constraintRevision: 0,
      conversationRevision: 1,
      policyVersion: 'v4-test',
      evidenceSnapshotId: seedData.evidenceId,
    };
  });
}

async function prepareInput(seedData: Seed, duplicateOccurrence = false) {
  const nutritionId = randomUUID();
  const recoveryId = randomUUID();
  const optionId = randomUUID();
  const scheduleId = randomUUID();
  const scheduleVersionId = randomUUID();
  const occurrence = {
    id: randomUUID(),
    schedule: { id: scheduleId, versionId: scheduleVersionId },
    blueprint: { id: seedData.blueprintId, versionId: seedData.blueprintVersionId },
    anchorKey: 'date:2080-01-03',
    scheduledAt: '2080-01-03T07:00:00.000Z',
    timingStatus: 'resolved' as const,
    stepBindings: [],
    selectedChoices: {},
  };
  const captured = await basis(seedData);
  captured.planHeads = [
    {
      domain: 'training',
      aggregateId: seedData.planVersionId,
      head: { kind: 'exists', versionId: seedData.planVersionId },
    },
    { domain: 'nutrition', aggregateId: nutritionId, head: { kind: 'absent' } },
    { domain: 'recovery', aggregateId: recoveryId, head: { kind: 'absent' } },
    { domain: 'routine_schedule', aggregateId: scheduleId, head: { kind: 'absent' } },
  ];
  return integratedCandidatePrepareV4Schema.parse({
    proposalId: randomUUID(),
    basis: captured,
    writes: [
      { domain: 'training', aggregateId: seedData.planVersionId, proposed: planDraft('After') },
      {
        domain: 'nutrition',
        aggregateId: nutritionId,
        proposed: {
          period: { from: '2080-01-01', toInclusive: '2080-01-31' },
          timezone: 'UTC',
          purpose: 'Fuel',
          linkedTrainingPlanVersionId: seedData.planVersionId,
          items: [],
        },
      },
      {
        domain: 'recovery',
        aggregateId: recoveryId,
        selectedOptionId: optionId,
        proposed: {
          title: 'Rest strategy',
          goal: 'Recover',
          startDate: '2080-01-01',
          endDateExclusive: '2080-01-08',
          timezone: 'UTC',
          knownFacts: [],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: [
            {
              kind: 'training',
              aggregateId: seedData.planVersionId,
              headVersionId: seedData.planVersionId,
            },
          ],
          options: [
            {
              id: optionId,
              title: 'Full rest',
              kind: 'full_rest',
              methodVersionId: null,
              explanation: 'No added action',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              plannedAt: null,
              description: 'Review after plan changes',
              policyVersion: 'v4-test',
            },
          ],
        },
      },
      {
        domain: 'routine_schedule',
        aggregateId: scheduleId,
        proposed: {
          schemaVersion: 4,
          id: scheduleId,
          versionId: scheduleVersionId,
          blueprint: { id: seedData.blueprintId, versionId: seedData.blueprintVersionId },
          window: {
            startDate: '2080-01-01',
            endDateExclusive: '2080-01-08',
            timezone: 'UTC',
            maxOccurrences: 2,
          },
          rule: { kind: 'dates', dates: ['2080-01-03'], localTime: '07:00' },
          state: 'active',
        },
        sourcePlanVersionId: seedData.planVersionId,
        occurrences: duplicateOccurrence
          ? [occurrence, { ...occurrence, id: randomUUID() }]
          : [occurrence],
      },
    ],
    summary: 'Four-domain adjustment',
    validation: { status: 'checked', errors: [], unknowns: [] },
    idempotencyKey: randomUUID(),
  } satisfies IntegratedCandidatePrepareV4);
}

function approval(
  candidate: Awaited<ReturnType<ReturnType<typeof repository>['prepareInternal']>>,
) {
  return {
    schemaVersion: 4 as const,
    confirmed: true as const,
    proposalId: candidate.proposalId,
    candidateId: candidate.id,
    proposalDigest: candidate.digest,
    writeDomains: ['training', 'nutrition', 'recovery', 'routine_schedule'],
    expectedBasis: candidate.basis,
    idempotencyKey: randomUUID(),
  } satisfies IntegratedApprovalV023;
}

describe('M1c-04 integrated approval v4 persistence', () => {
  it('captures the complete ordered basis from tenant-owned evidence', async () => {
    const fixture = await seed();
    const input = await prepareInput(fixture);
    const nutrition = input.writes.find((write) => write.domain === 'nutrition');
    const recovery = input.writes.find((write) => write.domain === 'recovery');
    const schedule = input.writes.find((write) => write.domain === 'routine_schedule');
    if (!nutrition || !recovery || !schedule) throw new Error('Missing aggregate fixture');
    const capture = {
      evidenceSnapshotId: fixture.evidenceId,
      trainingAggregateId: fixture.planVersionId,
      nutritionAggregateId: nutrition.aggregateId,
      recoveryAggregateId: recovery.aggregateId,
      routineScheduleAggregateId: schedule.aggregateId,
    };

    const captured = await repository().captureBasis(fixture.athleteId, capture);
    expect(captured).toEqual(input.basis);
    expect(captured).toMatchObject({
      conversationRevision: 1,
      preferenceRevision: 0,
      constraintRevision: 0,
      policyVersion: 'v4-test',
      evidenceSnapshotId: fixture.evidenceId,
    });
    expect(captured.planHeads).toEqual([
      {
        domain: 'training',
        aggregateId: fixture.planVersionId,
        head: { kind: 'exists', versionId: fixture.planVersionId },
      },
      { domain: 'nutrition', aggregateId: nutrition.aggregateId, head: { kind: 'absent' } },
      { domain: 'recovery', aggregateId: recovery.aggregateId, head: { kind: 'absent' } },
      {
        domain: 'routine_schedule',
        aggregateId: schedule.aggregateId,
        head: { kind: 'absent' },
      },
    ]);
    expect(captured.contextDependencies.map((item) => item.kind)).toEqual([
      'activity-head',
      'intake-head',
      'supplementary-execution-head',
      'supplementary-set-head',
      'food-catalog-head',
      'exercise-catalog-head',
      'routine-catalog-head',
      'routine-run-head',
      'routine-occurrence-head',
      'routine-blueprint-head',
      'recovery-action-head',
      'recovery-method-head',
      'check-in-head',
      'session-completion-head',
      'coaching-constraint-head',
      'ai-consent',
    ]);
    await expect(
      repository().captureBasis(fixture.athleteId, {
        ...capture,
        trainingAggregateId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
    await expect(repository().captureBasis(randomUUID(), capture)).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    await database.tenant(fixture.athleteId, (tx) =>
      tx.query("UPDATE consent SET revision=2 WHERE athlete_id=$1 AND kind='ai'", [
        fixture.athleteId,
      ]),
    );
    await expect(repository().captureBasis(fixture.athleteId, capture)).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    const noConsent = await seed(null);
    const noConsentInput = await prepareInput(noConsent);
    const noConsentNutrition = noConsentInput.writes.find((write) => write.domain === 'nutrition');
    const noConsentRecovery = noConsentInput.writes.find((write) => write.domain === 'recovery');
    const noConsentSchedule = noConsentInput.writes.find(
      (write) => write.domain === 'routine_schedule',
    );
    if (!noConsentNutrition || !noConsentRecovery || !noConsentSchedule)
      throw new Error('Missing no-consent aggregate fixture');
    await expect(
      repository().captureBasis(noConsent.athleteId, {
        evidenceSnapshotId: noConsent.evidenceId,
        trainingAggregateId: noConsent.planVersionId,
        nutritionAggregateId: noConsentNutrition.aggregateId,
        recoveryAggregateId: noConsentRecovery.aggregateId,
        routineScheduleAggregateId: noConsentSchedule.aggregateId,
      }),
    ).rejects.toMatchObject({
      code: 'AI_CONSENT_REQUIRED',
    });
  });

  it('commits all four domains once and replays the original result', async () => {
    const fixture = await seed();
    const candidate = await repository().prepareInternal(
      fixture.athleteId,
      await prepareInput(fixture),
    );
    const command = approval(candidate);
    const first = await repository().approve(fixture.athleteId, command);
    expect(first.versions.map((item) => item.domain)).toEqual([
      'nutrition',
      'recovery',
      'routine_schedule',
      'training',
    ]);
    const trainingVersion = first.versions.find((item) => item.domain === 'training');
    const nutritionVersion = first.versions.find((item) => item.domain === 'nutrition');
    const linkedTrainingVersionId = await database.tenant(fixture.athleteId, async (tx) => {
      const row = await tx.query(
        'SELECT linked_training_plan_version_id FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
        [fixture.athleteId, nutritionVersion?.versionId],
      );
      return row.rows[0]?.['linked_training_plan_version_id'];
    });
    expect(linkedTrainingVersionId).toBe(trainingVersion?.versionId);
    expect(await repository().approve(fixture.athleteId, command)).toEqual(first);
    const counts = await database.tenant(
      fixture.athleteId,
      async (tx) =>
        (
          await tx.query(
            `SELECT
           (SELECT count(*)::int FROM integrated_approval_v4 WHERE athlete_id=$1) approvals,
           (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='integrated.candidate_approved_v4') events,
           (SELECT count(*)::int FROM routine_occurrence WHERE athlete_id=$1) occurrences,
           (SELECT count(*)::int FROM recovery_action_log WHERE athlete_id=$1) actions,
           (SELECT count(*)::int FROM routine_run WHERE athlete_id=$1) runs`,
            [fixture.athleteId],
          )
        ).rows[0],
    );
    expect(counts).toEqual({ approvals: 1, events: 1, occurrences: 1, actions: 0, runs: 0 });
  });

  it('keeps the training aggregate stable across later approvals and captures', async () => {
    const fixture = await seed();
    const firstInput = await prepareInput(fixture);
    const nutrition = firstInput.writes.find((write) => write.domain === 'nutrition');
    const recovery = firstInput.writes.find((write) => write.domain === 'recovery');
    const schedule = firstInput.writes.find((write) => write.domain === 'routine_schedule');
    if (!nutrition || !recovery || !schedule) throw new Error('Missing aggregate fixture');
    const store = repository();
    const firstCandidate = await store.prepareInternal(fixture.athleteId, firstInput);
    const first = await store.approve(fixture.athleteId, approval(firstCandidate));
    const refreshedEvidence = await createCoreEvidenceSnapshotRepository(database).capture(
      fixture.athleteId,
      fixture.threadId,
      {
        expectedConversationRevision: 1,
        window: { from: '2080-01-01', toExclusive: '2080-02-01', timezone: 'UTC' },
        idempotencyKey: randomUUID(),
      },
    );
    if (refreshedEvidence.status !== 'available') throw new Error('Expected refreshed evidence');
    const captureInput = {
      evidenceSnapshotId: refreshedEvidence.id,
      trainingAggregateId: fixture.planVersionId,
      nutritionAggregateId: nutrition.aggregateId,
      recoveryAggregateId: recovery.aggregateId,
      routineScheduleAggregateId: schedule.aggregateId,
    };
    const afterFirst = await store.captureBasis(fixture.athleteId, captureInput);
    const firstTraining = first.versions.find((item) => item.domain === 'training');
    expect(afterFirst.planHeads[0]).toEqual({
      domain: 'training',
      aggregateId: fixture.planVersionId,
      head: { kind: 'exists', versionId: firstTraining?.versionId },
    });

    const secondCandidate = await store.prepareInternal(
      fixture.athleteId,
      integratedCandidatePrepareV4Schema.parse({
        proposalId: randomUUID(),
        basis: afterFirst,
        writes: [
          {
            domain: 'training',
            aggregateId: fixture.planVersionId,
            proposed: planDraft('Second approval'),
          },
        ],
        summary: 'Second training version',
        validation: { status: 'checked', errors: [], unknowns: [] },
        idempotencyKey: randomUUID(),
      }),
    );
    const second = await store.approve(fixture.athleteId, {
      schemaVersion: 4,
      confirmed: true,
      proposalId: secondCandidate.proposalId,
      candidateId: secondCandidate.id,
      proposalDigest: secondCandidate.digest,
      writeDomains: ['training'],
      expectedBasis: secondCandidate.basis,
      idempotencyKey: randomUUID(),
    });
    const secondRefreshedEvidence = await createCoreEvidenceSnapshotRepository(database).capture(
      fixture.athleteId,
      fixture.threadId,
      {
        expectedConversationRevision: 1,
        window: { from: '2080-01-01', toExclusive: '2080-02-01', timezone: 'UTC' },
        idempotencyKey: randomUUID(),
      },
    );
    if (secondRefreshedEvidence.status !== 'available')
      throw new Error('Expected second refreshed evidence');
    const afterSecond = await store.captureBasis(fixture.athleteId, {
      ...captureInput,
      evidenceSnapshotId: secondRefreshedEvidence.id,
    });
    const secondTraining = second.versions.find((item) => item.domain === 'training');
    expect(afterSecond.planHeads[0]).toEqual({
      domain: 'training',
      aggregateId: fixture.planVersionId,
      head: { kind: 'exists', versionId: secondTraining?.versionId },
    });
    expect(secondTraining?.versionId).not.toBe(firstTraining?.versionId);
  });

  it('rejects an absent recovery head that appeared after preparation', async () => {
    const fixture = await seed();
    const input = await prepareInput(fixture);
    const candidate = await repository().prepareInternal(fixture.athleteId, input);
    const recovery = input.writes.find((write) => write.domain === 'recovery');
    if (!recovery) throw new Error('Missing recovery write');
    await database.tenant(fixture.athleteId, async (tx) => {
      const versionId = randomUUID();
      const record = {
        schemaVersion: 1,
        strategyId: recovery.aggregateId,
        versionId,
        version: 1,
        previousVersionId: null,
        status: 'user_confirmed',
        selectedOptionId: recovery.selectedOptionId,
        createdAt: '2080-01-01T00:00:00.000Z',
        draft: recovery.proposed,
      };
      await tx.query(
        `INSERT INTO recovery_strategy_version
         (athlete_id,strategy_id,version_id,version,previous_version_id,previous_version,record_json)
         VALUES($1,$2,$3,1,NULL,NULL,$4::jsonb)`,
        [fixture.athleteId, recovery.aggregateId, versionId, JSON.stringify(record)],
      );
      await tx.query(
        'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
        [fixture.athleteId, recovery.aggregateId, versionId],
      );
    });
    await expect(
      repository().approve(fixture.athleteId, approval(candidate)),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  });

  it('rejects checked candidates that still contain unknowns', async () => {
    const fixture = await seed();
    const input = await prepareInput(fixture);
    input.validation.unknowns = ['Confirm the unresolved input'];
    const candidate = await repository().prepareInternal(fixture.athleteId, input);
    await expect(
      repository().approve(fixture.athleteId, approval(candidate)),
    ).rejects.toMatchObject({ code: 'CANDIDATE_NOT_APPROVABLE' });
  });

  it.each(['session', 'unlinked-session', 'food'] as const)(
    'rejects an invalid nutrition %s reference and rolls every domain back',
    async (reference) => {
      const fixture = await seed();
      const input = await prepareInput(fixture);
      const nutrition = input.writes.find((write) => write.domain === 'nutrition');
      if (!nutrition) throw new Error('Missing nutrition write');
      if (reference === 'unlinked-session') {
        nutrition.proposed.linkedTrainingPlanVersionId = null;
      }
      nutrition.proposed.items = [
        {
          id: `invalid-${reference}`,
          category: 'before',
          title: `Invalid ${reference}`,
          anchor:
            reference !== 'food'
              ? {
                  kind: 'relative',
                  entity: 'session',
                  entityId: 'missing-session',
                  point: 'start',
                  offsetMinutes: 0,
                }
              : { kind: 'absolute', date: '2080-01-03', localTime: null, timezone: 'UTC' },
          foods:
            reference === 'food'
              ? [
                  {
                    foodVersionId: randomUUID(),
                    description: 'Missing food definition',
                    quantity: 100,
                    unit: 'g',
                    sourceBasis: 'per_100g',
                  },
                ]
              : [],
          targets: [],
          instructions: reference !== 'food' ? 'Use the referenced session.' : '',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ];
      const candidate = await repository().prepareInternal(fixture.athleteId, input);
      const counts = () =>
        database.tenant(
          fixture.athleteId,
          async (tx) =>
            (
              await tx.query(
                `SELECT
                 (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) plans,
                 (SELECT count(*)::int FROM plan_history WHERE athlete_id=$1) plan_history,
                 (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) nutrition,
                 (SELECT count(*)::int FROM nutrition_plan_history WHERE athlete_id=$1) nutrition_history,
                 (SELECT count(*)::int FROM recovery_strategy_version WHERE athlete_id=$1) recovery,
                 (SELECT count(*)::int FROM recovery_strategy_history WHERE athlete_id=$1) recovery_history,
                 (SELECT count(*)::int FROM routine_schedule_version WHERE athlete_id=$1) schedules,
                 (SELECT count(*)::int FROM routine_schedule_history WHERE athlete_id=$1) schedule_history,
                 (SELECT count(*)::int FROM integrated_approval_v4 WHERE athlete_id=$1) approvals,
                 (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) outbox,
                 (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) receipts`,
                [fixture.athleteId],
              )
            ).rows[0],
        );
      const before = await counts();
      await expect(
        repository().approve(fixture.athleteId, approval(candidate)),
      ).rejects.toMatchObject({ code: 'CANDIDATE_NOT_APPROVABLE' });
      expect(await counts()).toEqual(before);
    },
  );

  it('rejects a routine actual revision that changed after preparation', async () => {
    const fixture = await seed();
    const candidate = await repository().prepareInternal(
      fixture.athleteId,
      await prepareInput(fixture),
    );
    await database.tenant(fixture.athleteId, async (tx) => {
      const runId = randomUUID();
      const run = {
        id: runId,
        revision: 0,
        blueprint: { id: fixture.blueprintId, versionId: fixture.blueprintVersionId },
        origin: { kind: 'unplanned' },
        state: 'in_progress',
        progress: [],
        selectedChoices: {},
        startedAt: '2080-01-01T00:00:00.000Z',
        endedAt: null,
      };
      await tx.query(
        `INSERT INTO routine_run
         (athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json)
         VALUES($1,$2,$3,$4,NULL,0,'in_progress',$5::jsonb)`,
        [
          fixture.athleteId,
          runId,
          fixture.blueprintId,
          fixture.blueprintVersionId,
          JSON.stringify(run),
        ],
      );
    });
    await expect(
      repository().approve(fixture.athleteId, approval(candidate)),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  });

  it('rejects a recovery actual revision that changed after preparation', async () => {
    const fixture = await seed();
    const candidate = await repository().prepareInternal(
      fixture.athleteId,
      await prepareInput(fixture),
    );
    await database.tenant(fixture.athleteId, async (tx) => {
      const actionId = randomUUID();
      const revisionId = randomUUID();
      await tx.query(
        `INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status)
         VALUES($1,$2,1,$3,'active')`,
        [fixture.athleteId, actionId, revisionId],
      );
      await tx.query(
        `INSERT INTO recovery_action_revision
         (athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,1,$3,'active',$4::jsonb)`,
        [
          fixture.athleteId,
          actionId,
          revisionId,
          JSON.stringify({ schemaVersion: 1, actionId, revisionId, revision: 1, status: 'active' }),
        ],
      );
    });
    await expect(
      repository().approve(fixture.athleteId, approval(candidate)),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  });

  it('rejects a selected recovery method outside the tenant-owned catalog', async () => {
    const fixture = await seed();
    const input = await prepareInput(fixture);
    const recovery = input.writes.find((write) => write.domain === 'recovery');
    if (!recovery) throw new Error('Missing recovery write');
    const selected = recovery.proposed.options.find(
      (option) => option.id === recovery.selectedOptionId,
    );
    if (!selected) throw new Error('Missing recovery option');
    selected.kind = 'nonexercise_action';
    selected.methodVersionId = randomUUID();
    await expect(repository().prepareInternal(fixture.athleteId, input)).rejects.toMatchObject({
      code: 'CANDIDATE_NOT_APPROVABLE',
    });
  });

  it('rolls every domain back when a duplicate occurrence fails last', async () => {
    const fixture = await seed();
    const candidate = await repository().prepareInternal(
      fixture.athleteId,
      await prepareInput(fixture, true),
    );
    await expect(repository().approve(fixture.athleteId, approval(candidate))).rejects.toBeTruthy();
    const counts = await database.tenant(
      fixture.athleteId,
      async (tx) =>
        (
          await tx.query(
            `SELECT
           (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) plans,
           (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) nutrition,
           (SELECT count(*)::int FROM recovery_strategy_version WHERE athlete_id=$1) recovery,
           (SELECT count(*)::int FROM routine_schedule_version WHERE athlete_id=$1) schedules,
           (SELECT count(*)::int FROM integrated_approval_v4 WHERE athlete_id=$1) approvals,
           (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND topic='integrated.candidate_approved_v4') events`,
            [fixture.athleteId],
          )
        ).rows[0],
    );
    expect(counts).toEqual({
      plans: 1,
      nutrition: 0,
      recovery: 0,
      schedules: 0,
      approvals: 0,
      events: 0,
    });
  });
});
