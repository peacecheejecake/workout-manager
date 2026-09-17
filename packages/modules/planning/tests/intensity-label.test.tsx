import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { PlannedTable } from '../src/planned-table';
import { createPlannedTableInteractionStore } from '../src/planned-table-interaction';
import type { PlannedTableColumn } from '../src/planned-table-state';
import { SessionEditor } from '../src/plan-fields';
import { PlanSummary } from '../src/plan-summary';
import { PlannedSessionDetail } from '../src/planned-session-detail';
import { duplicatePlannedSession } from '../src/duplicate-session';
import { applyPlannedSessionOperation } from '../src/session-operation';
import { readPlannedTableState } from '../src/planned-table-state';
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

describe('independent intensity labels', () => {
  it('preserves absent legacy labels until explicit selection and retains zero/null fields', async () => {
    const user = userEvent.setup();
    const edited = vi.fn();
    function Host() {
      const [value, setValue] = useState(draft);
      return (
        <SessionEditor
          draft={value}
          baseline={draft}
          today="2026-09-01"
          createId={() => 'new'}
          onDuplicate={() => {}}
          edit={(update) => {
            const next = update(value);
            edited(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Host />);
    expect(screen.getByLabelText('강도 라벨')).toHaveValue('');
    expect(edited).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('강도 라벨'), 'B');
    expect(edited.mock.lastCall?.[0].sessions[0]).toEqual({
      ...draft.sessions[0],
      intensityLabel: 'B',
    });
    await user.selectOptions(screen.getByLabelText('강도 라벨'), '');
    expect(edited.mock.lastCall?.[0].sessions[0]).toEqual({
      ...draft.sessions[0],
      intensityLabel: null,
    });
  });
  it('keeps intensity editing disabled after only a draft unlock', () => {
    const baseline = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        intensityLabel: 'A' as const,
        locks: { ...session.locks, intensity: true },
      })),
    };
    const unlocked = {
      ...baseline,
      sessions: baseline.sessions.map((session) => ({
        ...session,
        locks: { ...session.locks, intensity: false },
      })),
    };
    const props = {
      draft: unlocked,
      today: '2026-09-01',
      createId: () => 'new',
      onDuplicate: vi.fn(),
      edit: vi.fn(),
    };
    const view = render(<SessionEditor {...props} baseline={baseline} />);
    expect(screen.getByLabelText('강도 라벨')).toBeDisabled();
    view.rerender(<SessionEditor {...props} baseline={unlocked} />);
    expect(screen.getByLabelText('강도 라벨')).toBeEnabled();
  });
  it('shows neutral labels independently from zero RPE in review and detail', () => {
    const value = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        intensityLabel: 'C' as const,
        targetRpe: 0,
      })),
    };
    render(
      <>
        <PlanSummary draft={value} />
        <PlannedSessionDetail
          source={value}
          selected="session-1"
          visibleIds={['session-1']}
          draft
        />
      </>,
    );
    expect(screen.getAllByText(/강도 라벨: C/)).toHaveLength(2);
    expect(screen.getByText(/목표 RPE: 0/)).toBeVisible();
  });
  it('preserves labels through duplication, move and duration resize without touching original', () => {
    const value = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, intensityLabel: 'B' as const })),
    };
    const copy = duplicatePlannedSession(value, 'session-1', () => 'copy');
    expect(copy.ok).toBe(true);
    if (copy.ok) expect(copy.draft.sessions.at(-1)?.intensityLabel).toBe('B');
    for (const operation of [
      { kind: 'move' as const, date: '2026-09-10', blockId: 'block' },
      { kind: 'resize' as const, durationSeconds: 0 },
    ]) {
      const result = applyPlannedSessionOperation({
        draft: value,
        baseline: value,
        sessionId: 'session-1',
        today: '2026-09-01',
        operation,
      });
      expect(result.status).toBe('changed');
      if (result.status === 'changed') expect(result.draft.sessions[0]?.intensityLabel).toBe('B');
    }
    expect(value.sessions[0]?.durationSeconds).toBeNull();
    expect(value.sessions[0]?.date).toBe('2026-09-09');
  });
  it('hides and restores the intensity column without changing RPE or selection', async () => {
    const user = userEvent.setup();
    const value = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        intensityLabel: 'B' as const,
        targetRpe: 0,
      })),
    };
    function Host() {
      const [store] = useState(createPlannedTableInteractionStore);
      const [columns, setColumns] = useState<PlannedTableColumn[]>(['rpe', 'intensity']);
      return (
        <PlannedTable
          interactionStore={store}
          tablePinned={[]}
          onTablePinned={() => {}}
          source={value}
          days={[
            {
              date: '2026-09-09',
              timezone: 'Asia/Seoul',
              blockId: 'block',
              plannedSessionIds: ['session-1'],
              activityIds: [],
              knownRest: false,
            },
          ]}
          selected="session-1"
          onSelect={() => {}}
          tableSort="date_asc"
          tableColumns={columns}
          onTableSort={() => {}}
          onTableColumns={setColumns}
        />
      );
    }
    render(<Host />);
    expect(screen.getByRole('cell', { name: 'B' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '0' })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: '강도 라벨 열 표시' }));
    expect(screen.queryByRole('columnheader', { name: '강도 라벨' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '0' })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: '강도 라벨 열 표시' }));
    expect(screen.getByRole('cell', { name: 'B' })).toBeVisible();
    expect(screen.getByRole('button', { name: '계획: 쉬운 달리기' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('accepts intensity as independently visible and pinned URL column', () => {
    const state = readPlannedTableState(
      new URLSearchParams('plannedColumns=intensity,rpe&plannedPinned=intensity'),
    );
    expect(state.error).toBe(false);
    expect(state.columns).toEqual(['rpe', 'intensity']);
    expect(state.pinned).toEqual(['intensity']);
  });
});
