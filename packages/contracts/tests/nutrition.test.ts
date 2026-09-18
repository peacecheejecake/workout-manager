import { describe, expect, it } from 'vitest';

import {
  integratedDayProjectionSchema,
  setTargetSchema,
  executionTimerStateSchema,
  externalResistanceSchema,
  intakeCoverageSchema,
  intakeEntryRevisionSchema,
  jointApprovalRequestSchema,
  jointDomainsSchema,
  metricDatumSchema,
  nutrientSnapshotSchema,
  nutritionAnchorSchema,
  nutritionPlanItemSchema,
  numericTargetSchema,
  setLogRevisionSchema,
  supplementaryWorkoutSpecSchema,
} from '../src/nutrition.js';

const start = '2026-09-16T10:00:00Z';
const end = '2026-09-16T11:00:00Z';
const datum = <U extends string>(unit: U, value: number | null = 0) => ({
  value,
  unit,
  status: value === null ? ('unknown' as const) : ('reported' as const),
  evidenceIds: [],
});
const snapshot = {
  energy: datum('kcal'),
  carbohydrate: datum('g'),
  protein: datum('g'),
  fat: datum('g'),
  fluid: datum('mL'),
  sodium: datum('mg', null),
};
const target = (unit: string) => ({
  min: 0,
  max: 10,
  unit,
  basis: 'draft_suggestion',
  evidenceIds: [],
});
const training = { planVersionId: 'plan-1', activityDataRevision: 0, exerciseCatalogRevision: 0 };
const nutrition = { planVersionId: null, intakeDataRevision: 0, foodCatalogRevision: 0 };

