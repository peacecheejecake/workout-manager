import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import { SessionEditor } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';
import { duplicatePlannedSession } from '../src/duplicate-session';
import { applyPeriodMove } from '../src/period-move';

function fixture(locked = false): PlanDraft {
  return planDraftSchema.parse({
    title: 'Synthetic session targets',
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
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: 0,
        intensityLabel: null,
        purpose: '',
        notes: 'Unchanged note',
        priority: 'normal',
        locks: { date: false, time: false, intensity: locked },
        steps: [
          {
            id: 'work',
            kind: 'work',
            durationSeconds: 61.25,
            distanceMeters: null,
            repetitions: 2,
          },
        ],
      },
    ],
  });
}
function setup(locked = false, completed = false) {
  const draft = fixture(locked);
  const store = createPlanningDraftStore(() => 'target-command');
  store
    .getState()
    .actions.start({ id: 'version', version: 1, createdAt: '2026-09-17T00:00:00Z', draft }, draft);
  function Host() {
    const state = useStore(store, (value) => value.state);
    const edit = useStore(store, (value) => value.actions.edit);
    return state.draft ? (
      <SessionEditor
        draft={state.draft}
        baseline={state.baseline?.draft ?? null}
        edit={edit}
        today="2080-01-01"
        createId={() => 'new-id'}
        selectedId="run"
        onDuplicate={() => {}}
        completedSessionIds={completed ? ['run'] : []}
      />
    ) : null;
  }
  render(<Host />);
  const current = () => store.getState().state.draft?.sessions[0];
  return { draft, store, current };
}
function fill(name: string, value: string) {
  fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } });
}
const paceMin = '목표 페이스 빠른 경계 (초/km)';
const paceMax = '목표 페이스 느린 경계 (초/km)';
const hrMin = '목표 심박 하한 (bpm)';
const hrMax = '목표 심박 상한 (bpm)';

