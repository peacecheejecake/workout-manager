import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardLayoutEditor } from '../src/dashboard-layout-editor';
import { createDashboardLayoutStore } from '../src/dashboard-layout';
const widgets = {
  plan: <input aria-label="계획 메모" defaultValue="초안 유지" />,
  'check-in': <p>체크인 관측 0</p>,
  'period-summary': <p>기간 관측</p>,
  'daily-distance': <p>거리 관측 미확인</p>,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('dashboard layout editor', () => {
  it('enables controls only during editing and preserves widget DOM and focus through reorder/cancel', async () => {
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    render(<DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" />);
    const input = screen.getByLabelText('계획 메모');
    expect(screen.queryByRole('button', { name: '현재 계획 이동 손잡이' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    expect(screen.getByLabelText('계획 메모')).toBe(input);
    const position = screen.getByLabelText('현재 계획 위치');
    position.focus();
    await user.selectOptions(position, '2');
    expect(position).toHaveFocus();
    expect(screen.getByLabelText('계획 메모')).toBe(input);
    expect(store.getState().draft?.order[2]).toBe('plan');
    expect(store.getState().committed.order[0]).toBe('plan');
    await user.click(screen.getByRole('button', { name: '배치 취소' }));
    expect(store.getState().draft).toBeNull();
    expect(store.getState().committed.order[0]).toBe('plan');
    expect(screen.getByLabelText('계획 메모')).toBe(input);
    expect(input).toHaveValue('초안 유지');
    await waitFor(() => expect(screen.getByRole('button', { name: '배치 편집' })).toHaveFocus());
  });
  it('keeps per-mode size preferences and explicit apply/default/cancel semantics', async () => {
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    const onApply = vi.fn();
    const ui = render(
      <DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" onApply={onApply} />,
    );
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    await user.selectOptions(screen.getByLabelText('현재 계획 너비'), 'wide');
    ui.rerender(
      <DashboardLayoutEditor store={store} widgets={widgets} mode="mobile" onApply={onApply} />,
    );
    expect(screen.getByText(/한 열로 표시/)).toBeVisible();
    expect(store.getState().draft?.sizes.desktop.plan).toBe('wide');
    expect(screen.getByLabelText('현재 계획 너비')).toHaveValue('standard');
    ui.rerender(
      <DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" onApply={onApply} />,
    );
    expect(screen.getByLabelText('현재 계획 너비')).toHaveValue('wide');
    await user.click(screen.getByRole('button', { name: '배치 적용' }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(store.getState().committed);
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    await user.click(screen.getByRole('button', { name: '기본 배치로 되돌리기' }));
    expect(screen.getByLabelText('현재 계획 너비')).toHaveValue('standard');
    await user.click(screen.getByRole('button', { name: '배치 취소' }));
    expect(store.getState().committed.sizes.desktop.plan).toBe('wide');
  });
  it('offers keyboard and touch-friendly alternatives without a drag adapter', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    render(<DashboardLayoutEditor store={store} widgets={widgets} mode="mobile" />);
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    expect(screen.getByRole('button', { name: '현재 계획 이동 손잡이' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '현재 계획 아래로' }));
    expect(store.getState().draft?.order[1]).toBe('plan');
    screen.getByRole('button', { name: '현재 계획 너비 조절 손잡이' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(store.getState().draft?.sizes.mobile.plan).toBe('wide');
    expect(store.getState().committed.sizes.mobile.plan).toBe('standard');
    act(() => store.getState().actions.setStorageStatus('unavailable'));
    expect(screen.getByRole('status')).toHaveTextContent('현재 화면에서만 유지');
  });
  it('moves focus to the position select when a move button becomes disabled', async () => {
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    render(<DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" />);
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    await user.click(screen.getByRole('button', { name: '최신 체크인 위로' }));
    expect(screen.getByRole('button', { name: '최신 체크인 위로' })).toBeDisabled();
    expect(screen.getByLabelText('최신 체크인 위치')).toHaveFocus();
  });
  it('keeps the same focused resize grip across mode changes and cancels uncommitted gesture', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    const ui = render(<DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" />);
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    const grip = screen.getByRole('button', { name: '현재 계획 너비 조절 손잡이' });
    grip.focus();
    Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() });
    fireEvent.pointerDown(grip, { clientX: 100 });
    fireEvent.pointerMove(grip, { clientX: 180 });
    ui.rerender(<DashboardLayoutEditor store={store} widgets={widgets} mode="mobile" />);
    expect(screen.getByRole('button', { name: '현재 계획 너비 조절 손잡이' })).toBe(grip);
    expect(grip).toHaveFocus();
    fireEvent.pointerUp(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.mobile.plan).toBe('standard');
    expect(store.getState().draft?.sizes.desktop.plan).toBe('standard');
  });
  it('commits pointer resizing on release only and cancels interrupted gestures', async () => {
    let width = 1000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, width, 500),
    );
    vi.stubGlobal('PointerEvent', MouseEvent);
    const user = userEvent.setup();
    const store = createDashboardLayoutStore();
    render(<DashboardLayoutEditor store={store} widgets={widgets} mode="desktop" />);
    await user.click(screen.getByRole('button', { name: '배치 편집' }));
    const grip = screen.getByRole('button', { name: '현재 계획 너비 조절 손잡이' });
    Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() });
    fireEvent.pointerDown(grip, { clientX: 100 });
    fireEvent.pointerMove(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.desktop.plan).toBe('standard');
    fireEvent.keyDown(grip, { key: 'Escape' });
    fireEvent.pointerUp(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.desktop.plan).toBe('standard');
    fireEvent.pointerDown(grip, { clientX: 100 });
    fireEvent.pointerMove(grip, { clientX: 180 });
    fireEvent(window, new Event('resize'));
    fireEvent.pointerUp(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.desktop.plan).toBe('standard');
    fireEvent.pointerDown(grip, { clientX: 100 });
    fireEvent.pointerMove(grip, { clientX: 180 });
    width = 900;
    fireEvent.pointerUp(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.desktop.plan).toBe('standard');
    fireEvent.pointerDown(grip, { clientX: 100 });
    fireEvent.pointerMove(grip, { clientX: 180 });
    fireEvent.pointerUp(grip, { clientX: 180 });
    expect(store.getState().draft?.sizes.desktop.plan).toBe('wide');
  });
});
