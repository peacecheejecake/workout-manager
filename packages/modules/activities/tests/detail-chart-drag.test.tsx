import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import type { ActivityLap } from '@workout/contracts/activity-details';
import { DetailChart, touchHoldMs } from '../src/detail-chart';
import { lapOverlapsRange } from '../src/detail-projection';
import { createDetailSelectionStore, type DetailSelectionStore } from '../src/detail-selection';
import {
  buildHighlightPath,
  highlightContentKey,
  type StoredTrackGeometry,
} from '../src/stored-track-geometry';
import { instant, storedDetails } from './stored-track-fixtures';

/**
 * M2-01k-n review B1/N2/N3/N4: how a press becomes a range drag (03_design_system: mouse
 * 6–8 px, touch/pen a 200 ms hold within 8 px, never during a scroll), that a cancelled drag
 * puts the previous selection back, and the lap boundary and highlight revision rules.
 */
const records = storedDetails().records;

function Harness({ store }: { store: DetailSelectionStore }) {
  const range = useStore(store, (state) => state.range);
  const recordIndex = useStore(store, (state) => state.recordIndex);
  return (
    <DetailChart
      records={records}
      metric="distanceMeters"
      selected={recordIndex}
      range={range}
      onSelect={(index, time) => store.getState().selectRecord(index, time)}
      onSelectRange={(next) => store.getState().selectRange(next)}
      onRangeDragStart={() => store.getState().beginRangeDrag()}
      onRangeDragEnd={(outcome) =>
        outcome === 'cancel' ? store.getState().cancelRangeDrag() : store.getState().endRangeDrag()
      }
    />
  );
}

function setup() {
  const store = createDetailSelectionStore();
  // Something is already selected: observation 1.
  store.getState().selectRecord(1, instant(10));
  const { container, unmount } = render(<Harness store={store} />);
  const svg = screen.getByRole('img', { name: '원본 거리 (m) 차트' });
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 700, height: 190, right: 700, bottom: 190 }) as DOMRect;
  const xOf = (index: number) =>
    Number(
      within(container)
        .getByRole('button', { name: `차트 관측 ${index} 선택` })
        .getAttribute('cx'),
    );
  const yOf = (index: number) =>
    Number(
      within(container)
        .getByRole('button', { name: `차트 관측 ${index} 선택` })
        .getAttribute('cy'),
    );
  const before = () => {
    const { recordIndex, lapIndex, range, sample } = store.getState();
    return { recordIndex, lapIndex, range, sample };
  };
  return { store, svg, xOf, yOf, before: before(), now: before, unmount };
}

const down = (svg: Element, clientX: number, pointerType: string, clientY = 50) =>
  fireEvent.pointerDown(svg, {
    clientX,
    clientY,
    pointerId: 3,
    pointerType,
    isPrimary: true,
    button: 0,
  });
/** A move with the primary button held (touch ignores `buttons`). */
const move = (svg: Element, clientX: number, clientY = 50) =>
  fireEvent.pointerMove(svg, { clientX, clientY, pointerId: 3, buttons: 1 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mouse range drag', () => {
  it('activates only after 6 px of travel', () => {
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(3), 'mouse');
    move(svg, xOf(3) + 5);
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
    move(svg, xOf(4));
    fireEvent.pointerUp(svg, { clientX: xOf(4), pointerId: 3 });
    expect(store.getState().range).toEqual({ start: instant(30), end: instant(40) });
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('restores the selection saved at the press on pointercancel', () => {
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(2), 'mouse');
    move(svg, xOf(4));
    fireEvent.pointerUp(svg, { clientX: xOf(4), pointerId: 99 }); // another pointer: ignored
    expect(store.getState().rangeDragOrigin).not.toBeNull();
    fireEvent.pointerCancel(svg, { pointerId: 3 });
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('restores the selection on Escape, and the release after it changes nothing', () => {
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(2), 'mouse');
    move(svg, xOf(4));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(now()).toEqual(before);
    move(svg, xOf(3));
    fireEvent.pointerUp(svg, { clientX: xOf(3), pointerId: 3 });
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('writes the store at most once per frame and flushes on release', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { store, svg, xOf } = setup();
    const writes = vi.fn();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.range !== previous.range) writes(state.range);
    });
    down(svg, xOf(1), 'mouse');
    for (const index of [2, 3, 4]) move(svg, xOf(index));
    // Three moves in one frame: nothing written until the frame runs.
    expect(frames).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
    act(() => frames[0]?.(0));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenLastCalledWith({ start: instant(10), end: instant(40) });
    move(svg, xOf(3));
    fireEvent.pointerUp(svg, { clientX: xOf(3), pointerId: 3 });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(store.getState().range).toEqual({ start: instant(10), end: instant(30) });
    unsubscribe();
  });
});

