import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionPanel } from '../src/interaction-panel';
import type * as DndReact from '@dnd-kit/react';

const activationRequested = vi.hoisted(() => vi.fn());
vi.mock('@dnd-kit/react', async (importOriginal) => {
  const actual = await importOriginal<typeof DndReact>();
  return {
    ...actual,
    DragDropProvider: (props: Parameters<typeof actual.DragDropProvider>[0]) => (
      <actual.DragDropProvider
        {...props}
        onBeforeDragStart={(event) => {
          activationRequested();
          // Inspect real sensor activation, then cancel before JSDOM's missing layout APIs.
          event.preventDefault();
        }}
      />
    ),
  };
});

// dnd-kit creates its shared resize notifier at module initialization.
vi.hoisted(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

// JSDOM has no PointerEvent constructor; keep the sensor's real event handling.
class TestPointerEvent extends MouseEvent {
  readonly pointerId = 1;
  readonly pointerType: string;
  readonly isPrimary = true;

  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerType = options.pointerType ?? 'touch';
  }
}

beforeEach(() => {
  activationRequested.mockClear();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function touch(target: HTMLElement, type: string, clientY: number) {
  fireEvent(
    target,
    new TestPointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      clientX: 40,
      clientY,
      button: 0,
    }),
  );
}

describe('touch sort handle activation', () => {
  it('requests activation beyond the tap threshold without waiting for a hold', () => {
    vi.useFakeTimers();
    render(<InteractionPanel />);
    const handle = screen.getByRole('button', { name: '준비 운동 예시 이동 손잡이' });
    touch(handle, 'pointerdown', 40);
    touch(handle, 'pointermove', 44);
    expect(activationRequested).not.toHaveBeenCalled();
    touch(handle, 'pointermove', 48);
    expect(activationRequested).toHaveBeenCalledOnce();
    touch(handle, 'pointercancel', 48);
    expect(screen.getByRole('status', { name: '현재 합성 순서' })).toHaveTextContent(
      '현재 순서: 준비 운동 예시 → 본 운동 예시 → 정리 운동 예시',
    );
  });

  it('leaves a stationary touch and a tap as non-drag interactions', async () => {
    vi.useFakeTimers();
    render(<InteractionPanel />);
    const handle = screen.getByRole('button', { name: '준비 운동 예시 이동 손잡이' });
    touch(handle, 'pointerdown', 40);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(activationRequested).not.toHaveBeenCalled();
    touch(handle, 'pointerup', 40);
    expect(screen.getByRole('status', { name: '현재 합성 순서' })).toHaveTextContent(
      '현재 순서: 준비 운동 예시 → 본 운동 예시 → 정리 운동 예시',
    );
  });

  it('retains the tap alternatives and Korean composition draft', async () => {
    const user = userEvent.setup();
    render(<InteractionPanel />);
    const draft = screen.getByRole('textbox', { name: '크기 조절 중 유지할 초안' });
    fireEvent.compositionStart(draft, { data: '한' });
    fireEvent.change(draft, { target: { value: '한글 초안' } });
    fireEvent.compositionEnd(draft, { data: '한글' });
    await user.click(screen.getByRole('button', { name: '준비 운동 예시 아래로' }));
    expect(screen.getByRole('status', { name: '현재 합성 순서' })).toHaveTextContent(
      '현재 순서: 본 운동 예시 → 준비 운동 예시 → 정리 운동 예시',
    );
    expect(draft).toHaveValue('한글 초안');
  });
});
