import { describe, expect, it } from 'vitest';
import {
  activityContextSchema,
  activityDistanceComparisonSchema,
  type ActivityContext,
} from '../src/activity-context.js';

function linked(): ActivityContext {
  const empty = { value: null, knownCount: 0, missingCount: 0 };
  const values = {
    title: 'Synthetic actual',
    kind: 'running' as const,
    startedAt: '2024-03-10T07:30:00Z',
    timezone: 'America/New_York',
    distanceMeters: 0,
    durationSeconds: null,
    durationKind: 'timer' as const,
  };
  return {
    definitionVersion: 'activity-context-v1',
    observedAt: '2024-03-11T00:00:00Z',
    activityDataRevision: { count: 1, revisionSum: '1' },
    activity: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      source: {
        kind: 'manual',
        sourceId: 'synthetic-source',
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
      original: values,
      effective: values,
      overlay: {},
      userReport: {
        sessionRpe: null,
        note: null,
        planLink: { planVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionId: 'run' },
        definitionVersion: 'activity-report-v1',
        source: 'user',
        method: 'self_report',
        rpeReportedAt: null,
      },
    },
    planContext: {
      status: 'linked',
      planVersion: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        version: 1,
        title: 'Synthetic plan',
      },
      currentPlanVersionId: null,
      session: {
        id: 'run',
        blockId: 'block',
        date: '2024-03-10',
        localStartTime: null,
        title: 'Synthetic planned run',
        sport: 'running',
        durationSeconds: 600,
        distanceMeters: 1000,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
      block: {
        id: 'block',
        parentId: 'phase',
        level: 'block',
        title: 'Block',
        startDate: '2024-03-01',
        endDateExclusive: '2024-03-11',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      },
      actualLocalDate: '2024-03-10',
      blockMembership: 'included',
      blockActual: {
        count: 1,
        distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
        durationSeconds: {
          timer: { value: null, knownCount: 0, missingCount: 1 },
          elapsed: empty,
          moving: empty,
          unknown: empty,
        },
        sources: { fit: 0, fixture: 0, manual: 1 },
        overlayCount: 0,
      },
      distanceComparison: { actual: 0, planned: 1000, delta: -1000, status: 'available' },
      durationComparison: {
        actual: null,
        actualKind: 'timer',
        planned: 600,
        delta: null,
        status: 'not_comparable',
        reason: 'planned_duration_definition_missing',
      },
      coverage: 'unknown',
    },
  };
}
describe('activity context observations and explicit plan links', () => {
  it('preserves known zero, missing duration and an older linked snapshot', () => {
    expect(activityContextSchema.parse(linked())).toEqual(linked());
  });
  it.each([
    { actual: 0, planned: 0, delta: 0, status: 'available' },
    { actual: null, planned: 0, delta: null, status: 'missing_actual' },
    { actual: 0, planned: null, delta: null, status: 'missing_plan' },
    { actual: null, planned: null, delta: null, status: 'missing_both' },
  ])('distinguishes missing distances from zero: %j', (input) => {
    expect(activityDistanceComparisonSchema.parse(input)).toEqual(input);
    expect(activityDistanceComparisonSchema.safeParse({ ...input, delta: 123 }).success).toBe(
      false,
    );
  });
  it('does not fabricate a plan from a date or hide a stored explicit link', () => {
    const value = linked();
    expect(
      activityContextSchema.safeParse({ ...value, planContext: { status: 'unlinked' } }).success,
    ).toBe(false);
    expect(
      activityContextSchema.parse({
        ...value,
        activity: { ...value.activity, userReport: null },
        planContext: { status: 'unlinked' },
      }).planContext.status,
    ).toBe('unlinked');
    expect(
      activityContextSchema.parse({
        ...value,
        planContext: { status: 'unavailable', reason: 'linked_plan_unavailable' },
      }).planContext.status,
    ).toBe('unavailable');
    expect(
      activityContextSchema.safeParse({
        ...value,
        activity: { ...value.activity, userReport: null },
      }).success,
    ).toBe(false);
  });
  it('rejects mixed activity, plan, session and membership results', () => {
    const value = linked();
    const plan = value.planContext;
    if (plan.status !== 'linked') throw new Error('fixture');
    for (const changed of [
      { ...plan, planVersion: { ...plan.planVersion, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
      { ...plan, session: { ...plan.session, id: 'other' } },
      { ...plan, session: { ...plan.session, blockId: 'other' } },
      { ...plan, blockMembership: 'outside' },
      { ...plan, actualLocalDate: null },
      {
        ...plan,
        distanceComparison: { actual: 10, planned: 1000, delta: -990, status: 'available' },
      },
      { ...plan, durationComparison: { ...plan.durationComparison, actualKind: 'elapsed' } },
      { ...plan, durationComparison: { ...plan.durationComparison, delta: 0 } },
      { ...plan, coverage: 'complete' },
    ])
      expect(activityContextSchema.safeParse({ ...value, planContext: changed }).success).toBe(
        false,
      );
  });
  it('keeps unavailable time and explicit outside-period membership separate', () => {
    const value = linked();
    const plan = value.planContext;
    if (plan.status !== 'linked') throw new Error('fixture');
    expect(
      activityContextSchema.parse({
        ...value,
        planContext: { ...plan, actualLocalDate: '2024-03-11', blockMembership: 'outside' },
      }).planContext.status,
    ).toBe('linked');
    expect(
      activityContextSchema.parse({
        ...value,
        activity: {
          ...value.activity,
          effective: { ...value.activity.effective, startedAt: null, timezone: null },
        },
        planContext: { ...plan, actualLocalDate: null, blockMembership: 'unknown_time' },
      }).planContext.status,
    ).toBe('linked');
  });
});
