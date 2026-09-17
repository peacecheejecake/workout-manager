import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { SessionEditor } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';
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
      steps: [
        { id: 'warm', kind: 'warmup', durationSeconds: 0, distanceMeters: null, repetitions: 1 },
        { id: 'work', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 4 },
        {
          id: 'cool',
          kind: 'cooldown',
          durationSeconds: 15.5,
          distanceMeters: 100,
          repetitions: 2,
        },
      ],
    },
  ],
};

function setup(value = draft) {
  const store = createPlanningDraftStore(() => 'command-test');
  store
    .getState()
    .actions.start(
      { id: 'version-one', version: 1, createdAt: '2026-09-17T00:00:00Z', draft: value },
      value,
    );
  function Host() {
    const current = useStore(store, (state) => state.state.draft),
      baseline = useStore(store, (state) => state.state.baseline),
      edit = useStore(store, (state) => state.actions.edit);
    return current ? (
      <SessionEditor
        draft={current}
        baseline={baseline?.draft ?? null}
        edit={edit}
        today="2026-09-01"
        createId={() => 'new-step'}
        onDuplicate={() => {}}
      />
    ) : null;
  }
  return { ...render(<Host />), store };
}
describe('explicit session step ordering', () => {
  it('moves stable steps without changing values or the saved baseline, and remains an undoable unconfirmed draft', async () => {
    const user = userEvent.setup(),
      before = structuredClone(draft);
    const { store } = setup();
    const second = screen.getByRole('group', { name: '계획 단계 2' });
    const button = within(second).getByRole('button', { name: '단계 위로' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(store.getState().state.draft?.sessions[0]?.steps).toEqual([
      before.sessions[0]?.steps[1],
      before.sessions[0]?.steps[0],
      before.sessions[0]?.steps[2],
    ]);
    expect(store.getState().state.baseline?.draft).toEqual(before);
    expect(store.getState().state.preview).toBeNull();
    expect(store.getState().state.draft).toEqual({
      ...before,
      sessions: before.sessions.map((session) => ({
        ...session,
        steps: [session.steps[1], session.steps[0], session.steps[2]],
      })),
    });
    expect(second).toBe(screen.getByRole('group', { name: '계획 단계 1' }));
    expect(within(second).getByLabelText('단계 종류')).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('미저장 초안');
    act(() => store.getState().actions.undo());
    expect(store.getState().state.draft).toEqual(before);
  });
  it('retains the same move button focus when it remains enabled, then moves focus to that step at the boundary', async () => {
    const user = userEvent.setup();
    setup();
    const row = screen.getByRole('group', { name: '계획 단계 1' });
    const down = within(row).getByRole('button', { name: '단계 아래로' });
    expect(within(row).getByRole('button', { name: '단계 위로' })).toBeDisabled();
    await user.click(down);
    expect(down).toHaveFocus();
    expect(row).toHaveAttribute('aria-label', '계획 단계 2');
    await user.keyboard('{Enter}');
    expect(down).toBeDisabled();
    expect(row).toHaveAttribute('aria-label', '계획 단계 3');
    expect(within(row).getByLabelText('단계 종류')).toHaveFocus();
  });
  it('keeps persisted intensity locks effective after only a draft unlock', async () => {
    const user = userEvent.setup();
    const value = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        locks: { ...session.locks, intensity: true },
      })),
    };
    const { store } = setup(value);
    expect(
      screen
        .getAllByRole('button', { name: '단계 아래로' })
        .every((button) => button.matches(':disabled')),
    ).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(store.getState().state.draft?.sessions[0]?.locks.intensity).toBe(false);
    expect(
      screen
        .getAllByRole('button', { name: '단계 아래로' })
        .every((button) => button.matches(':disabled')),
    ).toBe(true);
    const unlocked = store.getState().state.draft;
    if (!unlocked) throw new Error('Missing draft');
    act(() =>
      store.getState().actions.rebase({
        id: 'version-two',
        version: 2,
        createdAt: '2026-09-17T00:00:00Z',
        draft: unlocked,
      }),
    );
    expect(
      within(screen.getByRole('group', { name: '계획 단계 1' })).getByRole('button', {
        name: '단계 아래로',
      }),
    ).toBeEnabled();
  });
  it('handles empty and single steps without offering an invalid move', async () => {
    const user = userEvent.setup();
    const value = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, steps: [] })),
    };
    setup(value);
    expect(screen.getByText(/등록된 단계가 없습니다/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '단계 위로' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '단계 추가' }));
    expect(screen.getByRole('button', { name: '단계 위로' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '단계 아래로' })).toBeDisabled();
  });
});
