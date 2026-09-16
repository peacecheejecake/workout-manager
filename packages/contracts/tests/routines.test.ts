import { describe, expect, it } from 'vitest';
import {
  integratedDayV023Schema,
  actualRefSchema,
  finiteExpansionWindowSchema,
  integratedApprovalV023Schema,
  integratedCoachingBasisV023Schema,
  recoveryActionLogRevisionSchema,
  recoveryMethodVersionSchema,
  recoveryPlanItemSchema,
  recoveryStrategyVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleRuleSchema,
  routineScheduleVersionSchema,
  routineStepProgressSchema,
  stretchExerciseVersionSchema,
  stretchLogRevisionSchema,
  stretchTargetSchema,
} from '../src/routines.js';

const at = '2026-09-16T10:00:00Z';
const ref = { id: 'content', versionId: 'v1' };
const step = {
  id: 's1',
  title: 'Check',
  content: { kind: 'checklist', prompt: 'Ready?' },
  timing: { kind: 'ordered', afterStepId: null },
  required: true,
  choiceGroupId: null,
};
const blueprint = {
  schemaVersion: 4,
  routineId: 'routine',
  versionId: 'v1',
  title: 'Routine',
  intent: '',
  status: 'draft',
  tags: [],
  steps: [step],
  choiceGroups: [],
  estimatedDurationSeconds: null,
  createdAt: at,
};
const window = {
  startDate: '2026-09-16',
  endDateExclusive: '2026-09-20',
  timezone: 'Asia/Seoul',
  maxOccurrences: 4,
};
const schedule = {
  schemaVersion: 4,
  id: 'schedule',
  versionId: 'v1',
  blueprint: ref,
  window,
  rule: { kind: 'dates', dates: ['2026-09-16'], localTime: '09:30' },
  state: 'active',
};
const actual = { kind: 'checklist_confirmation', id: 'confirmation', revisionId: 'r1' };
const progress = {
  stepId: 's1',
  revision: 1,
  state: 'performed',
  actualRefs: [actual],
  occurredAt: at,
  recordedAt: at,
  reason: null,
};
const run = {
  id: 'run',
  revision: 1,
  blueprint: ref,
  origin: { kind: 'unplanned' },
  state: 'in_progress',
  progress: [progress],
  selectedChoices: {},
  startedAt: at,
  endedAt: null,
};
const unknownSeconds = { value: null, unit: 's', status: 'unknown', evidenceIds: [] };
const targetSeconds = { min: 10, max: 20, unit: 's', basis: 'user_confirmed', evidenceIds: [] };
const stretchTarget = {
  id: 'target',
  exerciseVersionId: 'exercise-v1',
  side: 'left',
  method: 'static_hold',
  holdSeconds: targetSeconds,
  repetitions: null,
  countBasis: 'per_side',
  restAfterSeconds: null,
};
const method = {
  id: 'method',
  versionId: 'v1',
  title: 'Rest',
  category: 'rest',
  reviewState: 'unreviewed',
  intendedUse: '',
  applicability: [],
  cautions: [],
  resourceVersionIds: [],
  reviewedAt: null,
};
const strategy = {
  id: 'strategy',
  versionId: 'v1',
  title: 'Recovery',
  goal: '',
  startDate: window.startDate,
  endDateExclusive: window.endDateExclusive,
  timezone: window.timezone,
  selectedOptionId: 'rest',
  options: [{ id: 'rest', title: 'No added activity', actionRefs: [], rationaleEvidenceIds: [] }],
  missingInformation: [],
  reassessment: [],
};
const basis = {
  schemaVersion: 4,
  planHeads: [{ domain: 'routine_schedule', aggregateId: 'schedule', head: { kind: 'absent' } }],
  contextDependencies: [],
  preferenceRevision: 0,
  constraintRevision: 0,
  conversationRevision: 0,
  policyVersion: 'policy-v1',
  evidenceSnapshotId: 'evidence',
};
const approval = {
  schemaVersion: 4,
  proposalId: 'proposal',
  candidateId: 'candidate',
  proposalDigest: 'digest',
  writeDomains: ['routine_schedule'],
  expectedBasis: basis,
  idempotencyKey: 'request',
};

