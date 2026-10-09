import { StrictMode, createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModalDialog, type ModalDialogProps } from '../src/modal-dialog';

// jsdom does not implement the native top layer/inert/focus loop. These stubs
// verify delegation and controlled lifecycle, not real-browser native behavior.
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.open = true;
});
const close = vi.fn(function (this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
});
let trigger: HTMLButtonElement;
beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: showModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
  trigger = document.createElement('button');
  trigger.textContent = '열기';
  document.body.append(trigger);
  trigger.focus();
});
afterEach(() => {
  cleanup();
  trigger.remove();
  vi.restoreAllMocks();
  document.body.style.removeProperty('overflow');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
function props(): ModalDialogProps {
  return {
    open: true,
    title: '내용 확인',
    titleId: 'confirmation-title',
    closeLabel: '창 닫기',
    initialFocusRef: createRef<HTMLElement>(),
    returnFocusRef: { current: trigger },
    onRequestClose: vi.fn(),
    onOpenUnavailable: vi.fn(),
    children: <p>승인하지 않은 내용</p>,
  };
}
it('labels its heading and delegates modal opening with composed body and controls', () => {
  const input = createRef<HTMLInputElement>();
  render(
    <ModalDialog
      {...props()}
      initialFocusRef={input}
      controls={<button type="button">보존</button>}
    >
      <label>
        설명 <input ref={input} />
      </label>
    </ModalDialog>,
  );
  expect(screen.getByRole('dialog', { name: '내용 확인' })).toHaveAttribute(
    'aria-labelledby',
    'confirmation-title',
  );
  expect(screen.getByLabelText('설명')).toHaveFocus();
  expect(screen.getByRole('button', { name: '보존' })).toBeInTheDocument();
  expect(showModal).toHaveBeenCalledOnce();
});
it('requests cancel without closing until the controlling caller changes open', () => {
  const original = props();
  const view = render(<ModalDialog {...original} />);
  const dialog = screen.getByRole('dialog');
  const cancel = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(original.onRequestClose).toHaveBeenCalledExactlyOnceWith('cancel');
  expect(dialog).toHaveAttribute('open');
  view.rerender(<ModalDialog {...original} open={false} />);
  expect(close).toHaveBeenCalledOnce();
  expect(original.onRequestClose).toHaveBeenCalledTimes(1);
  expect(trigger).toHaveFocus();
});
it('offers a keyboard-operable close control and keeps domain actions with the caller', async () => {
  const original = props();
  render(<ModalDialog {...original} />);
  expect(screen.getByRole('button', { name: '창 닫기' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(original.onRequestClose).toHaveBeenCalledExactlyOnceWith('close');
  expect(screen.getByRole('dialog')).toHaveAttribute('open');
  expect(original.onOpenUnavailable).not.toHaveBeenCalled();
});
it('preserves edits and focus across callback/children rerenders without reopening', async () => {
  const original = props();
  const ref = createRef<HTMLInputElement>();
  const view = render(
    <ModalDialog {...original} initialFocusRef={ref}>
      <input ref={ref} aria-label="내용" />
    </ModalDialog>,
  );
  await userEvent.type(screen.getByLabelText('내용'), '한글 초안');
  const nextClose = vi.fn();
  view.rerender(
    <ModalDialog {...original} initialFocusRef={ref} onRequestClose={nextClose}>
      <input ref={ref} aria-label="내용" />
      <p>다른 안내</p>
    </ModalDialog>,
  );
  expect(screen.getByLabelText('내용')).toHaveValue('한글 초안');
  expect(screen.getByLabelText('내용')).toHaveFocus();
  expect(showModal).toHaveBeenCalledOnce();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(nextClose).toHaveBeenCalledExactlyOnceWith('cancel');
});
it('reopens after a controlled close and restores the explicit connected trigger', () => {
  const original = props();
  const view = render(<ModalDialog {...original} />);
  view.rerender(<ModalDialog {...original} open={false} />);
  expect(trigger).toHaveFocus();
  view.rerender(<ModalDialog {...original} />);
  expect(showModal).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '창 닫기' })).toHaveFocus();
  view.unmount();
  expect(trigger).toHaveFocus();
});
it('cleans strict-mode effect lifetimes and restores existing overflow priority and scroll', () => {
  document.body.style.setProperty('overflow', 'auto');
  // This jsdom CSSOM drops overflow priority. Verify the original priority is
  // passed back to native setProperty; browser CSSOM restoration remains a browser gate.
  vi.spyOn(document.body.style, 'getPropertyPriority').mockImplementation((name) =>
    name === 'overflow' && document.body.style.overflow === 'auto' ? 'important' : '',
  );
  const setProperty = vi.spyOn(document.body.style, 'setProperty');
  const original = props();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const view = render(
    <StrictMode>
      <ModalDialog {...original} />
    </StrictMode>,
  );
  expect(document.body.style.overflow).toBe('hidden');
  expect(original.onRequestClose).not.toHaveBeenCalled();
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  expect(setProperty).toHaveBeenCalledWith('overflow', 'auto', 'important');
  expect(window.scrollX).toBe(scrollX);
  expect(window.scrollY).toBe(scrollY);
  expect(trigger).toHaveFocus();
});
it.each(['removed', 'disabled'] as const)('does not focus a %s trigger during cleanup', (kind) => {
  const original = props();
  const focus = vi.spyOn(trigger, 'focus');
  const view = render(<ModalDialog {...original} />);
  if (kind === 'removed') trigger.remove();
  else trigger.disabled = true;
  view.unmount();
  expect(focus).not.toHaveBeenCalled();
});
it('falls back to close when initial focus is outside the modal or disabled', () => {
  const original = props();
  const view = render(<ModalDialog {...original} initialFocusRef={{ current: trigger }} />);
  expect(screen.getByRole('button', { name: '창 닫기' })).toHaveFocus();
  view.unmount();
  const ref = createRef<HTMLInputElement>();
  render(
    <ModalDialog {...original} initialFocusRef={ref}>
      <input disabled ref={ref} aria-label="비활성" />
    </ModalDialog>,
  );
  expect(screen.getByRole('button', { name: '창 닫기' })).toHaveFocus();
});
it('explicitly refuses a second document modal without touching the first or its scroll lock', () => {
  const first = props();
  const second = { ...props(), title: '두 번째', titleId: 'second-title' };
  const view = render(
    <>
      <ModalDialog {...first} />
      <ModalDialog {...second} />
    </>,
  );
  expect(showModal).toHaveBeenCalledOnce();
  expect(second.onOpenUnavailable).toHaveBeenCalledExactlyOnceWith('modal_already_open');
  expect(first.onOpenUnavailable).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe('hidden');
  expect(document.querySelector('dialog[aria-labelledby="second-title"]')).not.toHaveAttribute(
    'open',
  );
  view.unmount();
  expect(document.body.style.overflow).toBe('');
});
it('reports missing native support without pretending a nonmodal fallback is equivalent', () => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  const original = props();
  render(<ModalDialog {...original} />);
  expect(original.onOpenUnavailable).toHaveBeenCalledExactlyOnceWith('native_dialog_unavailable');
  expect(document.querySelector('dialog')).not.toHaveAttribute('open');
  expect(document.body.style.overflow).toBe('');
});
it('requests closure for native method-dialog close but ignores delayed close after reopen', () => {
  const original = props();
  const view = render(<ModalDialog {...original} />);
  const dialog = screen.getByRole('dialog');
  dialog.removeAttribute('open');
  fireEvent(dialog, new Event('close'));
  expect(original.onRequestClose).toHaveBeenCalledExactlyOnceWith('close');
  view.rerender(<ModalDialog {...original} open={false} />);
  view.rerender(<ModalDialog {...original} />);
  fireEvent(screen.getByRole('dialog'), new Event('close'));
  expect(original.onRequestClose).toHaveBeenCalledTimes(1);
});
it('preserves another owner’s overflow mutation during unmount', () => {
  const view = render(<ModalDialog {...props()} />);
  document.body.style.setProperty('overflow', 'clip');
  view.unmount();
  expect(document.body.style.overflow).toBe('clip');
});
