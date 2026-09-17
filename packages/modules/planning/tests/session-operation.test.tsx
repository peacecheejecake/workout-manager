import { describe, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import {
  applyPlannedSessionOperation,
  type PlannedSessionOperation,
} from '../src/session-operation';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

function fixture(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: '  Raw draft  ',
    timezone: 'America/New_York',
    periods: levels.map((level, index) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: ` ${level} `,
      startDate: '2026-03-01',
      endDateExclusive: '2026-04-01',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-03-07',
        localStartTime: null,
        title: '  Raw session  ',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Purpose',
        notes: 'Notes',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [
          { id: 'step', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 1 },
        ],
      },
    ],
  };
}
function run(
  draft: PlanDraft,
  operation: PlannedSessionOperation,
  baseline: PlanDraft | null = null,
) {
  return applyPlannedSessionOperation({
    draft,
    baseline,
    sessionId: 'session',
    today: '2026-03-01',
    operation,
  });
}
const move = { kind: 'move', date: '2026-03-08', blockId: 'block' } as const;

describe('planned session draft operations', () => {
  it('moves a local date across DST without guessing time and preserves raw text and source', () => {
    const draft = fixture();
    const original = structuredClone(draft);
    const result = run(draft, move);
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') throw new Error('Expected changed');
    expect(planDraftSchema.safeParse(result.draft).success).toBe(true);
    expect(result.draft.title).toBe('  Raw draft  ');
    expect(result.draft.periods).toEqual(original.periods);
    expect(result.draft.sessions[0]).toEqual({ ...original.sessions[0], date: '2026-03-08' });
    expect(result.draft.sessions[0]?.steps).not.toBe(draft.sessions[0]?.steps);
    expect(result.draft.periods).not.toBe(draft.periods);
    expect(result.summary).toEqual({
      sessionId: 'session',
      kind: 'move',
      before: { date: '2026-03-07', blockId: 'block', durationSeconds: null },
      after: { date: '2026-03-08', blockId: 'block', durationSeconds: null },
    });
    expect(draft).toEqual(original);
  });
  it.each([0, 0.5, 604800])(
    'accepts explicit duration %s without redistributing steps',
    (durationSeconds) => {
      const draft = fixture();
      const result = run(draft, { kind: 'resize', durationSeconds });
      expect(result.status).toBe('changed');
      if (result.status !== 'changed') throw new Error('Expected changed');
      expect(result.draft.sessions[0]).toEqual({ ...draft.sessions[0], durationSeconds });
      expect(draft.sessions[0]?.durationSeconds).toBeNull();
    },
  );
  it.each([-1, 604801, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid duration %s',
    (durationSeconds) => {
      expect(run(fixture(), { kind: 'resize', durationSeconds })).toEqual({
        status: 'rejected',
        reason: 'invalid_operation',
      });
    },
  );
  it('returns unchanged for equal values including zero', () => {
    const draft = fixture();
    expect(run(draft, { ...move, date: '2026-03-07' })).toEqual({ status: 'unchanged' });
    required(draft.sessions[0]).durationSeconds = 0;
    expect(run(draft, { kind: 'resize', durationSeconds: 0 })).toEqual({ status: 'unchanged' });
  });
  it('checks source past date, target past date, invalid date and missing session', () => {
    const draft = fixture();
    expect(run(draft, { ...move, date: '2026-02-28' })).toEqual({
      status: 'rejected',
      reason: 'past_date',
    });
    expect(run(draft, { ...move, date: '2026-03-32' })).toEqual({
      status: 'rejected',
      reason: 'invalid_operation',
    });
    expect(
      applyPlannedSessionOperation({
        draft,
        baseline: null,
        sessionId: 'missing',
        today: '2026-03-01',
        operation: move,
      }),
    ).toEqual({ status: 'rejected', reason: 'missing_session' });
    expect(
      applyPlannedSessionOperation({
        draft,
        baseline: null,
        sessionId: 'session',
        today: '2026-03-09',
        operation: move,
      }),
    ).toEqual({ status: 'rejected', reason: 'past_session' });
  });
  it('rejects invalid draft, baseline and today without normalization', () => {
    const draft = fixture();
    const invalid = {
      ...draft,
      sessions: [{ ...required(draft.sessions[0]), blockId: 'missing' }],
    };
    expect(run(invalid, move)).toEqual({ status: 'rejected', reason: 'invalid_draft' });
    expect(run(draft, move, invalid)).toEqual({ status: 'rejected', reason: 'invalid_baseline' });
    expect(
      applyPlannedSessionOperation({
        draft,
        baseline: null,
        sessionId: 'session',
        today: 'not-date',
        operation: move,
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid_today' });
  });
  it('validates target Block and its exclusive range', () => {
    const draft = fixture();
    expect(run(draft, { ...move, blockId: 'phase' })).toEqual({
      status: 'rejected',
      reason: 'missing_block',
    });
    expect(run(draft, { ...move, blockId: 'missing' })).toEqual({
      status: 'rejected',
      reason: 'missing_block',
    });
    expect(run(draft, { ...move, date: '2026-04-01' })).toEqual({
      status: 'rejected',
      reason: 'outside_block',
    });
    required(draft.periods[3]).endDateExclusive = '2026-03-15';
    draft.periods.push({
      ...required(draft.periods[3]),
      id: 'other',
      startDate: '2026-03-15',
      endDateExclusive: '2026-04-01',
    });
    expect(run(draft, { ...move, blockId: 'other', date: '2026-03-15' }).status).toBe('changed');
  });
  it('protects current date/intensity locks while time lock permits date-only move and resize', () => {
    const draft = fixture();
    required(draft.sessions[0]).locks.date = true;
    expect(run(draft, move)).toEqual({ status: 'rejected', reason: 'locked' });
    required(draft.sessions[0]).locks.date = false;
    required(draft.sessions[0]).locks.intensity = true;
    expect(run(draft, { kind: 'resize', durationSeconds: 60 })).toEqual({
      status: 'rejected',
      reason: 'locked',
    });
    required(draft.sessions[0]).locks.intensity = false;
    required(draft.sessions[0]).locks.time = true;
    expect(run(draft, move, draft).status).toBe('changed');
    expect(run(draft, { kind: 'resize', durationSeconds: 60 }, draft).status).toBe('changed');
  });
  it.each(['date', 'intensity'] as const)(
    'prevents baseline %s unlock and change in one operation',
    (lock) => {
      const baseline = fixture();
      required(baseline.sessions[0]).locks[lock] = true;
      const draft = structuredClone(baseline);
      required(draft.sessions[0]).locks[lock] = false;
      expect(
        run(draft, lock === 'date' ? move : { kind: 'resize', durationSeconds: 60 }, baseline),
      ).toEqual({ status: 'rejected', reason: 'locked' });
    },
  );
  it('checks baseline locks for unrelated preexisting draft edits too', () => {
    const baseline = fixture();
    required(baseline.sessions[0]).locks.time = true;
    const draft = structuredClone(baseline);
    required(draft.sessions[0]).localStartTime = '12:00';
    expect(run(draft, move, baseline)).toEqual({ status: 'rejected', reason: 'locked' });
  });
});