describe('session target fields integrated with the draft', () => {
  it('preserves legacy absence until an explicit edit or clear and undoes clear back to absence', async () => {
    const { store, current } = setup();
    const user = userEvent.setup();
    expect(screen.getByRole('spinbutton', { name: paceMin })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: hrMin })).toHaveValue(null);
    await user.click(screen.getByRole('spinbutton', { name: paceMin }));
    await user.tab();
    expect(current()).not.toHaveProperty('paceTarget');
    expect(current()).not.toHaveProperty('heartRateTarget');
    expect(store.getState().state.undo).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '목표 페이스 비우기' }));
    expect(current()?.paceTarget).toBeNull();
    expect(current()).not.toHaveProperty('heartRateTarget');
    expect(
      within(screen.getByRole('group', { name: '목표 페이스' })).getByText(/명시적으로 비움/),
    ).toBeVisible();
    act(() => store.getState().actions.undo());
    expect(current()).not.toHaveProperty('paceTarget');
    expect(screen.getByText('목표 페이스: 미지정 (이전 형식에 값 없음)')).toBeVisible();
  });

  it('blocks a partial pace range, retains fractional seconds per km and leaves all unrelated data unchanged', () => {
    const { store, current, draft } = setup();
    fill(paceMin, '300.125');
    expect(current()?.paceTarget).toEqual({
      minSecondsPerKm: 300.125,
      maxSecondsPerKm: Number.NaN,
    });
    expect(screen.getByRole('spinbutton', { name: paceMax })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(store.getState().actions.preview()).toBe(false);
    fill(paceMax, '360.25');
    expect(current()?.paceTarget).toEqual({ minSecondsPerKm: 300.125, maxSecondsPerKm: 360.25 });
    expect(screen.getByText('목표 페이스: 300.125–360.25 초/km')).toBeVisible();
    act(() => expect(store.getState().actions.preview()).toBe(true));
    expect(current()).toEqual({
      ...draft.sessions[0],
      paceTarget: { minSecondsPerKm: 300.125, maxSecondsPerKm: 360.25 },
    });
    expect(store.getState().state.baseline?.draft).toEqual(draft);
    act(() => store.getState().actions.undo());
    expect(store.getState().actions.preview()).toBe(false);
    expect(screen.getByRole('spinbutton', { name: paceMax })).toHaveValue(null);
  });

  it('rejects zero, reversed and overflowing pace while equal boundaries form one explicit target', () => {
    const { store, current } = setup();
    fill(paceMax, '360');
    for (const invalid of ['0', '-1', '361', '86401']) {
      fill(paceMin, invalid);
      expect(store.getState().actions.preview()).toBe(false);
      expect(screen.getByRole('spinbutton', { name: paceMin })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    }
    fill(paceMin, '360');
    expect(screen.getByText('목표 페이스: 360 초/km')).toBeVisible();
    act(() => expect(store.getState().actions.preview()).toBe(true));
    fill(paceMin, '');
    expect(Number.isNaN(current()?.paceTarget?.minSecondsPerKm)).toBe(true);
    expect(current()?.paceTarget?.maxSecondsPerKm).toBe(360);
    expect(store.getState().actions.preview()).toBe(false);
  });

  it('requires integer ordered HR boundaries, supports equal limits, and explicitly clears both bounds', async () => {
    const { store, current } = setup();
    fill(hrMin, '120');
    expect(store.getState().actions.preview()).toBe(false);
    for (const invalid of ['0', '119', '150.5', '1001']) {
      fill(hrMax, invalid);
      expect(store.getState().actions.preview()).toBe(false);
    }
    fill(hrMax, '150');
    expect(screen.getByText('목표 심박: 120–150 bpm')).toBeVisible();
    fill(hrMin, '150');
    expect(screen.getByText('목표 심박: 150 bpm')).toBeVisible();
    act(() => expect(store.getState().actions.preview()).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '목표 심박 비우기' }));
    expect(current()?.heartRateTarget).toBeNull();
    expect(current()).not.toHaveProperty('paceTarget');
    expect(screen.getByRole('spinbutton', { name: hrMin })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: hrMax })).not.toHaveAttribute('aria-invalid');
  });

  it('keeps baseline intensity locks active after an unsaved unlock and blocks explicit clearing', async () => {
    const { current, store } = setup(true);
    const user = userEvent.setup();
    for (const label of [paceMin, paceMax, hrMin, hrMax])
      expect(screen.getByRole('spinbutton', { name: label })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(current()?.locks.intensity).toBe(false);
    expect(screen.getByRole('spinbutton', { name: paceMin })).toBeDisabled();
    const clear = screen.getByRole('button', { name: '목표 심박 비우기' });
    expect(clear).toBeDisabled();
    await user.click(clear);
    expect(current()).not.toHaveProperty('heartRateTarget');
    expect(store.getState().state.undo).toHaveLength(1);
  });

  it('allows content targets on a completed session and preserves targets through duplicate and date movement', () => {
    const { store, current } = setup(false, true);
    expect(screen.getByRole('spinbutton', { name: paceMin })).toBeEnabled();
    fill(paceMin, '300');
    fill(paceMax, '360');
    fill(hrMin, '120');
    fill(hrMax, '150');
    const draft = store.getState().state.draft;
    if (!draft) throw new Error('Expected editable draft');
    let index = 0;
    const duplicate = duplicatePlannedSession(draft, 'run', () => `copy-${index++}`);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error('Expected duplicate');
    const cloned = duplicate.draft.sessions.find((session) => session.id === duplicate.sessionId);
    expect(cloned?.paceTarget).toEqual(current()?.paceTarget);
    expect(cloned?.heartRateTarget).toEqual(current()?.heartRateTarget);
    expect(cloned?.locks).toEqual({ date: false, time: false, intensity: false });
    const moved = applyPeriodMove({
      draft: duplicate.draft,
      baseline: draft,
      completionReports: [],
      periodId: 'season',
      newStartDate: '2080-01-02',
      scope: 'descendants_and_sessions',
    });
    expect(moved.status).toBe('changed');
    if (moved.status !== 'changed') throw new Error('Expected date move');
    expect(moved.draft.sessions[0]?.paceTarget).toEqual(current()?.paceTarget);
    expect(moved.draft.sessions[0]?.heartRateTarget).toEqual(current()?.heartRateTarget);
    expect(moved.draft.sessions[0]?.targetRpe).toBe(0);
    expect(moved.draft.sessions[0]?.durationSeconds).toBeNull();
    expect(moved.draft.sessions[0]?.distanceMeters).toBe(0);
  });
});
