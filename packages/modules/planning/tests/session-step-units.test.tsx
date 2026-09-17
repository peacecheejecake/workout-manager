import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { SessionEditor } from '../src/plan-fields';
import { createPlanningDraftStore } from '../src/draft-store';

function setup(locked = false) {
  const draft = planDraftSchema.parse({
    title: 'Synthetic units',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index ? levels[index - 1] : null,
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
        title: 'Test run',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: 'Preserved',
        priority: 'normal',
        locks: { date: false, time: false, intensity: locked },
        steps: [
          {
            id: 'fraction',
            kind: 'work',
            durationSeconds: 61.25,
            distanceMeters: 1234.567,
            repetitions: 3,
          },
          {
            id: 'zero',
            kind: 'recovery',
            durationSeconds: 0,
            distanceMeters: null,
            repetitions: 1,
          },
        ],
      },
    ],
  });
  const store = createPlanningDraftStore(() => 'unit-command');
  store
    .getState()
    .actions.start(
      { id: 'version-one', version: 1, createdAt: '2026-09-17T00:00:00Z', draft },
      draft,
    );
  function Host() {
    const state = useStore(store, (value) => value.state);
    const edit = useStore(store, (value) => value.actions.edit);
    return state.draft ? (
      <SessionEditor
        draft={state.draft}
        baseline={state.baseline?.draft ?? null}
        edit={edit}
        today="2080-01-01"
        createId={() => 'new-step'}
        onDuplicate={() => {}}
      />
    ) : null;
  }
  render(<Host />);
  return { store, draft };
}

describe('step units integrated with the planning draft', () => {
  it('changes display units without an undo entry, retains units by step ID, and undoes numeric edits exactly', async () => {
    const user = userEvent.setup();
    const { store, draft } = setup();
    const row = screen.getByRole('group', { name: '계획 단계 1' });
    await user.selectOptions(within(row).getByLabelText('단계 거리 단위'), 'kilometers');
    await user.click(within(row).getByRole('button', { name: '단계 거리 단위 전환 적용' }));
    expect(within(row).getByLabelText('단계 거리 (km)')).toHaveValue('1.234567');
    expect(store.getState().state.draft).toBe(draft);
    expect(store.getState().state.undo).toHaveLength(0);
    await user.click(within(row).getByRole('button', { name: '단계 아래로' }));
    expect(row).toBe(screen.getByRole('group', { name: '계획 단계 2' }));
    expect(within(row).getByLabelText('단계 거리 (km)')).toHaveValue('1.234567');
    expect(
      within(screen.getByRole('group', { name: '계획 단계 1' })).getByLabelText('단계 거리 (m)'),
    ).toHaveValue('');
    act(() => store.getState().actions.undo());
    expect(store.getState().state.draft).toEqual(draft);
    fireEvent.change(within(row).getByLabelText('단계 거리 (km)'), { target: { value: '2.5' } });
    expect(store.getState().state.draft?.sessions[0]?.steps[0]?.distanceMeters).toBe(2500);
    expect(store.getState().state.baseline?.draft).toEqual(draft);
    expect(store.getState().state.preview).toBeNull();
    act(() => store.getState().actions.undo());
    expect(store.getState().state.draft).toEqual(draft);
    expect(within(row).getByLabelText('단계 거리 (km)')).toHaveValue('1.234567');
  });

  it('blocks plan preview for invalid unit input and preserves the saved snapshot until corrected', () => {
    const { store, draft } = setup();
    const row = screen.getByRole('group', { name: '계획 단계 1' });
    const input = within(row).getByLabelText('단계 시간 (초)');
    fireEvent.change(input, { target: { value: '1e' } });
    expect(input).toHaveValue('1e');
    act(() => expect(store.getState().actions.preview()).toBe(false));
    expect(store.getState().state.preview).toBeNull();
    expect(store.getState().state.baseline?.draft).toEqual(draft);
    fireEvent.change(input, { target: { value: '75.5' } });
    act(() => expect(store.getState().actions.preview()).toBe(true));
    expect(store.getState().state.preview?.draft.sessions[0]?.steps[0]).toEqual({
      ...draft.sessions[0]?.steps[0],
      durationSeconds: 75.5,
    });
  });

  it('keeps persisted intensity locks effective after an unsaved unlock', async () => {
    const user = userEvent.setup();
    const { store, draft } = setup(true);
    await user.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(store.getState().state.draft?.sessions[0]?.locks.intensity).toBe(false);
    const row = within(screen.getByRole('group', { name: '계획 단계 1' }));
    expect(row.getByLabelText('단계 시간 단위')).toBeDisabled();
    expect(row.getByLabelText('단계 거리 단위')).toBeDisabled();
    expect(row.getByLabelText('단계 시간 (초)')).toBeDisabled();
    expect(store.getState().state.draft?.sessions[0]?.steps).toEqual(draft.sessions[0]?.steps);
  });
});
