import { describe, expect, it } from 'vitest';
import { readPlannerSearch, updatePlannerSearch } from '../src/lens';
import { plannedTableColumns, plannedTableSorts } from '../src/planned-table-state';

describe('planned table URL settings', () => {
  it('defaults omitted settings and preserves explicitly empty optional columns', () => {
    expect(readPlannerSearch('', '2026-09-17')).toMatchObject({
      tableSort: 'date_asc',
      tableColumns: [...plannedTableColumns],
      tableError: false,
    });
    expect(readPlannerSearch('plannedColumns=', '2026-09-17')).toMatchObject({
      tableColumns: [],
      tableError: false,
    });
  });
  it.each(plannedTableSorts)('restores %s with a canonical column order', (sort) => {
    expect(
      readPlannerSearch(`plannedSort=${sort}&plannedColumns=notes,block`, '2026-09-17'),
    ).toMatchObject({ tableSort: sort, tableColumns: ['block', 'notes'], tableError: false });
  });
  it('reports invalid settings while preserving valid independent settings and selection', () => {
    const prefix = 'plannedView=split&plannedSession=session-1&';
    expect(
      readPlannerSearch(`${prefix}plannedSort=bogus&plannedColumns=notes`, '2026-09-17'),
    ).toMatchObject({
      tableSort: 'date_asc',
      tableColumns: ['notes'],
      tableError: true,
      plannedSession: 'session-1',
      plannedView: 'split',
    });
    for (const columns of ['notes,notes', 'other', ',notes', 'notes,', ' notes']) {
      expect(
        readPlannerSearch(
          `${prefix}plannedSort=title_desc&plannedColumns=${columns}`,
          '2026-09-17',
        ),
      ).toMatchObject({
        tableSort: 'title_desc',
        tableColumns: [...plannedTableColumns],
        tableError: true,
      });
    }
  });
  it('changes display settings without resetting unrelated lookup state', () => {
    const next = updatePlannerSearch(
      'plannedView=split&plannedSession=session-1&actualPage=2&lens=rolling&days=10',
      { plannedSort: 'distance_desc', plannedColumns: '' },
    );
    const params = new URLSearchParams(next);
    expect(Object.fromEntries(params)).toEqual({
      plannedView: 'split',
      plannedSession: 'session-1',
      actualPage: '2',
      lens: 'rolling',
      days: '10',
      plannedSort: 'distance_desc',
      plannedColumns: '',
    });
  });
});
