import { describe, expect, it } from 'vitest';
import type { PeriodDraft, PlanDraft } from '@workout/contracts/planning';
import { buildPeriodNavigation } from '../src/period-navigation';

function period(
  id: string,
  startDate: string,
  endDateExclusive: string,
  parentId: string | null = null,
  level: PeriodDraft['level'] = 'season',
): PeriodDraft {
  return {
    id,
    parentId,
    level,
    startDate,
    endDateExclusive,
    title: id,
    timezone: 'America/New_York',
    intent: '',
    isPartial: false,
  };
}
function plan(periods: PeriodDraft[]): PlanDraft {
  return { title: 'Plan', timezone: 'America/New_York', periods, sessions: [] };
}
function ready(draft: PlanDraft, id: string | null) {
  const result = buildPeriodNavigation(draft, id);
  if (result.status !== 'ready') throw new Error('Expected ready navigation');
  return result;
}
describe('period navigation calendar projection', () => {
  it('keeps unequal child lengths and leading/intermediate/trailing gaps', () => {
    const draft = plan([
      period('season', '2026-03-01', '2026-03-21'),
      period('late', '2026-03-11', '2026-03-18', 'season', 'wave'),
      { ...period('early', '2026-03-03', '2026-03-08', 'season', 'wave'), isPartial: true },
    ]);
    const original = structuredClone(draft);
    const result = ready(draft, 'season');
    expect(result.children.map((p) => p.id)).toEqual(['early', 'late']);
    expect(
      result.segments.map(({ period, ...geometry }) => ({ id: period.id, ...geometry })),
    ).toEqual([
      { id: 'early', number: 1, startFraction: 2 / 20, endFraction: 7 / 20, days: 5 },
      { id: 'late', number: 2, startFraction: 10 / 20, endFraction: 17 / 20, days: 7 },
    ]);
    expect(result.days).toBe(20);
    expect(result.unassignedDays).toBe(8);
    expect(result.children[0]?.isPartial).toBe(true);
    expect(draft).toEqual(original);
    expect(result.children).not.toBe(draft.periods);
  });
  it('uses the extent of sorted roots and keeps root gaps', () => {
    const result = ready(
      plan([period('b', '2026-03-11', '2026-03-21'), period('a', '2026-03-01', '2026-03-06')]),
      null,
    );
    expect(result.current).toBeNull();
    expect(result.ancestors).toEqual([]);
    expect(result.startDate).toBe('2026-03-01');
    expect(result.endDateExclusive).toBe('2026-03-21');
    expect(result.unassignedDays).toBe(5);
    expect(result.children.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('returns root-to-parent breadcrumbs and explicit leaf emptiness', () => {
    const draft = plan([
      period('season', '2026-01-01', '2026-02-01'),
      period('wave', '2026-01-01', '2026-02-01', 'season', 'wave'),
      period('phase', '2026-01-01', '2026-02-01', 'wave', 'phase'),
      period('block', '2026-01-01', '2026-01-11', 'phase', 'block'),
    ]);
    const result = ready(draft, 'block');
    expect(result.ancestors.map((p) => p.id)).toEqual(['season', 'wave', 'phase']);
    expect(result.current?.id).toBe('block');
    expect(result.children).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.days).toBe(10);
    expect(result.unassignedDays).toBe(10);
  });
  it('represents one full child as a full circle without inventing segments', () => {
    const result = ready(
      plan([
        period('s', '2024-02-01', '2024-03-01'),
        period('w', '2024-02-01', '2024-03-01', 's', 'wave'),
      ]),
      's',
    );
    expect(result.segments).toMatchObject([{ startFraction: 0, endFraction: 1, days: 29 }]);
    expect(result.unassignedDays).toBe(0);
  });
  it.each([
    ['0001-01-01', '0001-01-11', 10],
    ['0099-12-31', '0100-01-02', 2],
    ['2024-02-28', '2024-03-01', 2],
    ['2025-02-28', '2025-03-01', 1],
    ['2026-03-07', '2026-03-10', 3],
    ['9999-12-30', '9999-12-31', 1],
  ])('counts calendar dates %s–%s independently of offsets', (start, end, days) => {
    expect(ready(plan([period('s', start, end)]), null).days).toBe(days);
  });
  it('does not silently fall back when the selected period is absent', () => {
    expect(
      buildPeriodNavigation(plan([period('s', '2026-01-01', '2026-02-01')]), 'missing'),
    ).toEqual({ status: 'missing' });
    expect(buildPeriodNavigation(plan([]), 'missing')).toEqual({ status: 'missing' });
  });
  it('represents empty roots without NaN or fabricated dates', () => {
    expect(ready(plan([]), null)).toEqual({
      status: 'ready',
      current: null,
      ancestors: [],
      children: [],
      startDate: null,
      endDateExclusive: null,
      segments: [],
      days: 0,
      unassignedDays: 0,
    });
  });
});
