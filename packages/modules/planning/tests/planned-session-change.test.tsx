import { describe, expect, it } from 'vitest';
import type { PlanDraft, PlannedSession } from '@workout/contracts/planning';
import { plannedSessionChanges } from '../src/planned-session-change';
import { samePlanValue } from '../src/plan-value-equality';
function fixture(): PlanDraft {
  return {
    title: 'Plan',
    timezone: 'UTC',
    periods: [
      {
        id: 'block',
        parentId: null,
        level: 'block',
        title: 'Block',
        startDate: '2026-09-17',
        endDateExclusive: '2026-09-18',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-09-17',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [
          {
            id: 'warmup',
            kind: 'warmup',
            durationSeconds: 60,
            distanceMeters: null,
            repetitions: 1,
          },
          { id: 'work', kind: 'work', durationSeconds: 120, distanceMeters: null, repetitions: 2 },
        ],
      },
    ],
  };
}
function changed(patch: Partial<PlannedSession>) {
  const baseline = fixture();
  const source = {
    ...baseline,
    sessions: baseline.sessions.map((session) => ({ ...session, ...patch })),
  };
  return plannedSessionChanges(source, { kind: 'draft', baseline }).get('session');
}
describe('session draft markers', () => {
  it('distinguishes saved, unchanged and initial unsaved sessions', () => {
    const source = fixture();
    expect(plannedSessionChanges(source, { kind: 'saved' }).get('session')).toBe('saved');
    expect(
      plannedSessionChanges(source, { kind: 'draft', baseline: structuredClone(source) }).get(
        'session',
      ),
    ).toBe('unchanged');
    expect(plannedSessionChanges(source, { kind: 'draft', baseline: null }).get('session')).toBe(
      'added',
    );
  });
  it('ignores object key order but preserves nested array order and values', () => {
    const baseline = fixture();
    const source = structuredClone(baseline);
    source.sessions = source.sessions.map((session) => ({
      ...Object.fromEntries(Object.entries(session).reverse()),
      ...session,
      locks: { intensity: false, time: false, date: false },
    }));
    expect(plannedSessionChanges(source, { kind: 'draft', baseline }).get('session')).toBe(
      'unchanged',
    );
    const steps = fixture().sessions[0]?.steps;
    if (!steps) throw new Error('Missing steps');
    expect(changed({ steps: [...steps].reverse() })).toBe('changed');
    expect(changed({ steps: steps.map((step) => ({ ...step, repetitions: 3 })) })).toBe('changed');
  });
  it.each([
    { distanceMeters: 0 },
    { paceTarget: null },
    { heartRateTarget: { minBpm: 120, maxBpm: 140 } },
    { durationSeconds: null, durationRange: { minSeconds: 0, maxSeconds: 60 } },
    { locks: { date: false, time: false, intensity: false, attendance: false } },
    { locks: { date: true, time: false, intensity: false } },
    { blockId: 'other-block' },
    { notes: 'Changed' },
  ] satisfies Partial<PlannedSession>[])('marks meaningful field changes %#', (patch) => {
    expect(changed(patch)).toBe('changed');
  });
  it('marks inherited timezone changes but ignores plan title and period metadata', () => {
    const baseline = fixture();
    expect(
      plannedSessionChanges(
        { ...baseline, timezone: 'Asia/Seoul' },
        { kind: 'draft', baseline },
      ).get('session'),
    ).toBe('changed');
    expect(
      plannedSessionChanges(
        {
          ...baseline,
          title: 'Renamed',
          periods: baseline.periods.map((period) => ({
            ...period,
            title: 'Other',
            intent: 'Other intent',
            timezone: 'Asia/Seoul',
          })),
        },
        { kind: 'draft', baseline },
      ).get('session'),
    ).toBe('unchanged');
  });
  it('uses stable IDs, omits deleted rows and recomputes after undo or duplication without mutating inputs', () => {
    const baseline = fixture();
    const copy = structuredClone(baseline);
    const source = {
      ...baseline,
      sessions: baseline.sessions.map((session) => ({ ...session, id: 'copy' })),
    };
    expect([...plannedSessionChanges(source, { kind: 'draft', baseline })]).toEqual([
      ['copy', 'added'],
    ]);
    expect([
      ...plannedSessionChanges({ ...baseline, sessions: [] }, { kind: 'draft', baseline }),
    ]).toEqual([]);
    expect(plannedSessionChanges(baseline, { kind: 'draft', baseline }).get('session')).toBe(
      'unchanged',
    );
    expect(baseline).toEqual(copy);
    expect(source.sessions[0]?.id).toBe('copy');
  });
  it('preserves historical key, absence, null and zero equality semantics', () => {
    expect(samePlanValue({ a: 0, b: null }, { b: null, a: 0 })).toBe(true);
    expect(samePlanValue({}, { a: undefined })).toBe(false);
    expect(samePlanValue({}, { a: null })).toBe(false);
    expect(samePlanValue({ a: null }, { a: 0 })).toBe(false);
    expect(samePlanValue([0, null], [null, 0])).toBe(false);
  });
});
