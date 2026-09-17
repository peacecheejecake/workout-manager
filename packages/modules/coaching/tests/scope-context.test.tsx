import { describe, it, expect } from 'vitest';
import type { PlanSnapshot, PeriodDraft } from '@workout/contracts/planning';
import { deriveScopeContext } from '../src/scope-context';
function fixture(): PlanSnapshot {
  const periods: PeriodDraft[] = (['season', 'wave', 'phase', 'block'] as const).map(
    (level, index, levels) => ({
      id: level,
      parentId: index ? (levels[index - 1] ?? null) : null,
      level,
      title: level,
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    }),
  );
  const season = periods[0];
  if (season) season.constraints = { unavailableDates: ['2026-01-02'], dailyTimeLimits: [] };
  const block = periods[3];
  if (block) block.constraints = { unavailableDates: [], dailyTimeLimits: [] };
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    draft: {
      title: 'old',
      timezone: 'UTC',
      periods,
      sessions: [
        {
          id: 'run',
          blockId: 'block',
          date: '2026-01-03',
          localStartTime: null,
          title: 'run',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: true, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  };
}
describe('stored scope context', () => {
  it('includes all ancestors and preserves absent vs explicitly empty constraints and locks', () => {
    const plan = fixture();
    const before = structuredClone(plan);
    const value = deriveScopeContext(plan, { kind: 'session', targetId: 'run' });
    expect(value?.periods.map((p) => p.id)).toEqual(['season', 'wave', 'phase', 'block']);
    expect(value?.periods[1]).not.toHaveProperty('constraints');
    expect(value?.periods[3]?.constraints).toEqual({ unavailableDates: [], dailyTimeLimits: [] });
    expect(value?.sessions[0]).toBe(plan.draft.sessions[0]);
    expect(plan).toEqual(before);
  });
  it('includes descendant periods/sessions only for the selected branch', () => {
    const plan = fixture();
    const block = plan.draft.periods[3];
    if (!block) throw new Error('fixture');
    plan.draft.periods.push({ ...block, id: 'other', parentId: 'phase' });
    expect(
      deriveScopeContext(plan, { kind: 'phase', targetId: 'phase' })?.periods.map((p) => p.id),
    ).toContain('other');
    expect(
      deriveScopeContext(plan, { kind: 'block', targetId: 'block' })?.periods.map((p) => p.id),
    ).not.toContain('other');
  });
  it('rejects absent historical targets, wrong kinds and missing ancestry', () => {
    const plan = fixture();
    expect(deriveScopeContext(plan, { kind: 'session', targetId: 'new-session' })).toBeNull();
    expect(deriveScopeContext(plan, { kind: 'phase', targetId: 'block' })).toBeNull();
    plan.draft.periods = plan.draft.periods.filter((p) => p.id !== 'wave');
    expect(deriveScopeContext(plan, { kind: 'session', targetId: 'run' })).toBeNull();
  });
});
