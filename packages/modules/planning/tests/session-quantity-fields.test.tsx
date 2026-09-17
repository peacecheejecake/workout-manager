import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { describe, expect, it, vi } from 'vitest';
import {
  planDraftSchema,
  type PlanDraft,
  type PlannedSession,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionEditor } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';
import { SessionQuantityFields } from '../src/session-quantity-fields';
import { sessionDurationLabel, sessionDistanceLabel } from '../src/session-quantity-labels';
import { SessionOperations } from '../src/session-operations';
import { applyPlannedSessionOperation } from '../src/session-operation';
import { duplicatePlannedSession } from '../src/duplicate-session';
import { PlanSummary } from '../src/plan-summary';
import { PlannedSessionDetail } from '../src/planned-session-detail';
import { PlanHistoryPanel } from '../src/plan-history-panel';
import { sortedPlannedSessions, PlannedTable } from '../src/planned-table';
import { createPlannedTableInteractionStore } from '../src/planned-table-interaction';
import { PlanConstraintsReport } from '../src/period-constraints-summary';

function fixture(patch: Partial<PlannedSession> = {}): PlanDraft {
  return planDraftSchema.parse({
    title: '합성 범위 계획',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'run',
        blockId: 'block',
        date: '2080-01-05',
        localStartTime: null,
        title: '합성 범위 세션',
        sport: 'running',
        durationSeconds: 61.25,
        distanceMeters: 0,
        targetRpe: 0,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [
          { id: 'step', kind: 'work', repetitions: 2, durationSeconds: 10, distanceMeters: null },
        ],
        ...patch,
      },
    ],
  });
}
const ranged = {
  durationSeconds: null,
  durationRange: { minSeconds: 0, maxSeconds: 61.25 },
  distanceMeters: null,
  distanceRange: { minMeters: 1234.567, maxMeters: 2000 },
};
function setup(patch: Partial<PlannedSession> = {}) {
  const draft = fixture(patch);
  const store = createPlanningDraftStore();
  store
    .getState()
    .actions.start({ id: 'saved', version: 1, createdAt: '2026-09-17T00:00:00Z', draft }, draft);
  function Host() {
    const state = useStore(store, (value) => value.state);
    return state.draft ? (
      <SessionEditor
        draft={state.draft}
        baseline={state.baseline?.draft ?? null}
        edit={store.getState().actions.edit}
        today="2080-01-01"
        createId={() => 'new'}
        selectedId="run"
        onDuplicate={() => {}}
      />
    ) : null;
  }
  render(<Host />);
  return { store, draft, current: () => store.getState().state.draft };
}
const fill = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } });

