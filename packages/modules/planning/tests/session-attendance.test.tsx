import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  planDraftSchema,
  preservesSessionLocks,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import { SessionEditor, createSession } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';
import { duplicatePlannedSession } from '../src/duplicate-session';
import { PlanSummary } from '../src/plan-summary';
import { PlannedSessionDetail } from '../src/planned-session-detail';
import { PlanHistoryPanel } from '../src/plan-history-panel';

const beforeId = '11111111-1111-4111-8111-111111111111';
const afterId = '22222222-2222-4222-8222-222222222222';
function snapshot(attendance?: boolean): PlanSnapshot {
  return {
    id: beforeId,
    version: 1,
    createdAt: '2026-09-17T00:00:00Z',
    draft: planDraftSchema.parse({
      title: 'Synthetic attendance',
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
          title: '합성 참석 세션',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: 0,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: {
            date: false,
            time: false,
            intensity: false,
            ...(attendance === undefined ? {} : { attendance }),
          },
          steps: [],
        },
      ],
    }),
  };
}
function setup(attendance?: boolean) {
  const original = snapshot(attendance);
  const store = createPlanningDraftStore();
  store.getState().actions.start(original, original.draft);
  function Host() {
    const state = useStore(store, (value) => value.state);
    return state.draft ? (
      <SessionEditor
        draft={state.draft}
        baseline={state.baseline?.draft ?? null}
        edit={store.getState().actions.edit}
        today="2080-01-01"
        createId={() => 'new-id'}
        selectedId="run"
        onDuplicate={() => {}}
      />
    ) : null;
  }
  render(<Host />);
  return { original, store, current: () => store.getState().state.draft };
}
const checkbox = () => screen.getByRole('checkbox', { name: '참석 잠금 (세션 삭제 보호)' });

describe('session attendance deletion protection', () => {
  it('keeps an untouched legacy omission, records explicit changes, and undoes back to the exact original', async () => {
    const { original, store, current } = setup();
    const user = userEvent.setup();
    expect(checkbox()).not.toBeChecked();
    checkbox().focus();
    await user.tab();
    expect(current()).toBe(original.draft);
    expect(store.getState().state.undo).toHaveLength(0);
    await user.click(checkbox());
    expect(current()?.sessions[0]?.locks.attendance).toBe(true);
    await user.click(checkbox());
    expect(current()?.sessions[0]?.locks.attendance).toBe(false);
    act(() => {
      store.getState().actions.undo();
      store.getState().actions.undo();
    });
    expect(current()).toBe(original.draft);
    expect(current()?.sessions[0]?.locks).not.toHaveProperty('attendance');
  });

  it('allows date, time and content edits but requires a separately saved unlock before deleting', async () => {
    const { original, store, current } = setup(true);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(screen.getByText(/삭제하려면 참석 잠금을 해제해 먼저 저장하세요/)).toBeVisible();
    const inputs = [
      ['세션 날짜', '2080-01-06'],
      ['시작 시각 (미정 가능)', '09:30'],
    ];
    for (const [name, value] of inputs) {
      if (!name || !value) throw new Error('Missing test input');
      const input = screen.getByLabelText(name);
      expect(input).toBeEnabled();
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.change(screen.getByRole('spinbutton', { name: '목표 RPE (0–10, 미정 가능)' }), {
      target: { value: '3' },
    });
    expect(current()?.sessions[0]?.targetRpe).toBe(3);
    const edited = current();
    if (!edited) throw new Error('Missing draft');
    expect(preservesSessionLocks(original.draft, edited)).toBe(true);
    await user.click(checkbox());
    expect(current()?.sessions[0]?.locks.attendance).toBe(false);
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    const unlocked = current();
    if (!unlocked) throw new Error('Missing unlocked draft');
    expect(preservesSessionLocks(original.draft, { ...unlocked, sessions: [] })).toBe(false);
    act(() =>
      store
        .getState()
        .actions.start({ ...original, id: afterId, version: 2, draft: unlocked }, unlocked),
    );
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '세션 삭제' }));
    expect(current()?.sessions).toEqual([]);
    act(() => store.getState().actions.undo());
    expect(current()).toBe(unlocked);
  });

  it.each([undefined, false, true])(
    'copies %s as an explicitly unlocked new identity without changing the original',
    (value) => {
      const source = snapshot(value).draft;
      const before = structuredClone(source);
      const result = duplicatePlannedSession(source, 'run', () => 'copied-run');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected copy');
      const copy = result.draft.sessions.find((session) => session.id === result.sessionId);
      expect(copy?.locks).toEqual({
        date: false,
        time: false,
        intensity: false,
        attendance: false,
      });
      expect(copy?.distanceMeters).toBe(0);
      expect(copy?.durationSeconds).toBeNull();
      expect(source).toEqual(before);
      expect(createSession(source, '2080-01-01', 'new').locks.attendance).toBe(false);
    },
  );

  it.each([
    [undefined, '꺼짐 (이전 형식에 값 없음)'],
    [false, '꺼짐'],
    [true, '켜짐 (세션 삭제 보호)'],
  ] as const)('distinguishes %s in approval summary and selected saved detail', (value, label) => {
    const draft = snapshot(value).draft;
    render(
      <>
        <section aria-label="검토">
          <PlanSummary draft={draft} />
        </section>
        <PlannedSessionDetail source={draft} selected="run" visibleIds={null} draft={false} />
      </>,
    );
    expect(
      within(screen.getByRole('region', { name: '검토' })).getByText(`참석 잠금: ${label}`),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '선택한 계획 세션' })).getByText(
        `참석 잠금: ${label}`,
      ),
    ).toBeVisible();
  });

  it('compares immutable legacy and locked versions through read-only history', async () => {
    const before = snapshot();
    const after = { ...snapshot(true), id: afterId, version: 2 };
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) =>
      transportReplySchema.parse({
        status: 200,
        body: input.path.endsWith(beforeId) ? before : after,
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
          search={`compareFrom=${beforeId}&compareTo=${afterId}`}
          onSearchChange={() => {}}
          current={{ head: after, history: [] }}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText(/^세션 합성 참석 세션 · 변경/));
    expect(
      within(screen.getByRole('region', { name: '이전 세션' })).getByText(
        '참석 잠금: 꺼짐 (이전 형식에 값 없음)',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '이후 세션' })).getByText(
        '참석 잠금: 켜짐 (세션 삭제 보호)',
      ),
    ).toBeVisible();
    expect(before.draft.sessions[0]?.locks).not.toHaveProperty('attendance');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
