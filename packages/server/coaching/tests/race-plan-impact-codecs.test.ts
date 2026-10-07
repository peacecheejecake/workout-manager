import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';

import { projectRacePlanImpact, type RacePlanImpactInput } from '../src/race-plan-impact.js';
import {
  racePlanImpactResultSchema,
  racePlanConstraintDaySchema,
} from '../src/race-plan-impact-codecs.js';

const id = '10000000-0000-4000-8000-000000000001';
function fixture(): RacePlanImpactInput {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    event: { localDate: '2026-03-07', planVersionId: id },
    newLocalDate: '2026-03-09',
    currentPlan: planSnapshotSchema.parse({
      id,
      version: 1,
      createdAt: '2026-03-01T00:00:00Z',
      draft: {
        timezone: 'America/New_York',
        title: 'Calendar structure',
        periods: levels.map((level, index) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2026-03-01',
          endDateExclusive: '2026-04-01',
          timezone: 'America/New_York',
          intent: '',
          isPartial: false,
          ...(index === 0
            ? {
                constraints: {
                  unavailableDates: [],
                  dailyTimeLimits: [{ date: '2026-03-09', availableSeconds: 0 }],
                },
              }
            : {}),
        })),
        sessions: [
          {
            id: 'session',
            blockId: 'block',
            date: '2026-03-07',
            localStartTime: null,
            title: 'Planned session',
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
      },
    }),
    completionReports: [],
    selection: {
      kind: 'move_period',
      expectedCurrentPlanVersionId: id,
      periodId: 'season',
      newStartDate: '2026-03-03',
      scope: 'descendants_and_sessions',
    },
  };
}
function projected(input: unknown = fixture()) {
  const result = projectRacePlanImpact(input);
  if (result.status !== 'projected') throw Error(result.reason);
  return result;
}
it('roundtrips real projector through JSON including DST civil dates/null duration/zero available seconds', () => {
  const result = projected();
  expect(racePlanImpactResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(result.constraintDays[0]).toMatchObject({
    availableSeconds: 0,
    knownDurationSeconds: 0,
    durationRangeSeconds: null,
    unknownDurationSessionIds: ['session'],
    status: 'unknown',
  });
  expect(result.approval.status).toBe('blocked');
});
it('roundtrips current/absent/historical links and keeps public opaque current version IDs', () => {
  const f = fixture();
  f.selection = { kind: 'keep_plan' };
  f.event.planVersionId = null;
  if (!f.currentPlan) throw Error('fixture');
  f.currentPlan.id = 'public-opaque-plan-version';
  const opaque = projected(f);
  expect(racePlanImpactResultSchema.parse(opaque)).toEqual(opaque);
  f.currentPlan = null;
  const absent = projected(f);
  expect(racePlanImpactResultSchema.parse(absent)).toEqual(absent);
  const linked = fixture();
  linked.selection = { kind: 'keep_plan' };
  linked.event.planVersionId = '10000000-0000-4000-8000-000000000002';
  const decoded = racePlanImpactResultSchema.parse(projected(linked));
  if (decoded.status !== 'projected') throw Error('fixture');
  expect(decoded.linkedPlan.relationship).toBe('historical_or_other');
});
it.each([
  null,
  {},
  { ...fixture(), newLocalDate: '2026-02-30' },
  { ...fixture(), newLocalDate: '2040-01-01' },
  { ...fixture(), currentPlan: null },
])('roundtrips actual rejected projector result %i', (input) => {
  const result = projectRacePlanImpact(input);
  expect(result.status).toBe('rejected');
  expect(racePlanImpactResultSchema.parse(result)).toEqual(result);
});
it('exact duration zero remains distinct from unknown', () => {
  const f = fixture();
  const session = f.currentPlan?.draft.sessions[0];
  if (!session) throw Error('fixture');
  session.durationSeconds = 0;
  const result = projected(f);
  expect(racePlanImpactResultSchema.parse(result).status).toBe('projected');
  expect(result.constraintDays[0]).toMatchObject({
    knownDurationSeconds: 0,
    durationRangeSeconds: { min: 0, max: 0 },
    unknownDurationSessionIds: [],
    status: 'no_conflict',
  });
});
it.each([
  (r: ReturnType<typeof projected>) => ({ ...r, extra: true }),
  (r: ReturnType<typeof projected>) => ({ ...r, status: 'ready' }),
  (r: ReturnType<typeof projected>) => ({ ...r, approval: { ...r.approval, status: 'allowed' } }),
  (r: ReturnType<typeof projected>) => ({ ...r, approval: { ...r.approval, reasons: [] } }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    approval: { ...r.approval, reasons: [...r.approval.reasons, 'caller_confirmed'] },
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    eventDate: { ...r.eventDate, after: '2026-02-30' },
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    eventDate: { ...r.eventDate, deltaCalendarDays: 0 },
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    eventDate: { ...r.eventDate, deltaCalendarDays: 0.5 },
  }),
  (r: ReturnType<typeof projected>) => ({ ...r, currentPlanVersionId: null }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    linkedPlan: { ...r.linkedPlan, relationship: 'unlinked' },
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    periodDiffs: [...r.periodDiffs, ...r.periodDiffs],
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    sessionDiffs: [...r.sessionDiffs, ...r.sessionDiffs],
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    constraintDays: [...r.constraintDays, ...r.constraintDays],
  }),
  (r: ReturnType<typeof projected>) => ({ ...r, fixedSessionIds: ['foreign-session'] }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    sessionDiffs: r.sessionDiffs.map((d) => ({ ...d, id: 'foreign' })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    sessionDiffs: r.sessionDiffs.map((d) => ({ ...d, afterDate: '2026-03-10' })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    periodDiffs: r.periodDiffs.map((d) => ({
      ...d,
      after: { ...d.after, startDate: d.after.endDateExclusive },
    })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    constraintDays: r.constraintDays.map((d) => ({ ...d, status: 'completed' })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    constraintDays: r.constraintDays.map((d) => ({
      ...d,
      availableSeconds: null,
      knownDurationSeconds: -1,
    })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    constraintDays: r.constraintDays.map((d) => ({ ...d, unknownDurationSessionIds: ['foreign'] })),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    periodDiffs: Array.from({ length: 101 }, () => r.periodDiffs[0]),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    sessionDiffs: Array.from({ length: 1001 }, () => r.sessionDiffs[0]),
  }),
  (r: ReturnType<typeof projected>) => ({
    ...r,
    constraintDays: r.constraintDays.map((d) => ({ ...d, extra: true })),
  }),
])('rejects invalid result boundary %i', (change) => {
  expect(racePlanImpactResultSchema.safeParse(change(projected())).success).toBe(false);
});
it.each([
  { status: 'rejected', reason: 'unknown' },
  { status: 'rejected', reason: 'locked', authority: true },
  { status: 'projected', reason: 'invalid_input' },
  null,
])('rejects unknown reason/mixed status %j', (input) => {
  expect(racePlanImpactResultSchema.safeParse(input).success).toBe(false);
});
it('preserves valid range null and exact finite constraint quantities', () => {
  const day = projected().constraintDays[0];
  if (!day) throw Error('fixture');
  expect(racePlanConstraintDaySchema.parse(day)).toEqual(day);
  expect(
    racePlanConstraintDaySchema.safeParse({ ...day, durationRangeSeconds: { min: 2, max: 1 } })
      .success,
  ).toBe(false);
  expect(
    racePlanConstraintDaySchema.safeParse({ ...day, knownDurationSeconds: Infinity }).success,
  ).toBe(false);
});
it('rejects oversized/cyclic JSON while leaving legacy projector unchanged', () => {
  expect(racePlanImpactResultSchema.safeParse({ payload: 'x'.repeat(4194305) }).success).toBe(
    false,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(racePlanImpactResultSchema.safeParse(circular).success).toBe(false);
  expect(projectRacePlanImpact(fixture())).toEqual(projected());
});
