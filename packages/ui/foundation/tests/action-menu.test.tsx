import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionMenu, type ActionMenuAction } from '../src/action-menu';

// jsdom has no native top layer. These stubs prove delegation, not browser clipping/geometry.
const show = vi.fn(function (this: HTMLElement) {
  this.style.display = 'block';
});
const hide = vi.fn(function (this: HTMLElement) {
  this.style.display = 'none';
});
const select = vi.fn();
const actions: readonly ActionMenuAction[] = [
  { id: 'first', label: '복사', state: 'enabled', onSelect: select },
  { id: 'disabled', label: '삭제', state: 'disabled' },
  { id: 'last', label: '저장', state: 'enabled', onSelect: select },
];
function Example({ list = actions }: { list?: readonly ActionMenuAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button>앞</button>
      <ActionMenu label="항목 작업" open={open} onOpenChange={setOpen} actions={list} />
      <button>뒤</button>
    </>
  );
}
beforeEach(() => {
  show.mockClear();
  hide.mockClear();
  select.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
  Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover');
});
it('uses labelled controlled state and touch/click activation, never hover activation', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole('button', { name: '항목 작업' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.hover(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.pointerDown(trigger, { pointerType: 'touch' });
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('menu', { name: '항목 작업' })).toHaveAttribute(
    'data-presentation',
    'native-popover',
  );
  expect(show).toHaveBeenCalledOnce();
  expect(screen.getByRole('menuitem', { name: '복사' })).toHaveFocus();
  await user.click(screen.getByRole('menuitem', { name: '저장' }));
  expect(select).toHaveBeenCalledOnce();
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
});
it('only requests a state change when its owner does not accept it', async () => {
  const onOpenChange = vi.fn();
  render(<ActionMenu label="작업" open={false} onOpenChange={onOpenChange} actions={actions} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '작업' }));
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(select).not.toHaveBeenCalled();
});
it('handles last-item open, arrow wrap, Home/End, disabled focus and Escape restore', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole('button', { name: '항목 작업' });
  trigger.focus();
  await user.keyboard('{ArrowUp}');
  expect(screen.getByRole('menuitem', { name: '저장' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: '복사' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  const disabled = screen.getByRole('menuitem', { name: '삭제' });
  expect(disabled).toHaveFocus();
  expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await user.keyboard('{Enter}');
  await user.click(disabled);
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).toBeVisible();
  await user.keyboard('{End}');
  expect(screen.getByRole('menuitem', { name: '저장' })).toHaveFocus();
  await user.keyboard('{Home}');
  expect(screen.getByRole('menuitem', { name: '복사' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
});
it('matches typeahead prefixes and cycles repeated letters without triggering an action', async () => {
  const list: readonly ActionMenuAction[] = [
    { id: 'alpha', label: 'Alpha', state: 'enabled', onSelect: select },
    { id: 'beta', label: 'Beta', state: 'enabled', onSelect: select },
    { id: 'bravo', label: 'Bravo', state: 'enabled', onSelect: select },
  ];
  const user = userEvent.setup();
  render(<Example list={list} />);
  await user.click(screen.getByRole('button', { name: '항목 작업' }));
  await user.keyboard('b');
  expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
  await user.keyboard('b');
  expect(screen.getByRole('menuitem', { name: 'Bravo' })).toHaveFocus();
  await user.keyboard('r');
  expect(screen.getByRole('menuitem', { name: 'Bravo' })).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
});
it('ignores composing key events and preserves literal text', async () => {
  render(
    <Example
      list={[{ id: 'plain', label: '<b>복사</b>', state: 'enabled', onSelect: select }, ...actions]}
    />,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: '항목 작업' }));
  const first = screen.getByRole('menuitem', { name: '<b>복사</b>' });
  expect(first.querySelector('b')).toBeNull();
  fireEvent.keyDown(first, { key: 'End', isComposing: true });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'ArrowDown', keyCode: 229 });
  expect(first).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
});
it('dismisses with Tab/ShiftTab without trapping focus, or outside click without stealing it', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole('button', { name: '항목 작업' });
  await user.click(trigger);
  await user.tab();
  expect(screen.getByRole('button', { name: '뒤' })).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.tab({ shift: true });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: '앞' }));
  expect(screen.getByRole('button', { name: '앞' })).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
});
it('returns focus when the owner closes while a menuitem owns focus', () => {
  const change = vi.fn();
  const view = render(<ActionMenu label="작업" open onOpenChange={change} actions={actions} />);
  expect(screen.getByRole('menuitem', { name: '복사' })).toHaveFocus();
  view.rerender(<ActionMenu label="작업" open={false} onOpenChange={change} actions={actions} />);
  expect(screen.getByRole('button', { name: '작업' })).toHaveFocus();
  expect(hide).toHaveBeenCalledOnce();
});
it('has an honest usable inline fallback for absent or throwing native popover', async () => {
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
  const user = userEvent.setup();
  const view = render(<Example />);
  await user.click(screen.getByRole('button', { name: '항목 작업' }));
  expect(screen.getByRole('menu')).toHaveAttribute('data-presentation', 'inline-fallback');
  await user.click(screen.getByRole('menuitem', { name: '복사' }));
  expect(select).toHaveBeenCalledOnce();
  view.unmount();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: () => {
      throw new DOMException('synthetic native failure');
    },
  });
  render(<Example />);
  await user.click(screen.getByRole('button', { name: '항목 작업' }));
  expect(screen.getByRole('menu')).toHaveAttribute('data-presentation', 'inline-fallback');
  expect(screen.getByRole('menuitem', { name: '복사' })).toHaveFocus();
});
it('keeps an empty menu dismissible and releases global listeners on unmount', async () => {
  const remove = vi.spyOn(document, 'removeEventListener');
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <Example list={[]} />
    </StrictMode>,
  );
  await user.click(screen.getByRole('button', { name: '항목 작업' }));
  expect(screen.getByRole('menu')).toHaveFocus();
  await user.keyboard('{ArrowDown}{ArrowUp}{Escape}');
  expect(screen.getByRole('button', { name: '항목 작업' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '항목 작업' }));
  view.unmount();
  expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('focusin', expect.any(Function));
  remove.mockRestore();
});

