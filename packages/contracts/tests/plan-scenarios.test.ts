import { describe, expect, it } from 'vitest';
import {
  planScenarioSchema,
  planScenarioCreateSchema,
  planScenarioSaveSchema,
  planScenarioApplySchema,
  planScenarioListQuerySchema,
} from '../src/plan-scenarios.js';

const base = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const draft = {
  title: 'Synthetic alternative',
  timezone: 'UTC',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: 'Season',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    },
  ],
  sessions: [],
};
const command = { confirmed: true, idempotencyKey: 'scenario-command' };
describe('separate saved plan alternatives', () => {
  it('retains the saved draft and legacy absence without inventing current-plan status', () => {
    const value = planScenarioSchema.parse({
      id: base,
      basePlanVersionId: base,
      label: 'A',
      revision: 1,
      createdAt: '2026-09-17T00:00:00Z',
      updatedAt: '2026-09-17T00:00:00Z',
      draft,
    });
    expect(value.id).toBe(base.toLowerCase());
    expect(value.draft).toStrictEqual(draft);
    expect(value.draft.periods[0]).not.toHaveProperty('priority');
    expect(value).not.toHaveProperty('version');
    expect(planScenarioSchema.safeParse({ ...value, current: true }).success).toBe(false);
  });
  it('accepts any bounded user name per base reference while keeping A/B/C compatible examples', () => {
    const create = { ...command, basePlanVersionId: base, label: '대회 준비 주간' };
    expect(planScenarioCreateSchema.parse(create).basePlanVersionId).toBe(base.toLowerCase());
    expect(planScenarioCreateSchema.parse({ ...create, label: 'B' }).label).toBe('B');
    for (const invalid of [
      { ...create, confirmed: false },
      { ...create, label: '   ' },
      { ...create, label: 'x'.repeat(81) },
      { ...create, label: 'bad\u0000label' },
      { ...create, basePlanVersionId: 'session-id' },
      { ...create, draft },
    ])
      expect(planScenarioCreateSchema.safeParse(invalid).success).toBe(false);
    expect(planScenarioCreateSchema.parse({ ...create, label: '  Base  ' }).label).toBe('Base');
  });
  it('requires both confirmation and the expected branch revision when saving', () => {
    const save = { ...command, expectedRevision: 2, draft };
    expect(planScenarioSaveSchema.parse(save).draft).toStrictEqual(draft);
    for (const invalid of [
      { ...save, confirmed: undefined },
      { ...save, expectedRevision: 0 },
      { ...save, expectedRevision: 2147483647 },
      { ...save, draft: { ...draft, sessions: [{}] } },
    ])
      expect(planScenarioSaveSchema.safeParse(invalid).success).toBe(false);
  });
  it('pins scenario, current plan and completion collection on explicit application', () => {
    const apply = {
      ...command,
      expectedScenarioRevision: 1,
      expectedPlanVersionId: base,
      expectedCompletionRevision: 0,
    };
    expect(planScenarioApplySchema.parse(apply).expectedCompletionRevision).toBe(0);
    for (const invalid of [
      { ...apply, expectedCompletionRevision: undefined },
      { ...apply, expectedCompletionRevision: -1 },
      { ...apply, expectedPlanVersionId: null },
      { ...apply, expectedScenarioRevision: 1.5 },
      { ...apply, draft },
      { ...apply, confirmed: false },
    ])
      expect(planScenarioApplySchema.safeParse(invalid).success).toBe(false);
  });
  it('bounds history discovery without confusing an empty page with no saved branches', () => {
    expect(planScenarioListQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
    expect(planScenarioListQuerySchema.parse({ limit: '3', offset: '10001' })).toEqual({
      limit: 3,
      offset: 10001,
    });
    for (const invalid of [{ limit: 101 }, { offset: 2147483647 }, { offset: -1 }, { label: 'A' }])
      expect(planScenarioListQuerySchema.safeParse(invalid).success).toBe(false);
  });
});