describe('routine blueprint composition', () => {
  it('preserves draft steps and frozen references without inventing actuals', () => {
    expect(routineBlueprintVersionSchema.parse(blueprint)).toEqual(blueprint);
    expect(
      routineBlueprintVersionSchema.safeParse({ ...blueprint, actualRefs: [actual] }).success,
    ).toBe(false);
  });
  it('rejects duplicate steps, unknown predecessors, and cycles', () => {
    expect(
      routineBlueprintVersionSchema.safeParse({ ...blueprint, steps: [step, step] }).success,
    ).toBe(false);
    for (const afterStepId of ['missing', 's1']) {
      expect(
        routineBlueprintVersionSchema.safeParse({
          ...blueprint,
          steps: [{ ...step, timing: { kind: 'ordered', afterStepId } }],
        }).success,
      ).toBe(false);
    }
    expect(
      routineBlueprintVersionSchema.safeParse({
        ...blueprint,
        steps: [
          { ...step, timing: { kind: 'ordered', afterStepId: 's2' } },
          { ...step, id: 's2', timing: { kind: 'ordered', afterStepId: 's1' } },
        ],
      }).success,
    ).toBe(false);
  });
  it('checks choice group membership in both directions', () => {
    const grouped = {
      ...blueprint,
      steps: [
        { ...step, choiceGroupId: 'g' },
        { ...step, id: 's2', choiceGroupId: 'g' },
      ],
      choiceGroups: [{ id: 'g', mode: 'one_of', stepIds: ['s1', 's2'] }],
    };
    expect(routineBlueprintVersionSchema.safeParse(grouped).success).toBe(true);
    expect(routineBlueprintVersionSchema.safeParse({ ...grouped, choiceGroups: [] }).success).toBe(
      false,
    );
    expect(
      routineBlueprintVersionSchema.safeParse({
        ...grouped,
        choiceGroups: [grouped.choiceGroups[0], grouped.choiceGroups[0]],
      }).success,
    ).toBe(false);
    expect(
      routineBlueprintVersionSchema.safeParse({ ...grouped, steps: [step, grouped.steps[1]] })
        .success,
    ).toBe(false);
  });
});

