import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateIntakeEntryRequest,
  NutritionPlanDraft,
  SaveFoodDefinitionVersionRequest,
} from '@workout/contracts/nutrition-core';
import { AppConsentRequiredError, lockAppAdmission } from '../src/app-admission.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantOperations,
  grantNutritionCore,
  grantRecoveryCore,
  grantSupplementaryCore,
  grantStretchingCore,
  grantRoutineCore,
} from '../src/migrate.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createStretchingRepository } from '../src/stretching.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createActivityRepository } from '../src/activities.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const applicationName = `actuals-app-admission-${randomUUID()}`;
let database: Database;
let restoreGeneration: string;
const happenedAt = '2026-01-01T08:00:00.000Z';
const laterAt = '2026-01-01T08:01:00.000Z';
const expectedDefinition = {
  kind: 'repetitions' as const,
  basis: 'per_side' as const,
  definitionId: 'rep-per-side-v1',
};
beforeAll(async () => {
  await migrate(adminUrl);
  for (const grant of [
    grantOperations,
    grantNutritionCore,
    grantRecoveryCore,
    grantSupplementaryCore,
    grantStretchingCore,
    grantRoutineCore,
  ])
    await grant(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON consent,command_receipt,outbox,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO workout_runtime`,
  );
  await admin.query(
    'GRANT SELECT ON plan_snapshot,plan_head,check_in,intake_entry,tenant_erasure TO workout_runtime',
  );
  const endpoint = new URL(runtimeUrl);
  endpoint.searchParams.set('application_name', applicationName);
  database = createDatabase({ connectionString: endpoint.toString(), max: 6 });
  restoreGeneration = z
    .string()
    .parse((await admin.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']);
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function consent(athlete: string, granted: boolean, expectedRevision: number) {
  return createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision,
    idempotencyKey: randomUUID(),
  });
}
const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
const nutrients = () => ({
  energy: unknown('kcal'),
  carbohydrate: unknown('g'),
  protein: unknown('g'),
  fat: unknown('g'),
  fluid: unknown('mL'),
  sodium: unknown('mg'),
});
function draft(): NutritionPlanDraft {
  return {
    period: { from: '2026-09-01', toInclusive: '2026-09-30' },
    timezone: 'UTC',
    purpose: 'User meal notes',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal-1',
        category: 'meal',
        title: 'Breakfast',
        anchor: { kind: 'absolute', date: '2026-09-18', localTime: null, timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'Eat when ready',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}
function food(foodId = 'oats'): SaveFoodDefinitionVersionRequest {
  return {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId,
      name: 'Oats',
      basis: { kind: 'per_100g' },
      nutrients: nutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-09-18T00:00:00.000Z',
        reviewState: 'unreviewed',
      },
    },
  };
}
function intake(foodVersionId: string, intakeId: string = randomUUID()): CreateIntakeEntryRequest {
  return {
    idempotencyKey: randomUUID(),
    restoreGeneration,
    intakeId,
    confirmed: true,
    occurredAt: '2026-09-18T08:00:00.000Z',
    timezone: 'UTC',
    foods: [
      { foodVersionId, description: 'Oats', quantity: 0, unit: 'g', sourceBasis: 'per_100g' },
    ],
    nutrientTotal: {
      ...nutrients(),
      energy: {
        value: 0,
        unit: 'kcal',
        status: 'reported',
        evidenceIds: [],
      },
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  };
}

function exercise(exerciseId = randomUUID(), versionId = randomUUID()) {
  return {
    definition: {
      schemaVersion: 2 as const,
      exerciseId,
      versionId,
      name: 'Single-leg balance',
      family: 'balance_stability' as const,
      equipment: ['bodyweight' as const],
      tags: ['balance'],
      countDefinitions: [expectedDefinition],
      mediaAssetIds: [],
      resourceVersionIds: [],
      reviewState: 'unreviewed' as const,
      description: 'User-defined movement',
      safetyNotes: '',
      supportedMetrics: ['count' as const, 'effort' as const],
      createdAt: happenedAt,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
function routine(
  exerciseVersionId: string,
  routineId: string = randomUUID(),
  versionId: string = randomUUID(),
) {
  return {
    template: {
      schemaVersion: 2 as const,
      routineId,
      versionId,
      title: 'Balance routine',
      purpose: 'User-defined practice',
      requiredEquipment: ['bodyweight' as const],
      spec: {
        schemaVersion: 2 as const,
        kind: 'supplementary' as const,
        routineVersionId: versionId,
        blocks: [
          {
            id: 'block-1',
            mode: 'single' as const,
            rounds: 2,
            sets: [
              {
                id: 'target-1',
                exerciseVersionId,
                side: 'left' as const,
                count: {
                  target: {
                    min: 8,
                    max: 10,
                    unit: 'count' as const,
                    basis: 'user_confirmed' as const,
                    evidenceIds: [],
                  },
                  definition: expectedDefinition,
                },
                durationSeconds: null,
                externalResistance: { kind: 'no_added_load' as const },
                restAfterSeconds: 60,
                tempo: null,
                effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: happenedAt,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
function setValues(exerciseVersionId: string) {
  return {
    targetSetId: 'target-1',
    blockId: 'block-1',
    roundIndex: 1,
    exerciseVersionId,
    side: 'left' as const,
    state: 'partial' as const,
    count: {
      actual: { value: 4, unit: 'count' as const, status: 'reported' as const, evidenceIds: [] },
      definition: expectedDefinition,
    },
    durationSeconds: {
      value: null,
      unit: 's' as const,
      status: 'unknown' as const,
      evidenceIds: [],
    },
    externalResistance: { kind: 'no_added_load' as const },
    effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
    occurredAt: happenedAt,
    reason: null,
  };
}
function blueprint(routineId = randomUUID(), versionId = randomUUID()) {
  const first = randomUUID();
  const second = randomUUID();
  const group = randomUUID();
  return {
    schemaVersion: 4 as const,
    routineId,
    versionId,
    title: '저녁 점검',
    intent: '사용자 선택',
    status: 'published' as const,
    tags: ['checklist'],
    estimatedDurationSeconds: null,
    createdAt: '2026-09-18T10:00:00.000Z',
    steps: [
      {
        id: first,
        title: '휴식 확인',
        content: { kind: 'checklist' as const, prompt: '쉬었나요?' },
        timing: { kind: 'ordered' as const, afterStepId: null },
        required: true,
        choiceGroupId: group,
      },
      {
        id: second,
        title: '준비 확인',
        content: { kind: 'checklist' as const, prompt: '준비했나요?' },
        timing: { kind: 'ordered' as const, afterStepId: first },
        required: true,
        choiceGroupId: group,
      },
    ],
    choiceGroups: [{ id: group, mode: 'one_of' as const, stepIds: [first, second] }],
  };
}
const commandNames = [
  'nutrition.plan',
  'nutrition.create',
  'nutrition.correct',
  'recovery.strategy',
  'recovery.confirm',
  'recovery.create',
  'recovery.correct',
  'supplementary.execution',
  'supplementary.create',
  'supplementary.correct',
  'supplementary.timer.start',
  'supplementary.timer.resume',
  'stretching.create',
  'stretching.correct',
  'routine.preview',
  'routine.approve',
  'routine.start',
  'routine.choose',
  'routine.record',
  'routine.schedule.resume',
  'routine.run.resume',
  'routine.timer.start',
  'routine.timer.resume',
] as const;
type CommandName = (typeof commandNames)[number];
async function setup() {
  const athlete = randomUUID();
  await consent(athlete, true, 0);
  const nutrition = createNutritionRepository(database, {
    now: () => new Date('2026-09-19T00:00:00Z'),
  });
  const recovery = createRecoveryRepository(database, {
    now: () => new Date('2026-09-19T00:00:00Z'),
  });
  const supplementary = createSupplementaryRepository(database, {
    now: () => new Date(happenedAt),
  });
  const stretching = createStretchingRepository(database, {
    now: () => new Date('2026-09-19T00:00:00Z'),
  });
  const routines = createRoutineRepository(database);
  const savedFood = await nutrition.saveFood(athlete, food());
  const intakeInput = intake(savedFood.versionId);
  const savedIntake = await nutrition.createIntake(athlete, intakeInput);
  const { restoreGeneration: _intakeGeneration, ...intakeCorrection } = intakeInput;
  void _intakeGeneration;
  const method = await recovery.createMethod(athlete, {
    title: 'Synthetic rest',
    category: 'rest',
    intendedUse: 'User tracking',
    applicability: [],
    cautions: [],
    sourceDescription: 'User input',
    evidenceLimitations: 'Unreviewed',
    idempotencyKey: randomUUID(),
  });
  const strategyDraft = {
    title: 'Rest choice',
    goal: 'User review',
    startDate: '2026-09-18',
    endDateExclusive: '2026-09-21',
    timezone: 'UTC',
    knownFacts: [],
    missingInformation: [],
    priority: 'normal' as const,
    observations: [],
    planRefs: [],
    options: [
      {
        id: randomUUID(),
        title: 'Rest',
        kind: 'full_rest' as const,
        methodVersionId: null,
        explanation: 'User option',
      },
    ],
    reassessment: [
      {
        id: randomUUID(),
        trigger: 'user_report_changed' as const,
        plannedAt: null,
        description: 'User review',
        policyVersion: null,
      },
    ],
  };
  const strategy = await recovery.createStrategy(athlete, {
    draft: strategyDraft,
    idempotencyKey: randomUUID(),
  });
  const actionInput = {
    restoreGeneration,
    methodVersionId: method.versionId,
    strategyVersionId: null,
    plannedOptionId: null,
    occurredAt: '2026-09-18T08:00:00Z',
    timezone: 'UTC',
    state: 'performed' as const,
    durationSeconds: null,
    actualConditions: 'Quiet',
    beforeCheckIn: null,
    afterCheckIn: null,
    discomfort: '',
    userNotes: 'User record',
    source: 'user_confirmed' as const,
    idempotencyKey: randomUUID(),
  };
  const action = await recovery.createAction(athlete, actionInput);
  const { restoreGeneration: _actionGeneration, ...actionCorrection } = actionInput;
  void _actionGeneration;
  const movement = await supplementary.saveExercise(athlete, exercise());
  const activity = await createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Synthetic session',
      kind: 'strength',
      startedAt: happenedAt,
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: null,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const unlinkedActivity = await createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Unlinked session',
      kind: 'strength',
      startedAt: happenedAt,
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: null,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const executionInput = {
    schemaVersion: 2 as const,
    executionId: randomUUID(),
    plannedSession: null,
    activity: { kind: 'match_existing' as const, activityId: activity.activityId },
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  const execution = await supplementary.createExecution(athlete, executionInput);
  const values = {
    ...setValues(movement.definition.versionId),
    targetSetId: null,
    blockId: null,
    roundIndex: null,
  };
  const set = await supplementary.createSetLog(athlete, {
    schemaVersion: 2,
    executionId: execution.executionId,
    logId: randomUUID(),
    expectedExecutionRevision: execution.revision,
    idempotencyKey: randomUUID(),
    confirmation: 'user_confirmed',
    values,
  });
  if (set.status !== 'active') throw new Error('ACTIVE_FIXTURE_REQUIRED');
  const timerId = randomUUID();
  await supplementary.commandRestTimer(athlete, {
    action: 'start',
    executionId: execution.executionId,
    timerId,
    durationSeconds: 60,
    at: happenedAt,
    idempotencyKey: randomUUID(),
  });
  const pausedTimer = await supplementary.commandRestTimer(athlete, {
    action: 'pause',
    executionId: execution.executionId,
    timerId,
    expectedRevision: 1,
    at: laterAt,
    idempotencyKey: randomUUID(),
  });
  const stretchDefinition = {
    ...exercise().definition,
    family: 'stretching' as const,
    countDefinitions: [],
    supportedMetrics: ['duration' as const],
  };
  const stretch = await stretching.saveExercise(athlete, {
    definition: stretchDefinition,
    profile: {
      method: 'static_hold',
      movement: 'active',
      assistance: 'self',
      context: 'cooldown',
      bodyRegions: ['shoulder'],
      sideBasis: 'per_side',
      source: { kind: 'user_authored' },
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const stretchValues = {
    activityId: activity.activityId,
    exerciseVersionId: stretch.definition.versionId,
    plannedTarget: null,
    allocation: { kind: 'standalone' as const },
    side: 'left' as const,
    state: 'performed' as const,
    holdSeconds: 25,
    repetitions: null,
    restSeconds: null,
    comfort: 'unknown' as const,
    discomfortNote: null,
    reason: null,
    occurredAt: happenedAt,
  };
  const stretchLog = await stretching.createLog(athlete, {
    schemaVersion: 1,
    logId: randomUUID(),
    idempotencyKey: randomUUID(),
    confirmation: 'user_confirmed',
    values: stretchValues,
  });
  if (stretchLog.status !== 'active') throw new Error('ACTIVE_FIXTURE_REQUIRED');
  const first = blueprint();
  await routines.saveBlueprint(athlete, {
    blueprint: first,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const group = first.choiceGroups[0];
  const step = first.steps[0];
  if (!group || !step) throw new Error('BLUEPRINT_FIXTURE_REQUIRED');
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: first.routineId, versionId: first.versionId },
      window: {
        startDate: '2026-11-02',
        endDateExclusive: '2026-11-03',
        timezone: 'Asia/Seoul',
        maxOccurrences: 1,
      },
      rule: { kind: 'dates' as const, dates: ['2026-11-02'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: null,
  };
  // The paused/resumed schedule lies in the past: resume re-materializes only future
  // occurrences, and this normal107 fixture lacks SQL121's version-scoped anchor key.
  const pastScheduleInput = {
    ...scheduleInput,
    schedule: {
      ...scheduleInput.schedule,
      window: { ...scheduleInput.schedule.window, startDate: '2026-01-01' },
      rule: { ...scheduleInput.schedule.rule, dates: ['2026-01-01'] },
    },
  };
  const preview = await routines.previewSchedule(athlete, pastScheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...pastScheduleInput,
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const pausedSchedule = await routines.changeSchedule(athlete, {
    scheduleId: approved.schedule.id,
    expectedVersionId: approved.schedule.versionId,
    action: 'pause',
    previewDigest: approved.impactDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  // Resume confirms its own change preview, not the paused schedule read.
  const resumePreview = await routines.previewScheduleResume(athlete, approved.schedule.id);
  const run = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: first.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const chosen = await routines.chooseStep(athlete, {
    runId: run.run.id,
    groupId: group.id,
    stepId: step.id,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const secondRun = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: first.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const pausedRun = await routines.changeRun(athlete, {
    runId: secondRun.run.id,
    action: 'pause',
    expectedRevision: secondRun.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const runTimer = await routines.commandTimer(athlete, {
    runId: run.run.id,
    stepId: step.id,
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  const pausedRunTimer = await routines.commandTimer(athlete, {
    runId: run.run.id,
    stepId: step.id,
    action: 'pause',
    durationSeconds: null,
    expectedRevision: runTimer.revision,
    idempotencyKey: randomUUID(),
  });
  const freshSchedule = {
    ...scheduleInput,
    schedule: { ...scheduleInput.schedule, id: randomUUID(), versionId: randomUUID() },
  };
  const freshPreview = await routines.previewSchedule(athlete, freshSchedule);
  const key = randomUUID();
  const newExecutionId = randomUUID();
  const newLogId = randomUUID();
  const newTimerId = randomUUID();
  const newRunId = randomUUID();
  const execute: Record<CommandName, () => Promise<unknown>> = {
    'nutrition.plan': () =>
      nutrition.savePlan(athlete, {
        kind: 'create',
        idempotencyKey: key,
        confirmed: true,
        draft: draft(),
      }),
    'nutrition.create': () =>
      nutrition.createIntake(athlete, {
        ...intake(savedFood.versionId, newLogId),
        idempotencyKey: key,
      }),
    'nutrition.correct': () =>
      nutrition.correctIntake(athlete, {
        ...intakeCorrection,
        expectedRevision: savedIntake.revision,
        idempotencyKey: key,
        notes: 'Corrected',
      }),
    'recovery.strategy': () =>
      recovery.createStrategy(athlete, { draft: strategyDraft, idempotencyKey: key }),
    'recovery.confirm': () =>
      recovery.confirmStrategy(athlete, {
        strategyId: strategy.strategyId,
        expectedHeadVersionId: strategy.versionId,
        selectedOptionId: strategyDraft.options[0]?.id ?? '',
        idempotencyKey: key,
      }),
    'recovery.create': () =>
      recovery.createAction(athlete, { ...actionInput, idempotencyKey: key }),
    'recovery.correct': () =>
      recovery.correctAction(athlete, {
        ...actionCorrection,
        actionId: action.actionId,
        expectedRevision: action.revision,
        idempotencyKey: key,
      }),
    'supplementary.execution': () =>
      supplementary.createExecution(athlete, {
        ...executionInput,
        executionId: newExecutionId,
        activity: { kind: 'match_existing', activityId: unlinkedActivity.activityId },
        idempotencyKey: key,
      }),
    'supplementary.create': () =>
      supplementary.createSetLog(athlete, {
        schemaVersion: 2,
        executionId: execution.executionId,
        logId: newLogId,
        expectedExecutionRevision: 2,
        idempotencyKey: key,
        confirmation: 'user_confirmed',
        values,
      }),
    'supplementary.correct': () =>
      supplementary.correctSetLog(athlete, {
        schemaVersion: 2,
        executionId: execution.executionId,
        logId: set.current.logId,
        expectedRevision: 1,
        idempotencyKey: key,
        confirmation: 'user_confirmed',
        values,
      }),
    'supplementary.timer.start': () =>
      supplementary.commandRestTimer(athlete, {
        action: 'start',
        executionId: execution.executionId,
        timerId: newTimerId,
        durationSeconds: 60,
        at: happenedAt,
        idempotencyKey: key,
      }),
    'supplementary.timer.resume': () =>
      supplementary.commandRestTimer(athlete, {
        action: 'resume',
        executionId: execution.executionId,
        timerId,
        expectedRevision: pausedTimer.revision,
        at: laterAt,
        idempotencyKey: key,
      }),
    'stretching.create': () =>
      stretching.createLog(athlete, {
        schemaVersion: 1,
        logId: newLogId,
        idempotencyKey: key,
        confirmation: 'user_confirmed',
        values: stretchValues,
      }),
    'stretching.correct': () =>
      stretching.correctLog(athlete, {
        schemaVersion: 1,
        logId: stretchLog.current.logId,
        expectedRevision: 1,
        idempotencyKey: key,
        confirmation: 'user_confirmed',
        values: stretchValues,
      }),
    'routine.preview': () => routines.previewSchedule(athlete, freshSchedule),
    'routine.approve': () =>
      routines.approveSchedule(athlete, {
        ...freshSchedule,
        previewDigest: freshPreview.previewDigest,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.start': () =>
      routines.startRun(athlete, {
        runId: newRunId,
        blueprintVersionId: first.versionId,
        occurrenceId: null,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.choose': () =>
      routines.chooseStep(athlete, {
        runId: run.run.id,
        groupId: group.id,
        stepId: step.id,
        expectedRevision: chosen.run.revision,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.record': () =>
      routines.recordStep(athlete, {
        runId: run.run.id,
        stepId: step.id,
        state: 'stopped',
        actualRefs: [],
        occurredAt: happenedAt,
        reason: 'User stopped',
        expectedRevision: chosen.run.revision,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.schedule.resume': () =>
      routines.changeSchedule(athlete, {
        scheduleId: pausedSchedule.schedule.id,
        expectedVersionId: pausedSchedule.schedule.versionId,
        action: 'resume',
        previewDigest: resumePreview.previewDigest,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.run.resume': () =>
      routines.changeRun(athlete, {
        runId: pausedRun.run.id,
        action: 'resume',
        expectedRevision: pausedRun.run.revision,
        idempotencyKey: key,
        confirmed: true,
      }),
    'routine.timer.start': () =>
      routines.commandTimer(athlete, {
        runId: run.run.id,
        stepId: group.stepIds[1] ?? '',
        action: 'start',
        durationSeconds: 30,
        expectedRevision: null,
        idempotencyKey: key,
      }),
    'routine.timer.resume': () =>
      routines.commandTimer(athlete, {
        runId: run.run.id,
        stepId: step.id,
        action: 'resume',
        durationSeconds: null,
        expectedRevision: pausedRunTimer.revision,
        idempotencyKey: key,
      }),
  };
  return {
    athlete,
    execute,
    nutrition,
    recovery,
    supplementary,
    stretching,
    routines,
    savedIntake,
    savedFood,
    action,
    execution,
    set,
    stretchLog,
    run: chosen,
    pausedRunTimer,
    pausedTimer,
    timerId,
    step,
    first,
    pausedSchedule,
  };
}
const tables = [
  'nutrition_plan_version',
  'nutrition_plan_head',
  'nutrition_plan_history',
  'food_definition_version',
  'food_definition_head',
  'intake_entry',
  'intake_entry_revision',
  'recovery_method_version',
  'recovery_method_head',
  'recovery_strategy_version',
  'recovery_strategy_head',
  'recovery_action_log',
  'recovery_action_revision',
  'supplementary_exercise_version',
  'supplementary_exercise_head',
  'supplementary_routine_version',
  'supplementary_routine_head',
  'supplementary_execution',
  'supplementary_set_log',
  'supplementary_set_log_revision',
  'supplementary_rest_timer',
  'stretch_profile',
  'stretching_log',
  'stretching_log_revision',
  'routine_blueprint_version',
  'routine_blueprint_head',
  'routine_schedule_version',
  'routine_schedule_head',
  'routine_occurrence',
  'routine_run',
  'routine_run_revision',
  'routine_checklist_confirmation',
  'routine_step_timer',
  'routine_command_receipt',
  'activity_canonical',
  'activity_source_head',
  'activity_source_revision',
  'activity_overlay',
  'activity_overlay_revision',
  'integrated_dependency_head',
  'command_receipt',
  'outbox',
] as const;
async function facts(athlete: string) {
  return database.tenant(athlete, async (tx) => {
    const result = [];
    for (const table of tables)
      result.push(
        (
          await tx.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS facts FROM ${table} t`,
          )
        ).rows[0],
      );
    return result;
  });
}
function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function blocked() {
  await expect
    .poll(
      async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
            [applicationName],
          )
        ).rows[0]?.['count'],
    )
    .toBeGreaterThan(0);
}
describe('V2-F31 actuals and routine app admission with restricted PostgreSQL role', () => {
  for (const state of ['absent', 'withdrawn'] as const) {
    it.each(commandNames)(
      `${state} rejects %s and leaves every owned row unchanged`,
      async (name) => {
        const fixture = await setup();
        if (state === 'absent')
          await database.tenant(fixture.athlete, (tx) =>
            tx.query("DELETE FROM consent WHERE kind='app'"),
          );
        else await consent(fixture.athlete, false, 1);
        const before = await facts(fixture.athlete);
        await expect(fixture.execute[name]()).rejects.toBeInstanceOf(AppConsentRequiredError);
        expect(await facts(fixture.athlete)).toEqual(before);
      },
    );
  }
  it.each(commandNames.filter((name) => name !== 'routine.preview'))(
    'granted %s commits once and replays after revocation without new writes',
    async (name) => {
      const fixture = await setup();
      const saved = await fixture.execute[name]();
      await consent(fixture.athlete, false, 1);
      const before = await facts(fixture.athlete);
      expect(await fixture.execute[name]()).toEqual(saved);
      expect(await facts(fixture.athlete)).toEqual(before);
    },
  );
  it('keeps independent food/exercise/routine/blueprint authoring available without an app head', async () => {
    const athlete = randomUUID();
    const nutrition = createNutritionRepository(database);
    const supplementary = createSupplementaryRepository(database);
    const recovery = createRecoveryRepository(database);
    const routines = createRoutineRepository(database);
    expect(await nutrition.saveFood(athlete, food())).toBeDefined();
    const movement = await supplementary.saveExercise(athlete, exercise());
    expect(
      await supplementary.saveRoutine(athlete, routine(movement.definition.versionId)),
    ).toBeDefined();
    await createStretchingRepository(database).saveExercise(athlete, {
      definition: {
        ...exercise().definition,
        family: 'stretching',
        countDefinitions: [],
        supportedMetrics: ['duration'],
      },
      profile: {
        method: 'static_hold',
        movement: 'active',
        assistance: 'self',
        context: 'cooldown',
        bodyRegions: ['shoulder'],
        sideBasis: 'per_side',
        source: { kind: 'user_authored' },
      },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(
      await recovery.createMethod(athlete, {
        title: 'Rest',
        category: 'rest',
        intendedUse: 'User tracking',
        applicability: [],
        cautions: [],
        sourceDescription: 'User',
        evidenceLimitations: 'Unreviewed',
        idempotencyKey: randomUUID(),
      }),
    ).toBeDefined();
    const first = blueprint();
    await routines.saveBlueprint(athlete, {
      blueprint: first,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(
      await routines.changeLibrary(athlete, {
        routineId: first.routineId,
        expectedVersionId: first.versionId,
        action: 'favorite',
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).toMatchObject({ favorite: true });
  });
  it('does not infer app consent from another athlete or another kind and enforces RLS', async () => {
    const fixture = await setup();
    const other = randomUUID();
    await createConsentRepository(database).setConsent(other, {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await expect(
      createNutritionRepository(database).savePlan(other, {
        kind: 'create',
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: draft(),
      }),
    ).rejects.toBeInstanceOf(AppConsentRequiredError);
    expect(await fixture.nutrition.readIntake(other, fixture.savedIntake.intakeId)).toBeNull();
    expect(await fixture.routines.readRun(other, fixture.run.run.id)).toBeNull();
    const role = await database.tenant(other, (tx) =>
      tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'),
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it('preserves read and explicit deletion after withdrawal', async () => {
    const f = await setup();
    await consent(f.athlete, false, 1);
    expect(await f.nutrition.readIntake(f.athlete, f.savedIntake.intakeId)).toEqual(f.savedIntake);
    expect(await f.routines.readRun(f.athlete, f.run.run.id)).toEqual({
      ...f.run,
      timers: [f.pausedRunTimer],
    });
    expect(
      await f.nutrition.deleteIntake(f.athlete, {
        intakeId: f.savedIntake.intakeId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        confirmed: true,
        reason: 'user_requested',
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(
      await f.recovery.deleteAction(f.athlete, {
        actionId: f.action.actionId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(
      await f.stretching.deleteLog(f.athlete, {
        schemaVersion: 1,
        logId: f.stretchLog.current.logId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        confirmed: true,
        reason: 'Remove',
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(
      await f.supplementary.deleteSetLog(f.athlete, {
        schemaVersion: 2,
        executionId: f.execution.executionId,
        logId: f.set.current.logId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        confirmed: true,
        reason: 'Remove',
      }),
    ).toMatchObject({ status: 'deleted' });
  });
  it('permits timer suspension/finish and lifecycle stop without inventing actual reports', async () => {
    const f = await setup();
    const actualFacts = () =>
      database.tenant(f.athlete, async (tx) => {
        const result = [];
        for (const table of [
          'activity_canonical',
          'intake_entry_revision',
          'recovery_action_revision',
          'supplementary_set_log_revision',
          'stretching_log_revision',
          'routine_checklist_confirmation',
        ])
          result.push(
            (
              await tx.query(
                `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS facts FROM ${table} t`,
              )
            ).rows[0],
          );
        return result;
      });
    const before = await actualFacts();
    await f.supplementary.commandRestTimer(f.athlete, {
      action: 'resume',
      executionId: f.execution.executionId,
      timerId: f.timerId,
      expectedRevision: f.pausedTimer.revision,
      at: laterAt,
      idempotencyKey: randomUUID(),
    });
    await f.routines.commandTimer(f.athlete, {
      runId: f.run.run.id,
      stepId: f.step.id,
      action: 'resume',
      durationSeconds: null,
      expectedRevision: f.pausedRunTimer.revision,
      idempotencyKey: randomUUID(),
    });
    await consent(f.athlete, false, 1);
    expect(
      await f.supplementary.commandRestTimer(f.athlete, {
        action: 'pause',
        executionId: f.execution.executionId,
        timerId: f.timerId,
        expectedRevision: 3,
        at: laterAt,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ status: 'paused' });
    expect(
      await f.routines.commandTimer(f.athlete, {
        runId: f.run.run.id,
        stepId: f.step.id,
        action: 'pause',
        durationSeconds: null,
        expectedRevision: 3,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ state: 'paused' });
    expect(
      await f.supplementary.commandRestTimer(f.athlete, {
        action: 'finish',
        executionId: f.execution.executionId,
        timerId: f.timerId,
        expectedRevision: 4,
        at: laterAt,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ status: 'finished' });
    expect(
      await f.routines.commandTimer(f.athlete, {
        runId: f.run.run.id,
        stepId: f.step.id,
        action: 'clear',
        durationSeconds: null,
        expectedRevision: 4,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ state: 'cleared' });
    expect(
      await f.supplementary.completeExecution(f.athlete, {
        schemaVersion: 2,
        executionId: f.execution.executionId,
        expectedRevision: 2,
        status: 'stopped',
        endedAt: laterAt,
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).toMatchObject({ status: 'stopped' });
    const paused = await f.routines.changeRun(f.athlete, {
      runId: f.run.run.id,
      action: 'pause',
      expectedRevision: f.run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    expect(
      await f.routines.changeRun(f.athlete, {
        runId: paused.run.id,
        action: 'stop',
        expectedRevision: paused.run.revision,
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).toMatchObject({ run: { state: 'stopped' } });
    expect(
      await f.routines.changeSchedule(f.athlete, {
        scheduleId: f.pausedSchedule.schedule.id,
        expectedVersionId: f.pausedSchedule.schedule.versionId,
        action: 'end',
        previewDigest: f.pausedSchedule.impactDigest,
        idempotencyKey: randomUUID(),
        confirmed: true,
      }),
    ).toMatchObject({ schedule: { state: 'ended' } });
    expect(await actualFacts()).toEqual(before);
  });
  for (const name of ['nutrition.create', 'routine.record'] as const) {
    it(`serializes revoke before ${name} and denies the waiting writer without artifacts`, async () => {
      const f = await setup();
      const held = barrier();
      const release = barrier();
      const revoking = database.tenant(f.athlete, async (tx) => {
        await lockAppAdmission(tx);
        await tx.query("UPDATE consent SET granted=false,revision=revision+1 WHERE kind='app'");
        held.release();
        await release.ready;
      });
      await held.ready;
      const before = await facts(f.athlete);
      const writing = expect(f.execute[name]()).rejects.toBeInstanceOf(AppConsentRequiredError);
      try {
        await blocked();
      } finally {
        release.release();
      }
      await revoking;
      await writing;
      expect(await facts(f.athlete)).toEqual(before);
    });
    it(`serializes ${name} commit before waiting revocation and preserves its replay`, async () => {
      const f = await setup();
      const held = barrier();
      const release = barrier();
      const observed: Database = {
        ...database,
        tenant: (athlete, operation) =>
          database.tenant(athlete, (tx) =>
            operation({
              ...tx,
              query: async (sql, values) => {
                if (
                  sql.includes(
                    name === 'nutrition.create'
                      ? 'INSERT INTO intake_entry('
                      : 'UPDATE routine_run SET',
                  )
                ) {
                  held.release();
                  await release.ready;
                }
                return tx.query(sql, values);
              },
            }),
          ),
      };
      const key = randomUUID();
      const intakeId = randomUUID();
      const execute =
        name === 'nutrition.create'
          ? () =>
              createNutritionRepository(observed, {
                now: () => new Date('2026-09-19T00:00:00Z'),
              }).createIntake(f.athlete, {
                ...intake(f.savedFood.versionId, intakeId),
                idempotencyKey: key,
              })
          : () =>
              createRoutineRepository(observed).recordStep(f.athlete, {
                runId: f.run.run.id,
                stepId: f.step.id,
                state: 'stopped',
                actualRefs: [],
                occurredAt: happenedAt,
                reason: 'User stopped',
                expectedRevision: f.run.run.revision,
                idempotencyKey: key,
                confirmed: true,
              });
      const writing = execute();
      await held.ready;
      const revoking = consent(f.athlete, false, 1);
      try {
        await blocked();
      } finally {
        release.release();
      }
      const result = await writing;
      await revoking;
      const before = await facts(f.athlete);
      expect(await execute()).toEqual(result);
      expect(await facts(f.athlete)).toEqual(before);
    });
  }
});