describe('v0.2.2 measurements and targets', () => {
  it('keeps unknown and known zero distinct', () => {
    expect(metricDatumSchema('g').parse(datum('g', null)).value).toBeNull();
    expect(metricDatumSchema('g').parse(datum('g')).value).toBe(0);
    expect(nutrientSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it.each([
    { ...datum('g'), status: 'unknown' },
    { ...datum('g', null), status: 'measured' },
    datum('mg'),
    datum('g', -1),
    datum('g', Infinity),
    datum('g', NaN),
    { ...datum('g'), actual: true },
  ])('rejects inconsistent, nonfinite, negative or wrong-unit data: %j', (value) => {
    expect(metricDatumSchema('g').safeParse(value).success).toBe(false);
  });
  it('enforces finite ordered nonnegative targets', () => {
    expect(numericTargetSchema('g').safeParse(target('g')).success).toBe(true);
    for (const amount of [
      { ...target('g'), min: 11 },
      { ...target('g'), min: -1 },
      { ...target('g'), max: Infinity },
    ]) {
      expect(numericTargetSchema('g').safeParse(amount).success).toBe(false);
    }
  });
  it('validates nutrient-specific dimensions', () => {
    expect(nutrientSnapshotSchema.safeParse({ ...snapshot, fluid: datum('g') }).success).toBe(
      false,
    );
    const plan = {
      id: 'meal-1',
      planVersionId: 'plan-1',
      category: 'meal',
      title: 'Lunch',
      anchor: {
        kind: 'relative',
        entity: 'session',
        entityId: 'session-1',
        point: 'end',
        offsetMinutes: -30,
      },
      foods: [],
      targets: [{ metric: 'energy', amount: target('kcal') }],
      instructions: '',
      evidenceIds: [],
    };
    expect(nutritionPlanItemSchema.parse(plan)).toEqual(plan);
    expect(nutritionPlanItemSchema.safeParse({ ...plan, nutrientTotal: snapshot }).success).toBe(
      false,
    );
    expect(
      nutritionPlanItemSchema.safeParse({
        ...plan,
        targets: [{ metric: 'energy', amount: target('g') }],
      }).success,
    ).toBe(false);
  });
  it('preserves unresolved relative anchors and absent local time', () => {
    expect(
      nutritionAnchorSchema.safeParse({
        kind: 'absolute',
        date: '2026-09-16',
        localTime: null,
        timezone: 'Asia/Seoul',
      }).success,
    ).toBe(true);
    expect(
      nutritionAnchorSchema.safeParse({
        kind: 'absolute',
        date: '2026-02-30',
        localTime: '25:00',
        timezone: 'fake/zone',
      }).success,
    ).toBe(false);
  });
});

describe('intake and exercise actuals', () => {
  it('validates intake source, ordered timestamps and nutrient totals', () => {
    const entry = {
      intakeId: 'intake-1',
      revisionId: 'rev-1',
      occurredAt: start,
      recordedAt: end,
      timezone: 'Asia/Seoul',
      foods: [],
      nutrientTotal: snapshot,
      plannedItemId: null,
      relatedSessionIds: [],
      relatedActivityIds: [],
      source: 'user',
      sourceRecordId: null,
      notes: null,
    };
    expect(intakeEntryRevisionSchema.parse(entry)).toEqual(entry);
    expect(
      intakeEntryRevisionSchema.safeParse({ ...entry, recordedAt: '2026-09-15T10:00:00Z' }).success,
    ).toBe(false);
  });
  it('validates coverage ordering and subset counts without inferring completeness', () => {
    const coverage = {
      from: start,
      toExclusive: end,
      status: 'partial',
      knownEntries: 3,
      entriesWithUnknownNutrients: 1,
    };
    expect(intakeCoverageSchema.parse(coverage)).toEqual(coverage);
    for (const invalid of [
      { ...coverage, toExclusive: start },
      { ...coverage, entriesWithUnknownNutrients: 4 },
      { ...coverage, knownEntries: 1.5 },
    ]) {
      expect(intakeCoverageSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('distinguishes no added load from unknown and validates resistance units', () => {
    expect(externalResistanceSchema.parse({ kind: 'no_added_load' })).toEqual({
      kind: 'no_added_load',
    });
    expect(
      externalResistanceSchema.safeParse({ kind: 'unknown', totalKg: datum('kg') }).success,
    ).toBe(false);
    expect(
      externalResistanceSchema.safeParse({ kind: 'assisted', assistanceKg: datum('kg', null) })
        .success,
    ).toBe(true);
    expect(
      externalResistanceSchema.safeParse({ kind: 'external', totalKg: datum('g') }).success,
    ).toBe(false);
  });
  it('accepts zero effort and unknown actuals without converting them to performed', () => {
    const log = {
      logId: 'log-1',
      revisionId: 'rev-1',
      activityId: 'activity-1',
      executionId: 'exec-1',
      targetSetId: null,
      blockId: null,
      roundIndex: null,
      exerciseVersionId: 'exercise-v1',
      side: 'unspecified',
      state: 'unconfirmed',
      count: null,
      durationSeconds: datum('s', null),
      externalResistance: { kind: 'unknown' },
      effort: { rir: 0, rpe: 0, scaleVersion: 'rpe-10-v1' },
      occurredAt: start,
      recordedAt: end,
      reason: null,
    };
    expect(setLogRevisionSchema.parse(log)).toEqual(log);
    expect(
      setLogRevisionSchema.safeParse({ ...log, effort: { ...log.effort, rpe: 11 } }).success,
    ).toBe(false);
    expect(
      setLogRevisionSchema.safeParse({ ...log, durationSeconds: datum('s', -1) }).success,
    ).toBe(false);
  });
  it('requires bounded integer round counts and explicit version', () => {
    const workout = {
      schemaVersion: 2,
      kind: 'supplementary',
      routineVersionId: null,
      blocks: [
        { id: 'block-1', mode: 'single', rounds: 1, sets: [], restBetweenRoundsSeconds: null },
      ],
    };
    expect(supplementaryWorkoutSpecSchema.safeParse(workout).success).toBe(true);
    expect(supplementaryWorkoutSpecSchema.safeParse({ ...workout, schemaVersion: 1 }).success).toBe(
      false,
    );
    expect(
      supplementaryWorkoutSpecSchema.safeParse({
        ...workout,
        blocks: [{ ...workout.blocks[0], rounds: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('execution timers', () => {
  const running = {
    startedAt: start,
    deadlineAt: end,
    pausedAt: null,
    remainingWhenPausedSeconds: null,
    status: 'running',
  };
  it('keeps timer completion separate from actual creation', () => {
    expect(executionTimerStateSchema.parse({ ...running, status: 'finished' })).toEqual({
      ...running,
      status: 'finished',
    });
    expect(
      executionTimerStateSchema.safeParse({
        ...running,
        status: 'finished',
        activityId: 'synthetic',
      }).success,
    ).toBe(false);
  });
  it('requires paired paused fields and nonnegative duration', () => {
    expect(
      executionTimerStateSchema.safeParse({
        ...running,
        status: 'paused',
        pausedAt: start,
        remainingWhenPausedSeconds: 0,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...running, status: 'paused' },
      { ...running, pausedAt: start },
      { ...running, remainingWhenPausedSeconds: 0 },
      { ...running, status: 'paused', pausedAt: start, remainingWhenPausedSeconds: -1 },
      { ...running, deadlineAt: '2026-09-15T10:00:00Z' },
    ])
      expect(executionTimerStateSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('joint schema 3 approval compatibility', () => {
  it('requires exactly the domains selected by write scope', () => {
    for (const domains of [
      { scope: 'training', training, nutrition: null },
      { scope: 'nutrition', training: null, nutrition },
      { scope: 'combined', training, nutrition },
    ]) {
      expect(jointDomainsSchema.safeParse(domains).success).toBe(true);
    }
    expect(jointDomainsSchema.safeParse({ scope: 'training', training, nutrition }).success).toBe(
      false,
    );
    expect(
      jointDomainsSchema.safeParse({ scope: 'combined', training, nutrition: null }).success,
    ).toBe(false);
  });
  it('preserves absent nutrition plan heads and never migrates schema versions implicitly', () => {
    const request = {
      schemaVersion: 3,
      confirmed: true,
      proposalId: 'proposal-1',
      candidateId: 'candidate-1',
      proposalDigest: 'a'.repeat(64),
      expectedBasis: {
        schemaVersion: 3,
        domains: { scope: 'combined', training, nutrition },
        contextDependencies: [{ kind: 'recovery', id: 'recovery-1', revision: 'revision-1' }],
        preferenceRevision: 0,
        constraintRevision: 0,
        conversationRevision: 0,
        policyVersion: 'policy-1',
        evidenceSnapshotId: 'snapshot-1',
      },
      idempotencyKey: 'approval-1',
    };
    expect(jointApprovalRequestSchema.parse(request)).toEqual(request);
    expect(jointApprovalRequestSchema.safeParse({ ...request, confirmed: false }).success).toBe(
      false,
    );
    expect(jointApprovalRequestSchema.safeParse({ ...request, schemaVersion: 4 }).success).toBe(
      false,
    );
    expect(jointApprovalRequestSchema.safeParse({ ...request, idempotencyKey: '' }).success).toBe(
      false,
    );
    expect(
      jointApprovalRequestSchema.safeParse({
        ...request,
        expectedBasis: { ...request.expectedBasis, conversationRevision: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('supplementary plans and projections', () => {
  it('keeps supplementary IDs as a subset instead of adding sessions', () => {
    const day = {
      schemaVersion: 2,
      date: '2026-09-16',
      timezone: 'Asia/Seoul',
      blockId: null,
      plannedSessionIds: ['session-1'],
      activityIds: [],
      knownRest: false,
      nutritionPlanItemIds: [],
      intakeEntryIds: [],
      supplementarySessionIds: ['session-1'],
    };
    expect(integratedDayProjectionSchema.parse(day)).toEqual(day);
    expect(
      integratedDayProjectionSchema.safeParse({ ...day, supplementarySessionIds: ['extra'] })
        .success,
    ).toBe(false);
  });
  it('validates target quantities without treating them as observations', () => {
    const set = {
      id: 'set-1',
      exerciseVersionId: 'exercise-1',
      side: 'bilateral',
      count: {
        target: target('count'),
        definition: { kind: 'repetitions', basis: 'total', definitionId: 'reps-v1' },
      },
      durationSeconds: null,
      externalResistance: { kind: 'no_added_load' },
      restAfterSeconds: 0,
      tempo: null,
      effort: { rir: 0, rpe: 0, scaleVersion: 'rpe-v1' },
    };
    expect(setTargetSchema.parse(set)).toEqual(set);
    expect(setTargetSchema.safeParse({ ...set, durationSeconds: datum('s') }).success).toBe(false);
    expect(setTargetSchema.safeParse({ ...set, restAfterSeconds: -1 }).success).toBe(false);
  });
});
