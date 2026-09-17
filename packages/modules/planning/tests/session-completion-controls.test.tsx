import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { SessionEditor } from '../src/plan-fields';
import { SessionOperations } from '../src/session-operations';
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

const editorProps = {
  draft,
  baseline: null,
  today: '2026-09-09',
  createId: () => 'copy',
  onDuplicate: vi.fn(),
};
const operationProps = { draft, baseline: null, today: '2026-09-09', selected: 'session-1' };

describe('user-reported completion schedule protection', () => {
  it('protects schedule and deletion while retaining content, duration and duplicate controls; retraction restores editing', async () => {
    const user = userEvent.setup();
    const edit = vi.fn();
    const view = render(
      <SessionEditor {...editorProps} completedSessionIds={['session-1']} edit={edit} />,
    );
    for (const label of ['소속 Block', '세션 날짜', '시작 시각 (미정 가능)'])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 복제' })).toBeEnabled();
    expect(screen.getByText(/완료 자기보고가 있어/)).toBeVisible();
    expect(screen.getByLabelText('세션 제목')).toBeEnabled();
    expect(screen.getByRole('button', { name: '단계 추가' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('세션 제목'), { target: { value: '내용 정정' } });
    expect(edit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '세션 삭제' }));
    expect(edit).toHaveBeenCalledTimes(1);
    view.rerender(<SessionEditor {...editorProps} completedSessionIds={[]} edit={edit} />);
    for (const label of ['소속 Block', '세션 날짜', '시작 시각 (미정 가능)'])
      expect(screen.getByLabelText(label)).toBeEnabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeEnabled();
    expect(screen.queryByText(/완료 자기보고가 있어/)).not.toBeInTheDocument();
  });
  it('duplicates a completed session into a new unprotected ID without changing original locks or schedule', async () => {
    const user = userEvent.setup();
    const original = structuredClone(draft);
    const edited = vi.fn();
    function Host() {
      const [value, setValue] = useState(draft);
      const [selected, setSelected] = useState('session-1');
      return (
        <SessionEditor
          {...editorProps}
          draft={value}
          selectedId={selected}
          completedSessionIds={['session-1']}
          onDuplicate={setSelected}
          edit={(update) => {
            const next = update(value);
            edited(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('button', { name: '세션 복제' }));
    expect(screen.getByLabelText('세션 제목')).toHaveValue('쉬운 달리기 복사');
    expect(screen.getByLabelText('세션 날짜')).toBeEnabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeEnabled();
    expect(edited.mock.lastCall?.[0].sessions).toEqual([
      original.sessions[0],
      { ...original.sessions[0], id: 'copy', title: '쉬운 달리기 복사' },
    ]);
    expect(draft).toEqual(original);
  });
  it('blocks only movement while completed and preserves duration entry across completion/retraction updates', async () => {
    const user = userEvent.setup();
    const onOperation = vi.fn();
    const view = render(
      <SessionOperations
        {...operationProps}
        completedSessionIds={['session-1']}
        onOperation={onOperation}
      />,
    );
    for (const label of ['이동할 날짜', '이동할 Block'])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toBeDisabled();
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toBeEnabled();
    expect(screen.getByRole('slider')).toBeDisabled(); // Unknown is not guessed.
    fireEvent.change(screen.getByLabelText('변경할 계획 시간 (초)'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: '계획 시간 적용' }));
    expect(onOperation).toHaveBeenCalledExactlyOnceWith('session-1', {
      kind: 'resize',
      durationSeconds: 0,
    });
    await user.click(screen.getByRole('button', { name: '계획 날짜 이동' }));
    expect(onOperation).toHaveBeenCalledTimes(1);
    view.rerender(
      <SessionOperations {...operationProps} completedSessionIds={[]} onOperation={onOperation} />,
    );
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toHaveValue(0);
    expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toBeEnabled();
    expect(screen.queryByText(/완료 자기보고가 있어/)).not.toBeInTheDocument();
  });
  it('keeps saved date/time/intensity locks after completion is retracted', () => {
    const baseline = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        locks: { date: true, time: true, intensity: true },
      })),
    };
    const view = render(
      <SessionEditor
        {...editorProps}
        baseline={baseline}
        completedSessionIds={['session-1']}
        edit={vi.fn()}
      />,
    );
    view.rerender(
      <SessionEditor
        {...editorProps}
        baseline={baseline}
        completedSessionIds={[]}
        edit={vi.fn()}
      />,
    );
    for (const label of ['소속 Block', '세션 날짜', '시작 시각 (미정 가능)'])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: '단계 추가' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 복제' })).toBeEnabled();
    view.unmount();
    render(
      <SessionOperations
        {...operationProps}
        baseline={baseline}
        completedSessionIds={[]}
        onOperation={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '계획 시간 적용' })).toBeDisabled();
  });
});
