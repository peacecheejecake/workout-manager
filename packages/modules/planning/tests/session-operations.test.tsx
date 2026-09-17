import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { SessionDragProvider, DraggableSession, DayDropTarget } from '../src/session-drag';
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

const base = { draft, baseline: null, selected: 'session-1', today: '2026-09-09' };
describe('planned session operations', () => {
  it('keeps date-input alternatives and semantic content usable without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const onMove = vi.fn();
    try {
      render(
        <SessionDragProvider onMove={onMove}>
          <DayDropTarget date="2026-09-10" blockId="block">
            <DraggableSession sessionId="session-1" title="쉬운 달리기" disabled={false}>
              <button type="button">계획 선택</button>
            </DraggableSession>
          </DayDropTarget>
          <SessionOperations {...base} onOperation={vi.fn()} />
        </SessionDragProvider>,
      );
      expect(screen.getByRole('button', { name: '쉬운 달리기 날짜 이동 손잡이' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '계획 선택' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toBeEnabled();
      expect(screen.getByText(/손잡이를 사용할 수 없거나 준비 중/)).toBeVisible();
      expect(onMove).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('submits explicit date and Block without editing while typing or composing', async () => {
    const user = userEvent.setup();
    const onOperation = vi.fn();
    render(<SessionOperations {...base} onOperation={onOperation} />);
    fireEvent.change(screen.getByLabelText('이동할 날짜'), { target: { value: '2026-09-10' } });
    expect(onOperation).not.toHaveBeenCalled();
    fireEvent.compositionStart(screen.getByLabelText('이동할 날짜'));
    await user.click(screen.getByRole('button', { name: '계획 날짜 이동' }));
    expect(onOperation).not.toHaveBeenCalled();
    fireEvent.compositionEnd(screen.getByLabelText('이동할 날짜'));
    await user.click(screen.getByRole('button', { name: '계획 날짜 이동' }));
    expect(onOperation).toHaveBeenCalledExactlyOnceWith('session-1', {
      kind: 'move',
      date: '2026-09-10',
      blockId: 'block',
    });
  });
  it('keeps unknown length disabled for dragging but accepts explicit zero and fractional seconds', async () => {
    const user = userEvent.setup();
    const onOperation = vi.fn();
    render(<SessionOperations {...base} onOperation={onOperation} />);
    expect(screen.getByRole('slider')).toBeDisabled();
    const input = screen.getByLabelText('변경할 계획 시간 (초)');
    await user.click(screen.getByRole('button', { name: '계획 시간 적용' }));
    expect(onOperation).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('0 이상');
    await user.type(input, '0');
    await user.click(screen.getByRole('button', { name: '계획 시간 적용' }));
    expect(onOperation).toHaveBeenLastCalledWith('session-1', {
      kind: 'resize',
      durationSeconds: 0,
    });
    await user.clear(input);
    await user.type(input, '12.5');
    await user.click(screen.getByRole('button', { name: '계획 시간 적용' }));
    expect(onOperation).toHaveBeenLastCalledWith('session-1', {
      kind: 'resize',
      durationSeconds: 12.5,
    });
  });
  it('commits one keyboard resize on release and cancels Escape and viewport changes', () => {
    const onOperation = vi.fn();
    const known = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, durationSeconds: 12.5 })),
    };
    render(<SessionOperations {...base} draft={known} onOperation={onOperation} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onOperation).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onOperation).toHaveBeenCalledExactlyOnceWith('session-1', {
      kind: 'resize',
      durationSeconds: 14.5,
    });
    onOperation.mockClear();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'Escape' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onOperation).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent(window, new Event('resize'));
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onOperation).not.toHaveBeenCalled();
  });
  it('keeps pointer changes transient until release and cancels interrupted gestures', () => {
    const onOperation = vi.fn();
    const known = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, durationSeconds: 100 })),
    };
    render(<SessionOperations {...base} draft={known} onOperation={onOperation} />);
    const slider = screen.getByRole('slider');
    Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn() });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: '123.5' } });
    expect(onOperation).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(onOperation).toHaveBeenCalledExactlyOnceWith('session-1', {
      kind: 'resize',
      durationSeconds: 123.5,
    });
    onOperation.mockClear();
    fireEvent.pointerDown(slider, { pointerId: 2 });
    fireEvent.change(slider, { target: { value: '200' } });
    fireEvent.pointerCancel(slider, { pointerId: 2 });
    fireEvent.pointerUp(slider, { pointerId: 2 });
    expect(onOperation).not.toHaveBeenCalled();
  });
  it('keeps slider focus through committed draft updates and resets values on undo without stealing outside focus', async () => {
    const user = userEvent.setup();
    const onOperation = vi.fn();
    const known = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, durationSeconds: 100 })),
    };
    function Host() {
      const [value, setValue] = useState(known);
      return (
        <>
          <button type="button" onClick={() => setValue(known)}>
            테스트 되돌리기
          </button>
          <SessionOperations
            {...base}
            draft={value}
            onOperation={(id, operation) => {
              onOperation(id, operation);
              if (operation.kind === 'resize')
                setValue((current) => ({
                  ...current,
                  sessions: current.sessions.map((session) =>
                    session.id === id
                      ? { ...session, durationSeconds: operation.durationSeconds }
                      : session,
                  ),
                }));
            }}
          />
        </>
      );
    }
    render(<Host />);
    screen.getByRole('slider').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('slider')).toHaveFocus();
    expect(screen.getByRole('slider')).toHaveValue('101');
    await user.keyboard('{ArrowRight}');
    expect(onOperation).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('slider')).toHaveFocus();
    expect(screen.getByRole('slider')).toHaveValue('102');
    await user.click(screen.getByRole('button', { name: '테스트 되돌리기' }));
    expect(screen.getByRole('slider')).toHaveValue('100');
    expect(screen.getByRole('button', { name: '테스트 되돌리기' })).toHaveFocus();
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toHaveValue(100);
  });
  it('cancels a length gesture if viewport geometry changes before the resize event is delivered', () => {
    const onOperation = vi.fn();
    const known = {
      ...draft,
      sessions: draft.sessions.map((session) => ({ ...session, durationSeconds: 0 })),
    };
    render(<SessionOperations {...base} draft={known} onOperation={onOperation} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '1' } });
    vi.stubGlobal('innerWidth', 320);
    try {
      fireEvent.keyDown(slider, { key: 'ArrowRight', repeat: true });
      fireEvent.keyDown(slider, { key: 'ArrowRight', repeat: true });
      fireEvent.keyUp(slider, { key: 'ArrowRight' });
      expect(onOperation).not.toHaveBeenCalled();
      expect(slider).toHaveValue('0');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('retains keyboard focus on date and duration apply buttons after each committed operation', async () => {
    const user = userEvent.setup();
    function Host() {
      const [value, setValue] = useState(draft);
      return (
        <SessionOperations
          {...base}
          draft={value}
          onOperation={(id, operation) => {
            setValue((current) => ({
              ...current,
              sessions: current.sessions.map((session) =>
                session.id !== id
                  ? session
                  : operation.kind === 'move'
                    ? { ...session, date: operation.date, blockId: operation.blockId }
                    : { ...session, durationSeconds: operation.durationSeconds },
              ),
            }));
          }}
        />
      );
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText('이동할 날짜'), { target: { value: '2026-09-10' } });
    screen.getByRole('button', { name: '계획 날짜 이동' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toHaveFocus();
    expect(screen.getByLabelText('이동할 날짜')).toHaveValue('2026-09-10');
    await user.tab();
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toHaveFocus();
    await user.type(screen.getByLabelText('변경할 계획 시간 (초)'), '120');
    await user.tab();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: '계획 시간 적용' })).toHaveFocus();
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toHaveValue(120);
    await user.tab();
    expect(screen.getByRole('slider')).toHaveFocus();
  });
  it('blocks baseline locks and past edits, and preserves entered numeric text across viewport events', () => {
    const onOperation = vi.fn();
    const baseline = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        locks: { date: true, time: false, intensity: true },
      })),
    };
    const ui = render(
      <SessionOperations {...base} baseline={baseline} onOperation={onOperation} />,
    );
    expect(screen.getByRole('button', { name: '계획 날짜 이동' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '계획 시간 적용' })).toBeDisabled();
    ui.rerender(<SessionOperations {...base} today="2026-09-10" onOperation={onOperation} />);
    expect(screen.getByText(/과거 세션/)).toBeVisible();
    ui.rerender(<SessionOperations {...base} onOperation={onOperation} />);
    const input = screen.getByLabelText('변경할 계획 시간 (초)');
    fireEvent.change(input, { target: { value: '17.25' } });
    input.focus();
    fireEvent(window, new Event('resize'));
    expect(screen.getByLabelText('변경할 계획 시간 (초)')).toBe(input);
    expect(input).toHaveValue(17.25);
    expect(input).toHaveFocus();
    expect(onOperation).not.toHaveBeenCalled();
  });
});