describe('touch and pen range drag', () => {
  it('never selects on a swipe that scrolls, however long it lasts', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(1), 'touch', 50);
    act(() => void vi.advanceTimersByTime(60));
    // A diagonal swipe: 12 px across and down within the first 100 ms.
    move(svg, xOf(1) + 8, 58);
    act(() => void vi.advanceTimersByTime(touchHoldMs * 2));
    move(svg, xOf(4), 120);
    fireEvent.pointerUp(svg, { clientX: xOf(4), pointerId: 3 });
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('does not select a horizontal swipe that starts before the hold', () => {
    vi.useFakeTimers();
    const { svg, xOf, before, now } = setup();
    down(svg, xOf(1), 'pen');
    act(() => void vi.advanceTimersByTime(touchHoldMs - 20));
    move(svg, xOf(3));
    act(() => void vi.advanceTimersByTime(touchHoldMs));
    move(svg, xOf(4));
    fireEvent.pointerUp(svg, { clientX: xOf(4), pointerId: 3 });
    expect(now()).toEqual(before);
  });

  it('selects after a 200 ms hold within 8 px, then a drag', () => {
    vi.useFakeTimers();
    const { store, svg, xOf } = setup();
    down(svg, xOf(1), 'touch');
    move(svg, xOf(1) + 4, 53); // finger jitter inside the slop
    act(() => void vi.advanceTimersByTime(touchHoldMs - 1));
    expect(store.getState().rangeDragOrigin).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(store.getState().rangeDragOrigin).not.toBeNull();
    move(svg, xOf(3));
    fireEvent.pointerUp(svg, { clientX: xOf(3), pointerId: 3 });
    expect(store.getState().range).toEqual({ start: instant(10), end: instant(30) });
    expect(store.getState().recordIndex).toBeNull();
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('restores the selection when the browser cancels a held touch drag', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(1), 'touch');
    act(() => void vi.advanceTimersByTime(touchHoldMs));
    move(svg, xOf(4));
    act(() => void vi.advanceTimersByTime(20)); // the coalescing frame
    expect(store.getState().range).toEqual({ start: instant(10), end: instant(40) });
    fireEvent.pointerCancel(svg, { pointerId: 3 });
    expect(now()).toEqual(before);
  });
});

describe('review round 3: slow tap, Escape during the hold, unmount mid-drag', () => {
  it('a hold of 200 ms or more released without moving selects the tapped observation', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, yOf } = setup();
    down(svg, xOf(3), 'touch', yOf(3));
    act(() => void vi.advanceTimersByTime(250));
    // Armed by the hold, but no range drawn yet.
    expect(store.getState().rangeDragOrigin).not.toBeNull();
    fireEvent.pointerUp(svg, { clientX: xOf(3), clientY: yOf(3), pointerId: 3 });
    const state = store.getState();
    expect(state.recordIndex).toBe(3);
    expect(state.range).toEqual({ start: instant(30), end: instant(30) });
    expect(state.rangeDragOrigin).toBeNull();
  });

  it('a slow tap with finger jitter inside 8 px is still a tap, never a zero-length range', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, yOf } = setup();
    const writes: unknown[] = [];
    store.subscribe((next, previous) => {
      if (next.range !== previous.range) writes.push(next.range);
    });
    down(svg, xOf(3), 'touch', yOf(3));
    act(() => void vi.advanceTimersByTime(250));
    move(svg, xOf(3) + 3, yOf(3) + 2);
    act(() => void vi.advanceTimersByTime(20));
    // The hold and the jitter wrote nothing: no zero-length range ever reached the store.
    expect(writes).toEqual([]);
    fireEvent.pointerUp(svg, { clientX: xOf(3) + 3, clientY: yOf(3) + 2, pointerId: 3 });
    expect(store.getState().recordIndex).toBe(3);
    expect(writes.at(-1)).toEqual({ start: instant(30), end: instant(30) });
  });

  it('Escape during the touch hold abandons the press before it arms', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(1), 'touch');
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => void vi.advanceTimersByTime(touchHoldMs * 2));
    expect(store.getState().rangeDragOrigin).toBeNull();
    move(svg, xOf(4));
    fireEvent.pointerUp(svg, { clientX: xOf(4), pointerId: 3 });
    expect(now()).toEqual(before);
  });

  it('unmounting mid-drag cancels it and restores the saved selection', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now, unmount } = setup();
    down(svg, xOf(1), 'mouse');
    move(svg, xOf(4));
    act(() => void vi.advanceTimersByTime(20)); // the coalescing frame writes the partial range
    expect(store.getState().range).toEqual({ start: instant(10), end: instant(40) });
    expect(store.getState().rangeDragOrigin).not.toBeNull();
    unmount();
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });
});

