import { describe, expect, it } from 'vitest';
import { readPlannerSearch, updatePlannerSearch } from '../src/lens';

describe('period renderer URL state', () => {
  it('defaults to Orbit, restores timeline and flags unknown renderer values', () => {
    expect(readPlannerSearch('', '2026-09-17')).toMatchObject({
      periodView: 'orbit',
      periodViewError: false,
    });
    expect(readPlannerSearch('periodView=timeline', '2026-09-17')).toMatchObject({
      periodView: 'timeline',
      periodViewError: false,
    });
    expect(readPlannerSearch('periodView=unknown', '2026-09-17')).toMatchObject({
      periodView: 'orbit',
      periodViewError: true,
    });
  });

  it('changes only the period renderer while preserving selection, table state and actual paging', () => {
    const search = new URLSearchParams({
      lens: 'period',
      period: 'phase',
      plannedSession: 'session',
      plannedView: 'table',
      actualPage: '3',
      compareFrom: '11111111-1111-4111-8111-111111111111',
      compareTo: '22222222-2222-4222-8222-222222222222',
      plannedSort: 'distance_desc',
      plannedColumns: 'block,distance',
      plannedPinned: 'date',
    });
    const updated = updatePlannerSearch(search.toString(), { periodView: 'timeline' });
    const parameters = new URLSearchParams(updated);
    for (const [key, value] of search) expect(parameters.get(key)).toBe(value);
    expect(readPlannerSearch(updated, '2026-09-17')).toMatchObject({
      lens: { kind: 'period', periodId: 'phase' },
      plannedSession: 'session',
      plannedView: 'table',
      periodView: 'timeline',
      tableSort: 'distance_desc',
      tableColumns: ['block', 'distance'],
      tablePinned: ['date'],
    });
    parameters.delete('periodView');
    expect(parameters.toString()).toBe(search.toString());
  });
});
