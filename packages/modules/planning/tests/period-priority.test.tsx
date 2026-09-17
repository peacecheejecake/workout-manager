import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema } from '@workout/contracts/core';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import { PeriodEditor, createPeriod } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';
import { PlanSummary } from '../src/plan-summary';
import { PeriodExplorer } from '../src/period-explorer';
import { PlanHistoryPanel } from '../src/plan-history-panel';
const draft: PlanDraft = {
  title: '봄 시즌',
  timezone: 'Asia/Seoul',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: '시즌',
      startDate: '2026-09-01',
      endDateExclusive: '2026-12-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'wave',
      parentId: 'season',
      level: 'wave',
      title: '웨이브',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'phase',
      parentId: 'wave',
      level: 'phase',
      title: '페이즈',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'block',
      parentId: 'phase',
      level: 'block',
      title: '10일 Block',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-11',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
  ],
  sessions: [
    {
      id: 'session-1',
      blockId: 'block',
      date: '2026-09-09',
      localStartTime: null,
      title: '쉬운 달리기',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '가볍게',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
};

function setup() {
  const store = createPlanningDraftStore(() => 'preview-command');
  store.getState().actions.start(null, draft);
  function Host() {
    const value = useStore(store, (state) => state.state.draft);
    return value ? (
      <PeriodEditor
        draft={value}
        edit={store.getState().actions.edit}
        today="2026-09-01"
        createId={() => 'new-period'}
      />
    ) : null;
  }
  return { ...render(<Host />), store };
}
describe('explicit independent period priority', () => {
  it('preserves legacy absence until edited, never inherits priority, and keeps session values intact', async () => {
    const user = userEvent.setup(),
      before = structuredClone(draft);
    const { store } = setup();
    expect(
      store.getState().state.draft?.periods.every((period) => !Object.hasOwn(period, 'priority')),
    ).toBe(true);
    const first = screen.getAllByLabelText('기간 우선순위')[0];
    if (!first) throw new Error('Missing field');
    first.focus();
    await user.selectOptions(first, 'high');
    expect(first).toHaveFocus();
    expect(store.getState().state.draft?.periods[0]?.priority).toBe('high');
    expect(store.getState().state.draft?.periods.slice(1)).toEqual(before.periods.slice(1));
    expect(store.getState().state.draft?.sessions).toEqual(before.sessions);
    expect(store.getState().state.preview).toBeNull();
    await user.selectOptions(first, '');
    expect(store.getState().state.draft?.periods[0]?.priority).toBeNull();
    expect(store.getState().state.draft?.periods[1]).not.toHaveProperty('priority');
    act(() => store.getState().actions.preview());
    expect(store.getState().state.preview?.draft.periods[0]?.priority).toBeNull();
    expect(store.getState().state.preview?.draft.periods[1]).not.toHaveProperty('priority');
  });
  it('supports all four period levels and starts newly created periods explicitly unspecified', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    for (const field of screen.getAllByLabelText('기간 우선순위'))
      await user.selectOptions(field, 'low');
    expect(store.getState().state.draft?.periods.map((period) => period.priority)).toEqual([
      'low',
      'low',
      'low',
      'low',
    ]);
    for (const level of ['season', 'wave', 'phase', 'block'] as const)
      expect(createPeriod(draft, level, '2026-09-01', 'new').priority).toBeNull();
  });
  it('shows priority in saved review, explorer selection, child list and transient preview without writes', async () => {
    const user = userEvent.setup();
    const value = {
      ...draft,
      periods: draft.periods.map((period) => ({
        ...period,
        priority: period.level === 'block' ? ('high' as const) : ('normal' as const),
      })),
    };
    const select = vi.fn(),
      calendar = vi.fn();
    const view = render(
      <>
        <PlanSummary draft={value} />
        <PeriodExplorer
          plan={value}
          selectedId="phase"
          view="orbit"
          onViewChange={vi.fn()}
          onSelect={select}
          onCalendar={calendar}
        />
      </>,
    );
    expect(screen.getAllByText(/기간 우선순위 높음/).length).toBeGreaterThanOrEqual(2);
    expect(
      within(screen.getByRole('region', { name: '현재 선택한 기간' })).getByText(
        /기간 우선순위 보통/,
      ),
    ).toBeVisible();
    await user.hover(screen.getByRole('button', { name: 'block · 10일 Block' }));
    expect(
      within(screen.getByRole('complementary', { name: '기간 미리보기' })).getByText(
        /기간 우선순위 높음/,
      ),
    ).toBeVisible();
    expect(select).not.toHaveBeenCalled();
    view.rerender(
      <PeriodExplorer
        plan={value}
        selectedId="block"
        view="orbit"
        onViewChange={vi.fn()}
        onSelect={select}
        onCalendar={calendar}
      />,
    );
    expect(
      within(screen.getByRole('region', { name: '현재 선택한 기간' })).getByText(
        /기간 우선순위 높음/,
      ),
    ).toBeVisible();
  });
  it('distinguishes missing legacy priority from explicit null in historical before/after values', async () => {
    const user = userEvent.setup();
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const before: PlanSnapshot = { id: a, version: 1, createdAt: '2026-09-17T00:00:00Z', draft };
    const after: PlanSnapshot = {
      ...before,
      id: b,
      version: 2,
      draft: { ...draft, periods: draft.periods.map((period) => ({ ...period, priority: null })) },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PlanHistoryPanel
          athleteId="alice"
          sessionId="s"
          current={{ head: after, history: [] }}
          search={`compareFrom=${a}&compareTo=${b}&comparePeriod=block`}
          onSearchChange={() => {}}
          transport={{
            request: async (input) =>
              transportReplySchema.parse({
                status: 200,
                body: input.path.endsWith(a) ? before : after,
                traceId: null,
              }),
          }}
        />
      </QueryClientProvider>,
    );
    const summary = await screen.findByText('10일 Block · 변경');
    await user.click(summary);
    const old = screen.getByRole('region', { name: '이전 기간' }),
      next = screen.getByRole('region', { name: '이후 기간' });
    expect(old).toHaveTextContent('기간 우선순위 미지정 (이전 형식에 값 없음)');
    expect(next).toHaveTextContent('기간 우선순위 미지정');
    expect(within(next).getByText('기간 우선순위 미지정', { exact: true })).toBeVisible();
  });
});
