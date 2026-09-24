import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { courseLimits, type CourseWaypoint } from '@workout/contracts/courses';
import type { CourseDraftStore } from '../src/course-draft';
import { CourseDraftProvider, useCourseDraftStore } from '../src/course-draft-context';
import { WaypointListEditor } from '../src/course-waypoint-list';

/**
 * M2-01k-i: drag to reorder the waypoint list, with a pointer and with the keyboard.
 *
 * What matters is that a drag is not a second way to edit the order: it goes through the
 * draft's one reorder action, so it is undoable, it obeys the lock rule, and it ends in the
 * same draft the "앞으로/뒤로" buttons produce. The list is read back as the owner reads it —
 * printed coordinates in order — never from the gesture's own bookkeeping.
 */
const positions: [number, number][] = [
  [126.978, 37.566],
  [126.9785, 37.5665],
  [126.979, 37.567],
  [126.982, 37.569],
];
const seed: CourseWaypoint[] = positions.map((position, index) => ({
  role: index === 0 ? 'start' : index === positions.length - 1 ? 'finish' : 'via',
  position,
  name: null,
  sourceSampleId: null,
  locked: false,
}));
const printed = ([longitude, latitude]: [number, number]) =>
  `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const [A, B, C, D] = positions.map(printed);

function renderList() {
  return render(
    <CourseDraftProvider courseId="course-1" headRevision={1} waypoints={seed}>
      <WaypointListEditor pickedPosition={null} computing={false} />
    </CourseDraftProvider>,
  );
}

const list = () => screen.getByRole('list', { name: '경유점 목록' });
const order = () =>
  within(list())
    .getAllByRole('listitem')
    .map((item) => item.querySelector('[class*="coordinate"]')?.textContent ?? '');
const labels = () =>
  within(list())
    .getAllByRole('listitem')
    .map((item) => item.querySelector('span')?.textContent ?? '');
const revision = () =>
  Number(/(\d+)/.exec(screen.getByTestId('draft-revision').textContent ?? '')?.[1]);
const announcement = () => screen.getByTestId('waypoint-move-announcement');
const handle = (ordinal: number) =>
  screen.getByRole('button', { name: `${ordinal}번 끌어 옮기기` });

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
});

describe('waypoint list drag (keyboard)', () => {
  it('picks up, moves and drops with announcements, as one undoable change', async () => {
    const user = userEvent.setup();
    renderList();
    const before = revision();
    handle(3).focus();
    await user.keyboard(' ');
    expect(handle(3)).toHaveAttribute('aria-pressed', 'true');
    expect(announcement()).toHaveTextContent('3번 경유점을 들었습니다.');
    expect(announcement()).toHaveAttribute('aria-live', 'polite');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(announcement()).toHaveTextContent('3번 경유점을 1번 위치에 놓으려 합니다. 전체 4개.');
    // Carrying is not editing: the rows and the draft stay put until the drop.
    expect(order()).toEqual([A, B, C, D]);
    expect(revision()).toBe(before);
    await user.keyboard('{Enter}');
    expect(order()).toEqual([C, A, B, D]);
    expect(labels()).toEqual(['1. 시작', '2. 경유', '3. 경유', '4. 끝']);
    expect(revision()).toBe(before + 1);
    // The announcement is what the draft did, read back from it.
    expect(announcement()).toHaveTextContent(
      '3번 경유점을 1번 위치로 옮겼습니다. 이제 시작입니다. 전체 4개.',
    );
    // Focus follows the waypoint that moved.
    expect(handle(1)).toHaveFocus();
    expect(handle(1)).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(order()).toEqual([A, B, C, D]);
    await user.click(screen.getByRole('button', { name: '다시 실행' }));
    expect(order()).toEqual([C, A, B, D]);
  });

  it('cancels with Escape or by leaving the handle, and changes nothing', async () => {
    const user = userEvent.setup();
    renderList();
    const before = revision();
    handle(2).focus();
    await user.keyboard(' {ArrowDown}{ArrowDown}{Escape}');
    expect(announcement()).toHaveTextContent('옮기기를 취소했습니다. 2번 경유점은 그대로입니다.');
    expect(handle(2)).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('{ArrowDown}');
    expect(order()).toEqual([A, B, C, D]);
    await user.keyboard(' {End}');
    await user.tab();
    expect(announcement()).toHaveTextContent('옮기기를 취소했습니다.');
    expect(order()).toEqual([A, B, C, D]);
    expect(revision()).toBe(before);
  });

  it('does not take a key that belongs to an IME composition', async () => {
    const user = userEvent.setup();
    renderList();
    handle(4).focus();
    await user.keyboard(' ');
    const composing = fireEvent.keyDown(handle(4), { key: 'ArrowUp', isComposing: true });
    const process = fireEvent.keyDown(handle(4), { key: 'Process', keyCode: 229 });
    const escape = fireEvent.keyDown(handle(4), { key: 'Escape', isComposing: true });
    // Not prevented, and the carry did not move or end.
    expect(composing).toBe(true);
    expect(process).toBe(true);
    expect(escape).toBe(true);
    expect(announcement()).toHaveTextContent('4번 경유점을 들었습니다.');
    expect(handle(4)).toHaveAttribute('aria-pressed', 'true');
    // Typing a name with an IME in the row's own field is never intercepted either.
    const name = screen.getByLabelText('4번 경유점 이름');
    expect(fireEvent.keyDown(name, { key: 'ArrowUp', isComposing: true })).toBe(true);
  });

  it('refuses a drop that carries a waypoint over a locked one, and says so', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: '2번 잠그기' }));
    const before = revision();
    handle(3).focus();
    await user.keyboard(' {ArrowUp}{ArrowUp} ');
    expect(order()).toEqual([A, B, C, D]);
    expect(revision()).toBe(before);
    expect(screen.getByRole('alert')).toHaveTextContent('잠긴 경유점입니다.');
    expect(announcement()).toHaveTextContent(
      '잠긴 경유점이 있어 옮기지 않았습니다. 3번 경유점은 그대로 3번입니다.',
    );
    // The locked waypoint itself cannot be carried anywhere either.
    handle(2).focus();
    await user.keyboard(' {End} ');
    expect(order()).toEqual([A, B, C, D]);
    // Past no lock, the same gesture works.
    handle(3).focus();
    await user.keyboard(' {ArrowDown} ');
    expect(order()).toEqual([A, B, D, C]);
  });
});

describe('waypoint list drag (pointer)', () => {
  beforeEach(() => {
    // jsdom lays nothing out: each row is given a 100px band, row n at n*100.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = this.parentElement ? Array.from(this.parentElement.children) : [];
      const top = this.tagName === 'LI' ? rows.indexOf(this) * 100 : 0;
      return {
        top,
        bottom: top + 80,
        height: 80,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  const drag = (from: number, clientY: number) => {
    const grabbed = handle(from);
    act(() => {
      fireEvent.pointerDown(grabbed, { button: 0, pointerId: 1, clientY: (from - 1) * 100 + 40 });
    });
    act(() => {
      fireEvent.pointerMove(grabbed, { pointerId: 1, clientY });
    });
    act(() => {
      fireEvent.pointerUp(grabbed, { pointerId: 1, clientY });
    });
  };

  it('drops where the pointer is, through the same draft change as the buttons', async () => {
    const user = userEvent.setup();
    renderList();
    const before = revision();
    drag(3, 10);
    expect(order()).toEqual([C, A, B, D]);
    expect(revision()).toBe(before + 1);
    expect(announcement()).toHaveTextContent('3번 경유점을 1번 위치로 옮겼습니다.');
    await user.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(order()).toEqual([A, B, C, D]);

    // The buttons reach the same draft.
    await user.click(screen.getByRole('button', { name: '3번 앞으로' }));
    await user.click(screen.getByRole('button', { name: '2번 앞으로' }));
    expect(order()).toEqual([C, A, B, D]);
  });

  it('marks where it would land while carried, and refuses a locked path', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: '3번 잠그기' }));
    const grabbed = handle(1);
    act(() => {
      fireEvent.pointerDown(grabbed, { button: 0, pointerId: 1, clientY: 40 });
    });
    act(() => {
      fireEvent.pointerMove(grabbed, { pointerId: 1, clientY: 390 });
    });
    const items = within(list()).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('data-carried', 'true');
    expect(items[3]).toHaveAttribute('data-drop', 'after');
    expect(order()).toEqual([A, B, C, D]);
    act(() => {
      fireEvent.pointerUp(grabbed, { pointerId: 1, clientY: 390 });
    });
    expect(order()).toEqual([A, B, C, D]);
    expect(screen.getByRole('alert')).toHaveTextContent('잠긴 경유점입니다.');
    expect(within(list()).getAllByRole('listitem')[0]).not.toHaveAttribute('data-carried');
  });

  it('N1: only the pointer that picked a waypoint up moves, drops or cancels it', () => {
    renderList();
    const grabbed = handle(3);
    act(() => {
      fireEvent.pointerDown(grabbed, { button: 0, pointerId: 1, clientY: 240 });
    });
    // A second pointer on the same handle: moves, lifts and cancels are all ignored.
    act(() => {
      fireEvent.pointerMove(grabbed, { pointerId: 2, clientY: 10 });
    });
    expect(within(list()).getAllByRole('listitem')[0]).not.toHaveAttribute('data-drop');
    act(() => {
      fireEvent.pointerUp(grabbed, { pointerId: 2, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerCancel(grabbed, { pointerId: 2 });
    });
    expect(order()).toEqual([A, B, C, D]);
    expect(handle(3)).toHaveAttribute('aria-pressed', 'true');
    // The first pointer still carries it and drops it where it is.
    act(() => {
      fireEvent.pointerMove(grabbed, { pointerId: 1, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerUp(grabbed, { pointerId: 1, clientY: 10 });
    });
    expect(order()).toEqual([C, A, B, D]);
  });
});

describe('waypoint list drag (review r1)', () => {
  it('B1: a refused keyboard drop does not later steal focus from a name field', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: '2번 잠그기' }));
    handle(3).focus();
    await user.keyboard(' {ArrowUp}{ArrowUp} ');
    expect(order()).toEqual([A, B, C, D]);
    const name = screen.getByLabelText('1번 경유점 이름');
    await user.click(name);
    await user.keyboard('ab');
    // Every keystroke is a draft change; none of them may move focus to the handle.
    expect(name).toHaveFocus();
    expect(name).toHaveValue('ab');
  });

  it('B1: an in-place keyboard drop does not later steal focus from a name field', async () => {
    const user = userEvent.setup();
    renderList();
    handle(2).focus();
    await user.keyboard('  ');
    expect(announcement()).toHaveTextContent(
      '2번 경유점을 제자리에 놓았습니다. 순서는 그대로입니다.',
    );
    const name = screen.getByLabelText('4번 경유점 이름');
    await user.click(name);
    await user.keyboard('ab');
    expect(name).toHaveFocus();
    expect(name).toHaveValue('ab');
    // A drop that did move still keeps focus with the moved waypoint.
    handle(4).focus();
    await user.keyboard(' {ArrowUp} ');
    expect(handle(3)).toHaveFocus();
  });

  it('N2: a drop in place after a lock refusal says "in place", not the old refusal', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: '2번 잠그기' }));
    handle(3).focus();
    await user.keyboard(' {ArrowUp} ');
    expect(announcement()).toHaveTextContent('잠긴 경유점이 있어 옮기지 않았습니다.');
    // The draft still remembers that refusal; this drop asked for nothing.
    expect(screen.getByRole('alert')).toHaveTextContent('잠긴 경유점입니다.');
    handle(4).focus();
    await user.keyboard('  ');
    expect(announcement()).toHaveTextContent(
      '4번 경유점을 제자리에 놓았습니다. 순서는 그대로입니다.',
    );
    expect(announcement()).not.toHaveTextContent('잠긴');
  });

  it('N2: a refusal other than a lock is said with its own reason, not as "in place"', async () => {
    const user = userEvent.setup();
    const captured: { store: CourseDraftStore | null } = { store: null };
    function Capture() {
      captured.store = useCourseDraftStore();
      return null;
    }
    render(
      <CourseDraftProvider courseId="course-1" headRevision={1} waypoints={seed}>
        <Capture />
        <WaypointListEditor pickedPosition={null} computing={false} />
      </CourseDraftProvider>,
    );
    const store = captured.store;
    if (!store) throw new Error('no store');
    act(() => {
      store.setState({ revision: courseLimits.maxDraftRevision });
    });
    handle(3).focus();
    await user.keyboard(' {ArrowUp} ');
    expect(order()).toEqual([A, B, C, D]);
    expect(announcement()).toHaveTextContent(
      '옮기지 않았습니다. 이 편집 세션의 변경 횟수 상한에 도달했습니다. 3번 경유점은 그대로 3번입니다.',
    );
    expect(announcement()).not.toHaveTextContent('제자리');
  });

  it('N5: says nothing about dragging while there is nothing to drag', () => {
    render(
      <CourseDraftProvider courseId="course-new" headRevision={0} waypoints={[]}>
        <WaypointListEditor pickedPosition={null} computing={false} />
      </CourseDraftProvider>,
    );
    expect(screen.queryByText(/끌어 옮기기:/)).toBeNull();
    // The live region stays, so the first announcement is not lost to a region appearing.
    expect(announcement()).toHaveAttribute('aria-live', 'polite');
  });
});