it('keeps separate instances independent and does not revive a removed action callback', async () => {
  const oldSelect = vi.fn();
  const change = vi.fn();
  const view = render(
    <>
      <ActionMenu
        label="첫 메뉴"
        open
        onOpenChange={change}
        actions={[{ id: 'a', label: '원 작업', state: 'enabled', onSelect: oldSelect }]}
      />
      <ActionMenu label="둘째 메뉴" open={false} onOpenChange={change} actions={actions} />
    </>,
  );
  const id = screen.getByRole('button', { name: '첫 메뉴' }).getAttribute('aria-controls');
  expect(id).not.toBe(
    screen.getByRole('button', { name: '둘째 메뉴' }).getAttribute('aria-controls'),
  );
  view.rerender(
    <>
      <ActionMenu
        label="첫 메뉴"
        open
        onOpenChange={change}
        actions={[{ id: 'a', label: '원 작업', state: 'disabled' }]}
      />
      <ActionMenu label="둘째 메뉴" open={false} onOpenChange={change} actions={actions} />
    </>,
  );
  await userEvent.setup().click(screen.getByRole('menuitem', { name: '원 작업' }));
  expect(oldSelect).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '둘째 메뉴' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

it('skips controls under CSS-hidden ancestors when dismissing by Tab', async () => {
  const user = userEvent.setup();
  function HiddenExample() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ActionMenu label="작업" open={open} onOpenChange={setOpen} actions={actions} />
        <div style={{ display: 'none' }}>
          <button>숨긴 버튼</button>
        </div>
        <button>보이는 다음</button>
      </>
    );
  }
  render(<HiddenExample />);
  await user.click(screen.getByRole('button', { name: '작업' }));
  await user.tab();
  expect(screen.getByRole('button', { name: '보이는 다음' })).toHaveFocus();
  expect(screen.queryByRole('menu')).toBeNull();
});
it('restricts Tab to the enclosing modal scope instead of an outside document control', async () => {
  // Only :modal is stubbed: jsdom does not implement UA top-layer inertness.
  const matches = Element.prototype.matches;
  const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':modal'
      ? this.tagName === 'DIALOG' && this.hasAttribute('open')
      : matches.call(this, selector);
  });
  function ModalExample() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <dialog open aria-label="대화상자">
          <button>대화상자 첫 버튼</button>
          <ActionMenu label="작업" open={open} onOpenChange={setOpen} actions={actions} />
        </dialog>
        <button>모달 밖 버튼</button>
      </>
    );
  }
  try {
    const user = userEvent.setup();
    render(<ModalExample />);
    await user.click(screen.getByRole('button', { name: '작업' }));
    await user.tab();
    expect(screen.getByRole('button', { name: '대화상자 첫 버튼' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '모달 밖 버튼' })).not.toHaveFocus();
    expect(screen.queryByRole('menu')).toBeNull();
  } finally {
    spy.mockRestore();
  }
});
it('moves owned focus to the next surviving item, then empty menu, after actions are removed without replay', async () => {
  const onOpenChange = vi.fn();
  const view = render(
    <ActionMenu label="작업" open onOpenChange={onOpenChange} actions={actions} />,
  );
  const user = userEvent.setup();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: '삭제' })).toHaveFocus();
  view.rerender(
    <ActionMenu
      label="작업"
      open
      onOpenChange={onOpenChange}
      actions={actions.filter((action) => action.id !== 'disabled')}
    />,
  );
  expect(screen.getByRole('menuitem', { name: '저장' })).toHaveFocus();
  view.rerender(<ActionMenu label="작업" open onOpenChange={onOpenChange} actions={[]} />);
  expect(screen.getByRole('menu')).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(screen.getByRole('button', { name: '작업' })).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
});
