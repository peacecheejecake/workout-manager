import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HelpTooltip } from '../src/help-tooltip';

// Native popover layout is absent in jsdom; emulate the UA display toggle only.
// Corridor coordinates below are synthetic geometry, not a real browser proof.
const active = new WeakSet<HTMLElement>();
const showPopover = vi.fn(function (this: HTMLElement) {
  active.add(this);
  this.style.display = 'block';
});
const hidePopover = vi.fn(function (this: HTMLElement) {
  active.delete(this);
  this.style.display = 'none';
});
function point(target: Element, type: string, x: number, y: number, pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerType: { value: pointerType },
  });
  fireEvent(target, event);
}
beforeEach(() => {
  vi.useFakeTimers();
  showPopover.mockClear();
  hidePopover.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: showPopover,
  });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: hidePopover,
  });
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (
    this: HTMLElement,
    selector,
  ) {
    return selector === ':popover-open' ? active.has(this) : matches.call(this, selector);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'tooltip'
      ? new DOMRect(20, 46, 100, 30)
      : new DOMRect(20, 20, 30, 20);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
  Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover');
  vi.useRealTimers();
});
function example(interaction: 'available' | 'dragging' = 'available') {
  return (
    <HelpTooltip
      label="단위 설명"
      description="추정이 아닌 보고한 값입니다."
      interaction={interaction}
    />
  );
}
function step(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
it('uses labelled buttons with distinct stable describedBy IDs and pure text descriptions', () => {
  const view = render(
    <>
      {example()}
      {example()}
    </>,
  );
  const buttons = screen.getAllByRole('button', { name: '단위 설명' });
  const ids = buttons.map((button) => button.getAttribute('aria-describedby'));
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(id).not.toBeNull();
    expect(document.getElementById(id ?? '')?.tagName).toBe('SPAN');
    expect(document.getElementById(id ?? '')).toHaveTextContent('추정이 아닌 보고한 값입니다.');
  }
  view.rerender(
    <>
      {example()}
      {example()}
    </>,
  );
  expect(
    screen.getAllByRole('button').map((button) => button.getAttribute('aria-describedby')),
  ).toEqual(ids);
});
it('opens after exactly 250ms and closes after 100ms without pending timer leaks', () => {
  render(example());
  const button = screen.getByRole('button');
  point(button, 'pointerover', 30, 25);
  step(249);
  expect(showPopover).not.toHaveBeenCalled();
  step(1);
  expect(screen.getByRole('tooltip')).toBeVisible();
  point(button, 'pointerout', 30, 40);
  step(99);
  expect(screen.getByRole('tooltip')).toBeVisible();
  step(1);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps a bounded safe progression to the actual tooltip and supports hovering its text', () => {
  render(example());
  const button = screen.getByRole('button');
  point(button, 'pointerover', 30, 25);
  step(250);
  point(button, 'pointerout', 30, 40);
  point(document.body, 'pointermove', 30, 43);
  const tooltip = screen.getByRole('tooltip');
  point(tooltip, 'pointerover', 30, 47);
  step(1000);
  expect(tooltip).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);
  point(tooltip, 'pointerout', 40, 77);
  step(100);
  expect(screen.queryByRole('tooltip')).toBeNull();
});
it.each([
  [300, 43],
  [30, 38],
])('does not hover-lock unrelated or receding point %s,%s', (x, y) => {
  render(example());
  const button = screen.getByRole('button');
  point(button, 'pointerover', 30, 25);
  step(250);
  point(button, 'pointerout', 30, 40);
  point(document.body, 'pointermove', x, y);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('opens immediately on keyboard focus, persists while focused and dismisses Escape until a new interaction', () => {
  render(example());
  const button = screen.getByRole('button');
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip')).toBeVisible();
  point(button, 'pointerout', 30, 40);
  step(1000);
  expect(screen.getByRole('tooltip')).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  step(1000);
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.blur(button);
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip')).toBeVisible();
});
it('cancels a pending hover on Escape before it can open', () => {
  render(example());
  point(screen.getByRole('button'), 'pointerover', 30, 25);
  step(100);
  fireEvent.keyDown(document, { key: 'Escape' });
  step(1000);
  expect(showPopover).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('offers a genuine touch click path without depending on hover or losing the first click to focus', () => {
  render(example());
  const button = screen.getByRole('button');
  point(button, 'pointerover', 30, 25, 'touch');
  step(1000);
  expect(showPopover).not.toHaveBeenCalled();
  point(button, 'pointerdown', 30, 25, 'touch');
  fireEvent.focus(button);
  expect(showPopover).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(screen.getByRole('tooltip')).toBeVisible();
  fireEvent.click(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
});
it('closes during dragging, clears timers and does not automatically reopen after drag ends', () => {
  const view = render(example());
  fireEvent.focus(screen.getByRole('button'));
  view.rerender(example('dragging'));
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(example());
  expect(screen.queryByRole('tooltip')).toBeNull();
});
it('cleans pending timers, listeners and native overlay on unmount', () => {
  const view = render(example());
  point(screen.getByRole('button'), 'pointerover', 30, 25);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const next = render(example());
  fireEvent.focus(screen.getByRole('button'));
  const remove = vi.spyOn(document, 'removeEventListener');
  next.unmount();
  expect(hidePopover).toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
});
it('shows accessible inline text when native popover is absent, without claiming overlay support', () => {
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
  render(example());
  const button = screen.getByRole('button');
  const text = screen.getByText('추정이 아닌 보고한 값입니다.');
  expect(text).toBeVisible();
  expect(button.parentElement).toHaveAttribute('data-presentation', 'inline-description');
  expect(button).toHaveAccessibleDescription('추정이 아닌 보고한 값입니다.');
  expect(screen.queryByRole('tooltip')).toBeNull();
});
it('uses explicit inline fallback for a failed native open and never puts actions in the description', () => {
  showPopover.mockImplementationOnce(() => {
    throw new DOMException('synthetic');
  });
  render(<HelpTooltip label="도움" description="<button>승인</button>" interaction="available" />);
  fireEvent.focus(screen.getByRole('button'));
  expect(screen.getByText('<button>승인</button>')).toBeVisible();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button').parentElement).toHaveAttribute(
    'data-presentation',
    'inline-description',
  );
});

it('keeps focus and Escape immediate under the reduced-motion preference', () => {
  render(<div data-motion="reduced">{example()}</div>);
  fireEvent.focus(screen.getByRole('button'));
  expect(screen.getByRole('tooltip')).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('resets a cancelled touch and lets a new click reopen after Escape', () => {
  render(example());
  const button = screen.getByRole('button');
  point(button, 'pointerdown', 30, 25, 'touch');
  point(button, 'pointercancel', 30, 25, 'touch');
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip')).toBeVisible();
  fireEvent.click(button);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.click(button);
  expect(screen.getByRole('tooltip')).toBeVisible();
});