describe('planned session quantity modes', () => {
  it('keeps legacy scalar editing, transitions atomically to validated bounds, and undoes without changing steps', async () => {
    const { store, draft, current } = setup();
    const user = userEvent.setup();
    expect(current()?.sessions[0]).not.toHaveProperty('durationRange');
    expect(store.getState().state.undo).toHaveLength(0);
    fill('시간 (초, 미정 가능)', '60.125');
    expect(current()?.sessions[0]).not.toHaveProperty('durationRange');
    act(() => store.getState().actions.undo());
    await user.selectOptions(
      screen.getByRole('combobox', { name: '계획 시간 입력 방식' }),
      'range',
    );
    expect(current()?.sessions[0]?.durationSeconds).toBeNull();
    act(() => expect(store.getState().actions.preview()).toBe(false));
    fill('계획 시간 하한 (초)', '0');
    fill('계획 시간 상한 (초)', '61.25');
    expect(current()?.sessions[0]?.durationRange).toEqual({ minSeconds: 0, maxSeconds: 61.25 });
    expect(current()?.sessions[0]?.steps).toEqual(draft.sessions[0]?.steps);
    expect(current()?.sessions[0]?.distanceMeters).toBe(0);
    act(() => expect(store.getState().actions.preview()).toBe(true));
    await user.selectOptions(
      screen.getByRole('combobox', { name: '계획 시간 입력 방식' }),
      'single',
    );
    expect(current()?.sessions[0]?.durationRange).toBeNull();
    expect(current()?.sessions[0]?.durationSeconds).toBeNaN();
    act(() => expect(store.getState().actions.preview()).toBe(false));
    fill('시간 (초, 미정 가능)', '0');
    act(() => expect(store.getState().actions.preview()).toBe(true));
    await user.selectOptions(
      screen.getByRole('combobox', { name: '계획 시간 입력 방식' }),
      'unknown',
    );
    expect(current()?.sessions[0]?.durationSeconds).toBeNull();
    expect(current()?.sessions[0]?.durationRange).toBeNull();
    act(() => store.getState().actions.undo());
    expect(current()?.sessions[0]?.durationSeconds).toBe(0);
  });

  it('validates distance and duration bounds including equal zero, fractions, order, limits and a missing boundary', async () => {
    const { store, current } = setup(ranged);
    fill('계획 거리 하한 (m)', '0');
    fill('계획 거리 상한 (m)', '0');
    expect(current()?.sessions[0]?.distanceRange).toEqual({ minMeters: 0, maxMeters: 0 });
    act(() => expect(store.getState().actions.preview()).toBe(true));
    for (const value of ['-1', '10000001', '']) {
      fill('계획 거리 상한 (m)', value);
      expect(screen.getByRole('spinbutton', { name: '계획 거리 상한 (m)' })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      act(() => expect(store.getState().actions.preview()).toBe(false));
    }
    fill('계획 거리 하한 (m)', '1234.567');
    fill('계획 거리 상한 (m)', '1234.5');
    act(() => expect(store.getState().actions.preview()).toBe(false));
    fill('계획 거리 상한 (m)', '10000000');
    fill('계획 시간 상한 (초)', '604801');
    act(() => expect(store.getState().actions.preview()).toBe(false));
    fill('계획 시간 상한 (초)', '604800');
    act(() => expect(store.getState().actions.preview()).toBe(true));
    expect(current()?.sessions[0]?.distanceRange?.minMeters).toBe(1234.567);
  });

  it('keeps baseline intensity protection after draft unlock and never edits disabled quantities', async () => {
    const { current } = setup({ ...ranged, locks: { date: false, time: false, intensity: true } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(screen.getByRole('combobox', { name: '계획 거리 입력 방식' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '계획 시간 하한 (초)' })).toBeDisabled();
    expect(current()?.sessions[0]?.durationRange).toEqual(ranged.durationRange);
  });

  it('uses the latest selected session props with no unit or mode state leaking across identities', () => {
    const original = fixture(ranged).sessions[0];
    const legacy = fixture().sessions[0];
    if (!original || !legacy) throw new Error('Missing session');
    const onChange = vi.fn();
    const { rerender } = render(
      <SessionQuantityFields session={original} disabled={false} onChange={onChange} />,
    );
    expect(screen.getByRole('combobox', { name: '계획 거리 입력 방식' })).toHaveValue('range');
    rerender(
      <SessionQuantityFields
        session={{ ...legacy, id: 'another' }}
        disabled={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('combobox', { name: '계획 거리 입력 방식' })).toHaveValue('single');
    expect(screen.getByRole('spinbutton', { name: '거리 (m, 미정 가능)' })).toHaveValue(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects range resizing, preserves it on movement and duplication, and explains the disabled resize controls', () => {
    const draft = fixture(ranged);
    expect(
      applyPlannedSessionOperation({
        draft,
        baseline: draft,
        sessionId: 'run',
        today: '2080-01-01',
        operation: { kind: 'resize', durationSeconds: 20 },
      }),
    ).toEqual({ status: 'rejected', reason: 'range_duration' });
    const moved = applyPlannedSessionOperation({
      draft,
      baseline: draft,
      sessionId: 'run',
      today: '2080-01-01',
      operation: { kind: 'move', date: '2080-01-06', blockId: 'block' },
    });
    expect(moved.status).toBe('changed');
    if (moved.status !== 'changed') throw new Error('Expected move');
    expect(moved.draft.sessions[0]?.durationRange).toEqual(ranged.durationRange);
    expect(moved.draft.sessions[0]?.distanceRange).toEqual(ranged.distanceRange);
    const copied = duplicatePlannedSession(
      draft,
      'run',
      (() => {
        let n = 0;
        return () => `copy-${n++}`;
      })(),
    );
    expect(copied.ok).toBe(true);
    if (!copied.ok) throw new Error('Expected copy');
    expect(copied.draft.sessions.at(-1)?.durationRange).toEqual(ranged.durationRange);
    const onOperation = vi.fn();
    render(
      <SessionOperations
        draft={draft}
        baseline={draft}
        selected="run"
        today="2080-01-01"
        onOperation={onOperation}
      />,
    );
    expect(screen.getByRole('button', { name: '계획 시간 적용' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: '계획 길이 조절' })).toBeDisabled();
    expect(screen.getByText(/세션 편집에서 단일값으로 전환/)).toBeVisible();
    expect(screen.queryByText(/계획 시간이 미정이므로/)).not.toBeInTheDocument();
    expect(onOperation).not.toHaveBeenCalled();
  });

  it('renders exact unit ranges in review, saved details and table, sorting min then max with null last', () => {
    const draft = fixture(ranged);
    const session = draft.sessions[0];
    if (!session) throw new Error('Missing session');
    draft.sessions = [
      session,
      { ...session, id: 'a', distanceRange: { minMeters: 1234.567, maxMeters: 2000 } },
      { ...session, id: 'n', distanceRange: null },
      { ...session, id: 'z', distanceRange: { minMeters: 1234.567, maxMeters: 1500 } },
    ];
    const days = [
      {
        date: session.date,
        timezone: 'UTC',
        blockId: 'block',
        plannedSessionIds: draft.sessions.map((item) => item.id),
        activityIds: [],
        knownRest: false,
      },
    ];
    expect(sortedPlannedSessions(draft, days, 'distance_asc').map((item) => item.id)).toEqual([
      'z',
      'a',
      'run',
      'n',
    ]);
    expect(sortedPlannedSessions(draft, days, 'distance_desc').map((item) => item.id)).toEqual([
      'a',
      'run',
      'z',
      'n',
    ]);
    render(
      <>
        <section aria-label="미리보기">
          <PlanSummary draft={fixture(ranged)} />
        </section>
        <PlannedSessionDetail
          source={fixture(ranged)}
          selected="run"
          visibleIds={null}
          draft={false}
        />
        <PlannedTable
          source={fixture(ranged)}
          days={days.map((day) => ({ ...day, plannedSessionIds: ['run'] }))}
          selected={null}
          onSelect={() => {}}
          tableSort="distance_asc"
          tableColumns={['distance', 'duration']}
          tablePinned={[]}
          onTableSort={() => {}}
          onTableColumns={() => {}}
          onTablePinned={() => {}}
          interactionStore={createPlannedTableInteractionStore()}
        />
      </>,
    );
    expect(
      within(screen.getByRole('region', { name: '미리보기' })).getByText(
        /시간: 0–61.25초 \(범위\)/,
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '선택한 계획 세션' })).getByText(
        /거리 1234.567–2000m \(범위\)/,
      ),
    ).toBeVisible();
    expect(screen.getByRole('cell', { name: '0–61.25초 (범위)' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '1234.567–2000m (범위)' })).toBeVisible();
  });

  it('distinguishes guaranteed minimum excess from possible maximum excess without counting steps or erasing unknowns', () => {
    const draft = fixture({
      durationSeconds: null,
      durationRange: { minSeconds: 100, maxSeconds: 200 },
    });
    const session = draft.sessions[0];
    if (!session) throw new Error('Missing session');
    draft.sessions.push(
      { ...session, id: 'scalar', durationRange: null, durationSeconds: 50 },
      { ...session, id: 'unknown', durationRange: null, durationSeconds: null },
    );
    draft.periods = draft.periods.map((period) => ({
      ...period,
      ...(period.id === 'season'
        ? {
            constraints: {
              unavailableDates: [],
              dailyTimeLimits: [{ date: session.date, availableSeconds: 175 }],
            },
          }
        : {}),
    }));
    const { rerender } = render(<PlanConstraintsReport plan={draft} />);
    expect(screen.getByRole('listitem', { name: `제약 날짜 ${session.date}` })).toHaveAttribute(
      'data-status',
      'unknown',
    );
    expect(screen.getByText(/알려진 계획 시간 범위 150–250초/)).toBeVisible();
    expect(screen.getByText(/상한이 가용량을 초과할 수 있어/)).toBeVisible();
    expect(screen.getByText(/시간 미정 세션 1개/)).toBeVisible();
    const lower = {
      ...draft,
      periods: draft.periods.map((period) => ({
        ...period,
        ...(period.constraints
          ? {
              constraints: {
                ...period.constraints,
                dailyTimeLimits: [{ date: session.date, availableSeconds: 100 }],
              },
            }
          : {}),
      })),
    };
    rerender(<PlanConstraintsReport plan={lower} />);
    expect(screen.getByRole('listitem', { name: `제약 날짜 ${session.date}` })).toHaveAttribute(
      'data-status',
      'conflict',
    );
    expect(screen.getByText(/시간 범위의 하한이 가용량을 초과/)).toBeVisible();
  });

  it('marks invalid draft quantities as errors instead of presenting them as known ranges', () => {
    const session = fixture(ranged).sessions[0];
    if (!session) throw new Error('Missing session');
    for (const range of [
      { minSeconds: 2, maxSeconds: 1 },
      { minSeconds: -1, maxSeconds: 1 },
      { minSeconds: 0, maxSeconds: 604801 },
      { minSeconds: Number.NaN, maxSeconds: 1 },
    ])
      expect(sessionDurationLabel({ ...session, durationRange: range })).toBe('범위 입력 오류');
    expect(
      sessionDistanceLabel({ ...session, distanceRange: { minMeters: 0, maxMeters: 10000001 } }),
    ).toBe('범위 입력 오류');
    expect(sessionDurationLabel({ ...session, durationSeconds: 0 })).toBe('범위 입력 오류');
  });

  it('compares legacy scalar and new range snapshots through read-only version history', async () => {
    const before: PlanSnapshot = {
      id: '11111111-1111-4111-8111-111111111111',
      version: 1,
      createdAt: '2026-09-17T00:00:00Z',
      draft: fixture(),
    };
    const after: PlanSnapshot = {
      ...before,
      id: '22222222-2222-4222-8222-222222222222',
      version: 2,
      draft: fixture(ranged),
    };
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) =>
      transportReplySchema.parse({
        status: 200,
        body: input.path.endsWith(before.id) ? before : after,
        traceId: 'synthetic',
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <PlanHistoryPanel
          athleteId="alice"
          sessionId="auth"
          transport={{ request }}
          search={`compareFrom=${before.id}&compareTo=${after.id}`}
          onSearchChange={() => {}}
          current={{ head: after, history: [] }}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText(/^세션 합성 범위 세션 · 변경/));
    expect(
      within(screen.getByRole('region', { name: '이전 세션' })).getByText(
        /이전 형식에 범위 값 없음/,
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '이후 세션' })).getByText(
        /시간 0–61.25초 \(범위\)/,
      ),
    ).toBeVisible();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