describe('review round 4: lost releases, background taps, dragging back', () => {
  it('a mouse move with no button held ends a press whose release was lost (B4)', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(2), 'mouse');
    // The pointer leaves the chart and is released outside; nothing reports the release.
    // Coming back, it hovers with no button held.
    for (const index of [3, 4, 1])
      fireEvent.pointerMove(svg, { clientX: xOf(index), clientY: 50, pointerId: 3, buttons: 0 });
    act(() => void vi.advanceTimersByTime(50));
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('a release anywhere on the window ends the press (B4)', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, before, now } = setup();
    down(svg, xOf(2), 'mouse');
    fireEvent.pointerUp(window, { clientX: 900, clientY: 900, pointerId: 3 });
    // Even a later move reported with the button held (a new press elsewhere, say) is no
    // longer this press.
    move(svg, xOf(4));
    act(() => void vi.advanceTimersByTime(50));
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('a slow tap on the empty chart, far from any point, selects nothing', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, yOf, before, now } = setup();
    const far = yOf(3) + 60;
    down(svg, xOf(3), 'touch', far);
    act(() => void vi.advanceTimersByTime(250));
    fireEvent.pointerUp(svg, { clientX: xOf(3), clientY: far, pointerId: 3 });
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });

  it('dragging away and back onto the first observation leaves the old selection', () => {
    vi.useFakeTimers();
    const { store, svg, xOf, yOf, before, now } = setup();
    down(svg, xOf(1), 'mouse', yOf(1));
    move(svg, xOf(3), yOf(1));
    act(() => void vi.advanceTimersByTime(20));
    expect(store.getState().range).toEqual({ start: instant(10), end: instant(30) });
    move(svg, xOf(1) + 30, yOf(1));
    fireEvent.pointerUp(svg, { clientX: xOf(1) + 30, clientY: yOf(1), pointerId: 3 });
    // Never a committed zero-length range with no observation selected.
    expect(now()).toEqual(before);
    expect(store.getState().rangeDragOrigin).toBeNull();
  });
});

describe('lap boundary rule (N3): inclusive at both ends', () => {
  const lap = (index: number, from: number, seconds: number): ActivityLap => ({
    index,
    startedAt: new Date(instant(from)).toISOString(),
    recordedAt: new Date(instant(from + seconds)).toISOString(),
    elapsedSeconds: seconds,
    timerSeconds: seconds,
    distanceMeters: null,
    averageHeartRateBpm: null,
    maximumHeartRateBpm: null,
  });
  // Lap 1 starts at the instant lap 0 ends: the record at 30 s ends one and starts the next.
  const laps = [lap(0, 0, 30), lap(1, 30, 30)];
  const overlapping = (start: number, end: number) =>
    laps
      .filter((item) => lapOverlapsRange(item, { start: instant(start), end: instant(end) }))
      .map((item) => item.index);
  it('a range ending on the shared boundary instant marks both laps', () => {
    expect(overlapping(10, 30)).toEqual([0, 1]);
    expect(overlapping(30, 30)).toEqual([0, 1]);
  });
  it('a range strictly inside one lap marks only that lap', () => {
    expect(overlapping(31, 40)).toEqual([1]);
    expect(overlapping(0, 29)).toEqual([0]);
  });
});

describe('highlight revision (N2)', () => {
  it('differs for the same ends and length but another middle, or other breaks', () => {
    const base = highlightContentKey(['0:1', '0:2', '0:5'], [2]);
    expect(highlightContentKey(['0:1', '0:3', '0:5'], [2])).not.toBe(base);
    expect(highlightContentKey(['0:1', '0:2', '0:5'], [1])).not.toBe(base);
    expect(highlightContentKey(['0:1', '0:2', '0:5'], [])).not.toBe(base);
    expect(highlightContentKey(['0:1', '0:2', '0:5'], [2])).toBe(base);
    // Key boundaries count: ['0:1','0'] is not ['0:10'].
    expect(highlightContentKey(['0:1', '0'], [])).not.toBe(highlightContentKey(['0:10'], []));
  });

  it('buildHighlightPath gives highlights with the same ends and length different revisions', () => {
    const keys = ['0:0', '0:1', '0:2', '0:3', '0:4'];
    const geometry: StoredTrackGeometry = {
      path: {
        id: 'track',
        role: 'recorded',
        revision: 'rev',
        positions: keys.map((_, index) => [127 + index / 1000, 37.5] as const),
        breaks: [],
        vertexKeys: keys,
      },
      vertexSampleIds: keys,
      vertexIndexBySampleId: new Map(keys.map((key, index) => [key, index])),
      insufficient: [],
    };
    const left = buildHighlightPath(geometry, ['0:0', '0:1', '0:3'], 'range');
    const right = buildHighlightPath(geometry, ['0:0', '0:2', '0:3'], 'range');
    expect(left?.vertexKeys).toEqual(['0:0', '0:1', '0:3']);
    expect(right?.vertexKeys).toEqual(['0:0', '0:2', '0:3']);
    expect(left?.revision).not.toBe(right?.revision);
    expect(buildHighlightPath(geometry, ['0:0', '0:1', '0:3'], 'range')?.revision).toBe(
      left?.revision,
    );
  });
});