describe('finite routine schedule and anchors', () => {
  it('accepts a bounded explicit schedule and rejects dates outside its half-open interval', () => {
    expect(routineScheduleVersionSchema.parse(schedule)).toEqual(schedule);
    for (const dates of [['2026-09-20'], ['2026-09-15'], ['2026-09-16', '2026-09-16']]) {
      expect(
        routineScheduleVersionSchema.safeParse({ ...schedule, rule: { ...schedule.rule, dates } })
          .success,
      ).toBe(false);
    }
    expect(
      routineScheduleVersionSchema.safeParse({
        ...schedule,
        window: { ...window, maxOccurrences: 1 },
        rule: { ...schedule.rule, dates: ['2026-09-16', '2026-09-17'] },
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...window, endDateExclusive: window.startDate },
    { ...window, maxOccurrences: 0 },
    { ...window, timezone: 'Not/AZone' },
    { ...window, startDate: '2026-02-30' },
  ])('rejects invalid finite window %j', (value) =>
    expect(finiteExpansionWindowSchema.safeParse(value).success).toBe(false),
  );
  it.each([
    { kind: 'weekdays', weekdays: [0, 6], localTime: null },
    { kind: 'every_n_days', anchorDate: '2026-01-01', intervalDays: 2, localTime: '00:00' },
    { kind: 'period_days', periodId: 'period', offsetsDays: [0, 2], localTime: null },
    { kind: 'session_links', sessionIds: ['session'], point: 'end', offsetMinutes: -10 },
  ])('preserves explicit recurrence rule %j', (rule) =>
    expect(routineScheduleRuleSchema.parse(rule)).toEqual(rule),
  );
  it.each([
    { kind: 'weekdays', weekdays: [7], localTime: null },
    { kind: 'every_n_days', anchorDate: '2026-01-01', intervalDays: 0, localTime: null },
    { kind: 'period_days', periodId: 'period', offsetsDays: [1, 1], localTime: null },
    { kind: 'session_links', sessionIds: [], point: 'end', offsetMinutes: 0 },
  ])('rejects invalid recurrence %j', (rule) =>
    expect(routineScheduleRuleSchema.safeParse(rule).success).toBe(false),
  );
  it('keeps unresolved anchors null and enforces unique bindings', () => {
    const occurrence = {
      id: 'occurrence',
      schedule: ref,
      blueprint: ref,
      anchorKey: 'session:end',
      scheduledAt: null,
      timingStatus: 'unresolved',
      stepBindings: [],
      selectedChoices: {},
    };
    expect(routineOccurrenceSchema.parse(occurrence)).toEqual(occurrence);
    expect(routineOccurrenceSchema.safeParse({ ...occurrence, scheduledAt: at }).success).toBe(
      false,
    );
    expect(
      routineOccurrenceSchema.safeParse({ ...occurrence, timingStatus: 'resolved' }).success,
    ).toBe(false);
    const binding = {
      stepId: 'step',
      plannedRef: { domain: 'training', planId: 'p', versionId: 'v', itemId: 'i' },
    };
    expect(
      routineOccurrenceSchema.safeParse({ ...occurrence, stepBindings: [binding, binding] })
        .success,
    ).toBe(false);
  });
});

describe('run progress and actual references', () => {
  it('requires actual evidence for performed/partial progress and keeps stopped distinct', () => {
    expect(routineStepProgressSchema.parse(progress)).toEqual(progress);
    expect(routineStepProgressSchema.safeParse({ ...progress, actualRefs: [] }).success).toBe(
      false,
    );
    expect(
      routineStepProgressSchema.safeParse({ ...progress, state: 'partial', occurredAt: null })
        .success,
    ).toBe(false);
    expect(routineStepProgressSchema.safeParse({ ...progress, state: 'pending' }).success).toBe(
      false,
    );
    expect(
      routineStepProgressSchema.safeParse({ ...progress, actualRefs: [actual, actual] }).success,
    ).toBe(false);
    expect(
      routineStepProgressSchema.safeParse({
        ...progress,
        state: 'stopped',
        actualRefs: [],
        occurredAt: null,
      }).success,
    ).toBe(true);
    expect(
      routineStepProgressSchema.safeParse({
        ...progress,
        state: 'confirmed_skipped',
        actualRefs: [{ kind: 'recovery_log', id: 'skip', revisionId: 'r1' }],
      }).success,
    ).toBe(true);
  });
  it('rejects conflicting revisions of the same actual but preserves distinct activity allocations', () => {
    expect(
      routineStepProgressSchema.safeParse({
        ...progress,
        actualRefs: [actual, { ...actual, revisionId: 'r2' }],
      }).success,
    ).toBe(false);
    const activity = {
      kind: 'activity',
      id: 'activity',
      revisionId: 'r1',
      detailId: 'detail',
      allocationId: 'allocation-1',
    };
    expect(
      routineStepProgressSchema.safeParse({
        ...progress,
        actualRefs: [activity, { ...activity, allocationId: 'allocation-2' }],
      }).success,
    ).toBe(true);
  });
  it('accepts ledger references, not synthetic actual durations', () => {
    expect(
      actualRefSchema.safeParse({
        kind: 'activity',
        id: 'activity',
        revisionId: 'revision',
        detailId: null,
        allocationId: null,
      }).success,
    ).toBe(true);
    expect(actualRefSchema.safeParse({ ...actual, duration: 50 }).success).toBe(false);
  });
  it('checks lifecycle timestamps without requiring all steps performed on end', () => {
    expect(routineRunSchema.parse(run)).toEqual(run);
    expect(routineRunSchema.safeParse({ ...run, state: 'ended' }).success).toBe(false);
    expect(
      routineRunSchema.safeParse({ ...run, state: 'ended', endedAt: '2026-09-15T10:00:00Z' })
        .success,
    ).toBe(false);
    expect(routineRunSchema.safeParse({ ...run, progress: [progress, progress] }).success).toBe(
      false,
    );
    expect(
      routineRunSchema.safeParse({
        ...run,
        state: 'ended',
        endedAt: at,
        progress: [{ ...progress, state: 'pending', actualRefs: [], occurredAt: null }],
      }).success,
    ).toBe(true);
  });
});

describe('stretching dimensions and recovery ledgers', () => {
  it('keeps static holds and dynamic repetition targets distinct', () => {
    expect(stretchTargetSchema.parse(stretchTarget)).toEqual(stretchTarget);
    expect(stretchTargetSchema.safeParse({ ...stretchTarget, holdSeconds: null }).success).toBe(
      false,
    );
    const repetitions = { ...targetSeconds, unit: 'count' };
    expect(
      stretchTargetSchema.safeParse({
        ...stretchTarget,
        method: 'dynamic_repetition',
        holdSeconds: null,
        repetitions,
      }).success,
    ).toBe(true);
    expect(stretchTargetSchema.safeParse({ ...stretchTarget, repetitions }).success).toBe(false);
    expect(
      stretchTargetSchema.safeParse({
        ...stretchTarget,
        holdSeconds: { ...targetSeconds, unit: 'min' },
      }).success,
    ).toBe(false);
  });
  it('retains unknown observed amounts rather than copying targets', () => {
    const log = {
      id: 'log',
      revisionId: 'r1',
      activityId: 'activity',
      executionId: 'execution',
      plannedTargetId: null,
      exerciseVersionId: 'exercise',
      side: 'left',
      state: 'partial',
      holdSeconds: unknownSeconds,
      repetitions: { ...unknownSeconds, unit: 'count' },
      countBasis: 'unspecified',
      occurredAt: at,
      recordedAt: at,
      checkInIds: [],
      reason: null,
    };
    expect(stretchLogRevisionSchema.parse(log)).toEqual(log);
    expect(
      stretchLogRevisionSchema.safeParse({ ...log, holdSeconds: { ...unknownSeconds, value: 10 } })
        .success,
    ).toBe(false);
    expect(stretchLogRevisionSchema.safeParse({ ...log, state: 'pending' }).success).toBe(false);
  });
  it('requires a review timestamp only for reviewed methods', () => {
    expect(recoveryMethodVersionSchema.parse(method)).toEqual(method);
    expect(
      recoveryMethodVersionSchema.safeParse({ ...method, reviewState: 'reviewed_for_stated_use' })
        .success,
    ).toBe(false);
    expect(
      recoveryMethodVersionSchema.safeParse({
        ...method,
        reviewState: 'reviewed_for_stated_use',
        reviewedAt: at,
      }).success,
    ).toBe(true);
  });
  it('supports a rest option with no added activity and validates selected options', () => {
    expect(recoveryStrategyVersionSchema.parse(strategy)).toEqual(strategy);
    expect(
      recoveryStrategyVersionSchema.safeParse({ ...strategy, selectedOptionId: 'missing' }).success,
    ).toBe(false);
    expect(
      recoveryStrategyVersionSchema.safeParse({
        ...strategy,
        options: [...strategy.options, ...strategy.options],
      }).success,
    ).toBe(false);
    expect(
      recoveryStrategyVersionSchema.safeParse({ ...strategy, endDateExclusive: strategy.startDate })
        .success,
    ).toBe(false);
  });
  it('rejects duplicate reassessment identities', () => {
    const reassessment = {
      id: 'check',
      trigger: 'user_report_changed',
      plannedAt: null,
      description: '',
      policyVersion: null,
    };
    expect(
      recoveryStrategyVersionSchema.safeParse({ ...strategy, reassessment: [reassessment] })
        .success,
    ).toBe(true);
    expect(
      recoveryStrategyVersionSchema.safeParse({
        ...strategy,
        reassessment: [reassessment, reassessment],
      }).success,
    ).toBe(false);
  });
  it('does not require a plan for recovery actuals or manufacture an activity', () => {
    const log = {
      id: 'log',
      revisionId: 'r1',
      method: ref,
      plannedItemId: null,
      occurredAt: at,
      recordedAt: at,
      state: 'unconfirmed',
      duration: unknownSeconds,
      beforeCheckInId: null,
      afterCheckInId: null,
      userNotes: null,
    };
    expect(recoveryActionLogRevisionSchema.parse(log)).toEqual(log);
    expect(recoveryActionLogRevisionSchema.safeParse({ ...log, activityId: 'fake' }).success).toBe(
      false,
    );
    expect(
      recoveryPlanItemSchema.safeParse({
        id: 'item',
        planVersionId: 'v',
        strategy: null,
        method: ref,
        scheduledAt: null,
        userInstructions: '',
        reviewAt: null,
      }).success,
    ).toBe(true);
  });
  it('reuses the shared exercise catalog while adding stretching dimensions', () => {
    const exercise = {
      exerciseId: 'exercise',
      versionId: 'v1',
      name: 'Stretch',
      family: 'stretching',
      equipment: [],
      tags: [],
      countDefinitions: [],
      mediaAssetIds: [],
      resourceVersionIds: [],
      reviewState: 'unreviewed',
      method: 'static_hold',
      movementMode: 'active',
      assistance: 'self',
      bodyRegionTags: [],
      contextTags: [],
      instructionText: '',
      cautionText: '',
    };
    expect(stretchExerciseVersionSchema.parse(exercise)).toEqual(exercise);
    expect(
      stretchExerciseVersionSchema.safeParse({ ...exercise, family: 'mobility' }).success,
    ).toBe(false);
    expect(
      stretchExerciseVersionSchema.safeParse({ family: 'stretching', clinicalEfficacy: 100 })
        .success,
    ).toBe(false);
  });
});

describe('v4 integrated approval manifests', () => {
  it('preserves absent heads as explicit creation expectations', () => {
    expect(integratedApprovalV023Schema.parse(approval)).toEqual(approval);
    expect(integratedApprovalV023Schema.safeParse({ ...approval, schemaVersion: 3 }).success).toBe(
      false,
    );
    expect(
      integratedCoachingBasisV023Schema.safeParse({
        ...basis,
        planHeads: [
          {
            domain: 'routine_schedule',
            aggregateId: 'schedule',
            head: { kind: 'absent', versionId: 'wildcard' },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('allows multiple aggregates per domain but never duplicate aggregate expectations', () => {
    expect(
      integratedCoachingBasisV023Schema.safeParse({
        ...basis,
        planHeads: [
          ...basis.planHeads,
          {
            domain: 'routine_schedule',
            aggregateId: 'schedule2',
            head: { kind: 'exists', versionId: 'v1' },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      integratedCoachingBasisV023Schema.safeParse({
        ...basis,
        planHeads: [...basis.planHeads, ...basis.planHeads],
      }).success,
    ).toBe(false);
  });
  it('requires nonempty unique write domains and corresponding head expectations', () => {
    for (const writeDomains of [
      [],
      ['routine_schedule', 'routine_schedule'],
      ['training'],
      ['arbitrary'],
    ]) {
      expect(integratedApprovalV023Schema.safeParse({ ...approval, writeDomains }).success).toBe(
        false,
      );
    }
  });
  it('rejects contradictory dependency revisions', () => {
    expect(
      integratedCoachingBasisV023Schema.safeParse({
        ...basis,
        contextDependencies: [
          { kind: 'actual', id: 'a', revision: 'r1' },
          { kind: 'actual', id: 'a', revision: 'r2' },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('v4 day projection', () => {
  it('preserves wrapper IDs without duplicating actual activity IDs', () => {
    const day = {
      schemaVersion: 4,
      date: '2026-09-16',
      timezone: 'Asia/Seoul',
      blockId: null,
      plannedSessionIds: [],
      activityIds: ['activity'],
      knownRest: false,
      nutritionPlanItemIds: [],
      intakeEntryIds: [],
      recoveryPlanItemIds: [],
      recoveryActionLogIds: [],
      routineOccurrenceIds: [],
      routineRunIds: ['run'],
      stretchingSessionIds: ['activity'],
    };
    expect(integratedDayV023Schema.parse(day)).toEqual(day);
    expect(
      integratedDayV023Schema.safeParse({ ...day, activityIds: ['activity', 'activity'] }).success,
    ).toBe(false);
    expect(integratedDayV023Schema.safeParse({ ...day, schemaVersion: 2 }).success).toBe(false);
  });
});
