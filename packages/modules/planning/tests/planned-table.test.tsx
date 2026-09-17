import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanDraft, PlannedSession } from '@workout/contracts/planning';
import type { DayProjection } from '@workout/contracts/core';
import { createPlannedTableInteractionStore } from '../src/planned-table-interaction';
import { PlannedTable, sortedPlannedSessions } from '../src/planned-table';
import {
  plannedTableColumns,
  type PlannedTableColumn,
  type PlannedTableSort,
  type PlannedTablePin,
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
      const [interactionStore] = useState(createPlannedTableInteractionStore);
      const [sort, setSort] = useState<PlannedTableSort>('date_asc');
      const [columns, setColumns] = useState<PlannedTableColumn[]>([...plannedTableColumns]);
      const [selected, setSelected] = useState<string | null>('a');
      return (
        <PlannedTable
          interactionStore={interactionStore}
          tablePinned={[]}
          onTablePinned={() => {}}
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
    expect(within(firstRow).getByRole('button', { name: '계획: 큰 값' })).toHaveTextContent(
      '계획: 큰 값',
    );
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

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});
describe('planned table workbench', () => {
  it('selects ranges in displayed sort order independently of detail and preserves IDs across sort/filter', async () => {
    const user = userEvent.setup();
    const store = createPlannedTableInteractionStore();
    const selected = vi.fn();
    const props = {
      source,
      days,
      selected: 'a',
      onSelect: selected,
      tableSort: 'distance_desc' as const,
      tableColumns: [...plannedTableColumns],
      tablePinned: [],
      onTableSort: vi.fn(),
      onTableColumns: vi.fn(),
      onTablePinned: vi.fn(),
      interactionStore: store,
    };
    const ui = render(<PlannedTable {...props} />);
    await user.click(screen.getByRole('button', { name: '큰 값 범위 시작' }));
    await user.click(screen.getByRole('button', { name: '미정 범위 끝' }));
    expect(store.getState().state.rangeIds).toEqual(['positive', 'a', 'b', 'missing']);
    expect(screen.getByRole('status')).toHaveTextContent('4개 행 선택');
    expect(selected).not.toHaveBeenCalled();
    ui.rerender(
      <PlannedTable
        {...props}
        tableSort="distance_asc"
        days={[
          {
            ...days[0],
            date: '2026-09-17',
            timezone: 'UTC',
            blockId: 'block',
            activityIds: [],
            knownRest: false,
            plannedSessionIds: ['a', 'missing'],
          },
        ]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2개 행 선택');
    expect(store.getState().state.rangeIds).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: '행 범위 선택 해제' }));
    expect(screen.getByRole('status')).toHaveTextContent('0개 행 선택');
  });
  it('retains requested arbitrary column pins while narrow viewports suspend effective pinning', async () => {
    const user = userEvent.setup();
    let width = 1000;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    function Host() {
      const [store] = useState(createPlannedTableInteractionStore);
      const [pins, setPins] = useState<PlannedTablePin[]>([]);
      return (
        <PlannedTable
          source={source}
          days={days}
          selected={null}
          onSelect={vi.fn()}
          tableSort="date_asc"
          tableColumns={[...plannedTableColumns]}
          tablePinned={pins}
          onTablePinned={setPins}
          onTableSort={vi.fn()}
          onTableColumns={vi.fn()}
          interactionStore={store}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('checkbox', { name: '메모 열 고정' }));
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: '메모' })).toHaveAttribute(
        'data-pinned',
        'true',
      ),
    );
    expect(screen.getByRole('columnheader', { name: '메모' })).toHaveStyle({ left: '0px' });
    width = 320;
    fireEvent(window, new Event('resize'));
    expect(screen.getByText(/열 고정을 잠시 해제/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '메모 열 고정' })).toBeChecked();
    expect(screen.getByRole('columnheader', { name: '메모' })).toHaveAttribute(
      'data-pinned',
      'false',
    );
  });
  it.each(['wheel', 'jump', 'horizontal'])(
    'keeps the semantic anchor until new %s input cancels correction',
    (intent) => {
      vi.useFakeTimers();
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.dataset.sessionId === 'positive' ? 400 : 0;
      });
      const store = createPlannedTableInteractionStore();
      store.getState().actions.setRowMode('all');
      store.getState().actions.setScrollAnchor({ id: 'positive', offset: 10 });
      render(
        <PlannedTable
          source={source}
          days={days}
          selected="positive"
          onSelect={vi.fn()}
          tableSort="date_asc"
          tableColumns={[...plannedTableColumns]}
          tablePinned={[]}
          onTablePinned={vi.fn()}
          onTableSort={vi.fn()}
          onTableColumns={vi.fn()}
          interactionStore={store}
        />,
      );
      const viewport = screen.getByRole('region', { name: '계획 표 스크롤 영역' });
      expect(viewport.scrollTop).toBe(410);
      viewport.scrollTop = 321;
      fireEvent.scroll(viewport);
      expect(store.getState().state.scrollAnchor).toEqual({ id: 'positive', offset: 10 });
      act(() => vi.advanceTimersByTime(20));
      expect(viewport.scrollTop).toBe(410);
      if (intent === 'wheel') fireEvent.wheel(viewport);
      else if (intent === 'jump')
        fireEvent.click(screen.getByRole('button', { name: '선택한 계획 행으로 이동' }));
      else {
        Object.defineProperty(viewport, 'scrollBy', { configurable: true, value: vi.fn() });
        fireEvent.click(screen.getByRole('button', { name: '계획 보기 오른쪽으로 이동' }));
      }
      viewport.scrollTop = 222;
      act(() => vi.advanceTimersByTime(100));
      expect(viewport.scrollTop).toBe(222);
    },
  );
  it('bounds a large table, exposes all rows on demand, and cleans up in StrictMode', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, 960, this.tagName === 'TR' ? 140 : 480);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    const store = createPlannedTableInteractionStore();
    const large = {
      ...source,
      sessions: Array.from({ length: 120 }, (_, index) => ({
        ...session,
        id: `row-${index}`,
        title: `훈련 ${index}`,
      })),
    };
    const largeDays = [
      {
        date: '2026-09-17',
        timezone: 'UTC',
        blockId: 'block',
        plannedSessionIds: large.sessions.map((row) => row.id),
        activityIds: [],
        knownRest: false,
      },
    ];
    const props = {
      source: large,
      days: largeDays,
      selected: null,
      onSelect: vi.fn(),
      tableSort: 'date_asc' as const,
      tableColumns: [...plannedTableColumns],
      tablePinned: [],
      onTableSort: vi.fn(),
      onTableColumns: vi.fn(),
      onTablePinned: vi.fn(),
      interactionStore: store,
    };
    const ui = render(
      <StrictMode>
        <PlannedTable {...props} />
      </StrictMode>,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '121');
    expect(screen.getAllByRole('button', { name: /^계획: 훈련/ }).length).toBeLessThan(50);
    await user.click(screen.getByRole('button', { name: '모든 행 표시' }));
    expect(screen.getAllByRole('button', { name: /^계획: 훈련/ })).toHaveLength(120);
    ui.unmount();
    for (const [name, listener] of added.mock.calls) {
      if (name === 'resize')
        expect(
          removed.mock.calls.some(
            ([removedName, removedListener]) =>
              removedName === name && removedListener === listener,
          ),
        ).toBe(true);
    }
    act(() => store.getState().actions.setRowMode('virtual'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
