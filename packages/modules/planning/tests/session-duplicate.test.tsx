import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { SessionEditor } from '../src/plan-fields';
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

describe('session duplication control', () => {
  it('selects the unlocked copy while keeping source unchanged and makes no automatic save', async () => {
    const user = userEvent.setup();
    const original = structuredClone(draft);
    original.sessions = original.sessions.map((session) => ({
      ...session,
      locks: { date: true, time: true, intensity: true },
    }));
    const edited = vi.fn();
    const selected = vi.fn();
    function Host() {
      const [value, setValue] = useState(original);
      const [selection, setSelection] = useState<string | null>(null);
      return (
        <SessionEditor
          draft={value}
          baseline={original}
          today="2026-09-10"
          createId={() => 'new-session'}
          selectedId={selection}
          edit={(update) => {
            const next = update(value);
            edited(next);
            setValue(next);
          }}
          onDuplicate={(id) => {
            selected(id);
            setSelection(id);
          }}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('button', { name: '세션 복제' }));
    expect(selected).toHaveBeenCalledWith('new-session');
    expect(screen.getAllByRole('textbox', { name: '세션 제목' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: '세션 제목' })).toHaveFocus();
    expect(screen.getByLabelText('세션 날짜')).toBeEnabled();
    const next: PlanDraft | undefined = edited.mock.lastCall?.[0];
    expect(next?.sessions[0]).toEqual(original.sessions[0]);
    expect(next?.sessions[1]?.locks).toEqual({
      date: false,
      time: false,
      intensity: false,
      attendance: false,
    });
    expect(next?.sessions).toHaveLength(2);
    expect(screen.getByText(/원본 계획과 실제 기록은 그대로/)).toBeVisible();
  });
  it('reports invalid drafts and ID collisions without editing or changing selection', async () => {
    const user = userEvent.setup();
    const edit = vi.fn(),
      onDuplicate = vi.fn();
    const invalid = { ...draft, title: '' };
    const ui = render(
      <SessionEditor
        draft={invalid}
        baseline={draft}
        edit={edit}
        onDuplicate={onDuplicate}
        today="2026-09-10"
        createId={() => 'session-1'}
      />,
    );
    await user.click(screen.getByRole('button', { name: '세션 복제' }));
    expect(screen.getByRole('alert')).toHaveTextContent('입력 오류');
    ui.rerender(
      <SessionEditor
        draft={draft}
        baseline={draft}
        edit={edit}
        onDuplicate={onDuplicate}
        today="2026-09-10"
        createId={() => 'session-1'}
      />,
    );
    await user.click(screen.getByRole('button', { name: '세션 복제' }));
    expect(screen.getByRole('alert')).toHaveTextContent('겹칩니다');
    expect(edit).not.toHaveBeenCalled();
    expect(onDuplicate).not.toHaveBeenCalled();
  });
  it('disables duplication at the session limit with an explanation', () => {
    const first = draft.sessions[0];
    if (!first) throw new Error('Fixture requires a session');
    const full = {
      ...draft,
      sessions: Array.from({ length: 1000 }, (_, index) => ({ ...first, id: `session-${index}` })),
    };
    render(
      <SessionEditor
        draft={full}
        selectedId="session-0"
        baseline={null}
        edit={vi.fn()}
        onDuplicate={vi.fn()}
        today="2026-09-10"
        createId={() => 'unused'}
      />,
    );
    expect(screen.getByRole('button', { name: '세션 복제' })).toBeDisabled();
    expect(screen.getByText(/1,000개여서/)).toBeVisible();
  });
});
