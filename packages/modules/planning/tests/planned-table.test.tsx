import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { PlanDraft, PlannedSession } from '@workout/contracts/planning';
import type { DayProjection } from '@workout/contracts/core';
import { PlannedTable, sortedPlannedSessions } from '../src/planned-table';
import {
  plannedTableColumns,
  type PlannedTableColumn,
  type PlannedTableSort,
} from '../src/planned-table-state';
const session: PlannedSession = {
  id: 'a',
  blockId: 'block',
  date: '2026-09-17',
  localStartTime: null,
  title: '동일 제목',
  sport: 'running',
  durationSeconds: 0,
  distanceMeters: 0,
  purpose: '',
  notes: '개인 메모',
  priority: 'normal',
  locks: { date: false, time: false, intensity: false },
  steps: [],
  targetRpe: 0,
};
const source: PlanDraft = {
  title: '검증',
  timezone: 'UTC',
  periods: [],
  sessions: [
    { ...session, id: 'b' },
    { ...session, id: 'missing', title: '미정', distanceMeters: null, durationSeconds: null },
    {
      ...session,
      id: 'positive',
      title: '큰 값',
      date: '2026-09-18',
      distanceMeters: 100,
      durationSeconds: 60,
    },
    session,
    { ...session, id: 'outside', distanceMeters: 999 },
  ],
};
const days: DayProjection[] = [
  {
    date: '2026-09-17',
    timezone: 'UTC',
    blockId: 'block',
    plannedSessionIds: ['a', 'b', 'missing', 'positive'],
    activityIds: [],
    knownRest: false,
  },
];
describe('planned table settings', () => {
  it('sorts projected records with zero known, null last both directions and stable lexical IDs without mutating drafts', () => {
    const before = structuredClone(source);
    const ids = (sort: PlannedTableSort) =>
      sortedPlannedSessions(source, days, sort).map((row) => row.id);
    expect(ids('distance_asc')).toEqual(['a', 'b', 'positive', 'missing']);
    expect(ids('distance_desc')).toEqual(['positive', 'a', 'b', 'missing']);
    expect(ids('duration_asc')).toEqual(['a', 'b', 'positive', 'missing']);
    expect(ids('duration_desc')).toEqual(['positive', 'a', 'b', 'missing']);
    expect(ids('date_asc')).toEqual(['a', 'b', 'missing', 'positive']);
    expect(ids('date_desc')).toEqual(['positive', 'a', 'b', 'missing']);
    expect(ids('title_asc')).toEqual(['a', 'b', 'missing', 'positive']);
    expect(ids('title_desc')).toEqual(['positive', 'missing', 'a', 'b']);
    expect(source).toEqual(before);
  });
  it('changes sorting and column visibility from keyboard without changing shared selection or draft', async () => {
    const user = userEvent.setup();
    const before = structuredClone(source);
    function Host() {
      const [sort, setSort] = useState<PlannedTableSort>('date_asc');
      const [columns, setColumns] = useState<PlannedTableColumn[]>([...plannedTableColumns]);
      const [selected, setSelected] = useState<string | null>('a');
      return (
        <PlannedTable
          source={source}
          days={days}
          selected={selected}
          onSelect={setSelected}
          tableSort={sort}
          tableColumns={columns}
          onTableSort={setSort}
          onTableColumns={setColumns}
        />
      );
    }
    render(<Host />);
    const distance = screen.getByRole('button', { name: '거리 정렬' });
    distance.focus();
    await user.keyboard('{Enter}');
    expect(distance.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await user.keyboard('{Enter}');
    expect(distance.closest('th')).toHaveAttribute('aria-sort', 'descending');
    const firstRow = screen.getAllByRole('row')[1];
    if (!firstRow) throw new Error('Missing first row');
    expect(within(firstRow).getByRole('button')).toHaveTextContent('계획: 큰 값');
    await user.click(screen.getByRole('checkbox', { name: '거리 열 표시' }));
    expect(screen.queryByRole('button', { name: '거리 정렬' })).not.toBeInTheDocument();
    expect(screen.getByText(/현재 정렬: 거리 내림차순/)).toBeVisible();
    const notes = screen.getByRole('checkbox', { name: '메모 열 표시' });
    notes.focus();
    await user.keyboard(' ');
    expect(screen.queryByRole('columnheader', { name: '메모' })).not.toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.getByRole('columnheader', { name: '메모' })).toBeVisible();
    expect(
      screen
        .getAllByRole('button', { name: '계획: 동일 제목' })
        .filter((button) => button.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
    expect(source).toEqual(before);
  });
});
