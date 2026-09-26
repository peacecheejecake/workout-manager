import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ActivityRecord } from '@workout/contracts/activity-details';
import {
  chartSegments,
  nearestChartPoint,
  recordInRange,
  type ChartPoint,
  type TimeRange,
} from './detail-projection';
import styles from './activity-workbench.module.css';

/**
 * Drag activation (03_design_system §drag): a mouse press becomes a range drag after 6 px of
 * horizontal travel; a touch or pen press only after a 200 ms hold that stays within 8 px, so a
 * swipe that scrolls the page never starts a selection ("scroll 중 강제 활성화 금지").
 */
export const mouseDragThresholdPx = 6;
export const touchHoldMs = 200;
export const touchHoldSlopPx = 8;
/**
 * A slow tap selects the observation only when it landed on or near that observation's
 * drawn point (a 44 px target, WCAG 2.5.5); a tap on the empty chart selects nothing.
 */
export const tapHitRadiusPx = 22;
const plotLeft = 35;
const plotWidth = 630;
const viewWidth = 700;

interface DragState {
  readonly pointerId: number;
  readonly touchLike: boolean;
  readonly originX: number;
  readonly originY: number;
  readonly anchor: ChartPoint;
  /** Armed: the press is a range drag and the selection at arming time is saved. */
  dragging: boolean;
  last: TimeRange | null;
  /** Latest pointer x not yet turned into a range (moves are coalesced per frame). */
  pendingX: number | null;
  frame: number | null;
  hold: ReturnType<typeof setTimeout> | null;
  target: SVGSVGElement;
}

export interface DetailChartProps {
  records: ActivityRecord[];
  metric: 'distanceMeters' | 'heartRateBpm';
  selected: number | null;
  range: TimeRange | null;
  /** Visible time domain. Independent of a selected range. */
  domain?: TimeRange | null;
  onSelect(index: number, time: number): void;
  /**
   * A time range chosen on the chart: by dragging across it, or by Shift+click on a point
   * after a first one. Both ends snap to observations drawn on this chart, so the range is
   * always "from this observation to that one" and never an instant between two of them.
   * The range is client selection state only; the owner puts it in the selection store.
   */
  onSelectRange?(range: TimeRange): void;
  /**
   * A press became a range drag (before its first range). The owner saves the selection it
   * had, so that `onRangeDragEnd('cancel')` — pointercancel, or Escape — can put it back.
   */
  onRangeDragStart?(): void;
  onRangeDragEnd?(outcome: 'commit' | 'cancel'): void;
}

export function DetailChart({
  records,
  metric,
  selected,
  range,
  domain,
  onSelect,
  onSelectRange,
  onRangeDragStart,
  onRangeDragEnd,
}: DetailChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragState | null>(null);
  /** Window listeners of the current press: Escape, and a release or cancel anywhere. */
  const detachWindow = useRef<(() => void) | null>(null);
  // The owner's latest end callback, for the unmount cleanup below.
  const latestEnd = useRef(onRangeDragEnd);
  useEffect(() => {
    latestEnd.current = onRangeDragEnd;
  }, [onRangeDragEnd]);
  // A drag must not outlive the chart: its timer, frame and key listener go with it, and an
  // armed drag is cancelled so the owner puts back the selection it replaced.
  useEffect(
    () => () => {
      const state = drag.current;
      if (state?.hold) clearTimeout(state.hold);
      if (state?.frame != null) cancelAnimationFrame(state.frame);
      detachWindow.current?.();
      detachWindow.current = null;
      drag.current = null;
      if (state?.dragging) latestEnd.current?.('cancel');
    },
    [],
  );
  const segments = chartSegments(
    domain ? records.filter((record) => recordInRange(record, domain)) : records,
    metric,
  );
  const points = segments.flat();
  const label = metric === 'distanceMeters' ? '원본 거리 (m)' : '원본 심박 (bpm)';
  if (!points.length) return <p>{label}: 표시할 시각·측정값이 없습니다.</p>;
  const times = points.map((point) => point.time);
  const values = points.map((point) => point.value);
  const minTime = Math.min(...times),
    maxTime = Math.max(...times);
  const maxValue = Math.max(1, ...values);
  const span = maxTime - minTime || 1;
  const x = (time: number) => plotLeft + ((time - minTime) / span) * plotWidth;
  const y = (value: number) => 155 - (value / maxValue) * 125;

  /** The observation drawn nearest to a pointer position, by time on the x axis. */
  function pointAtClientX(clientX: number): ChartPoint | null {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    // The SVG keeps its aspect ratio at 100% width, so the x scale is the width ratio.
    const viewX = ((clientX - box.left) / box.width) * viewWidth;
    return nearestChartPoint(points, minTime + ((viewX - plotLeft) / plotWidth) * span);
  }
  function emitRange(from: ChartPoint, to: ChartPoint, state: DragState | null) {
    if (!onSelectRange) return;
    const next = { start: Math.min(from.time, to.time), end: Math.max(from.time, to.time) };
    // A drag reports every pointer move; the store is written only when the range changes.
    if (state?.last && state.last.start === next.start && state.last.end === next.end) return;
    if (state) state.last = next;
    onSelectRange(next);
  }
  /** Turn the latest pending pointer x into a range now. */
  function flush(state: DragState) {
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    state.frame = null;
    const pending = state.pendingX;
    state.pendingX = null;
    if (pending === null) return;
    const point = pointAtClientX(pending);
    // A drag that has not left its first observation has no range yet: a zero-length range
    // would clear the observation selection and highlight nothing.
    if (!point || (state.last === null && point.time === state.anchor.time)) return;
    emitRange(state.anchor, point, state);
  }
  /**
   * At most one store write per frame: a long track redraws the map highlight on every
   * range change, and a pointer can report several moves per frame.
   */
  function schedule(state: DragState, clientX: number) {
    state.pendingX = clientX;
    if (state.frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      flush(state);
      return;
    }
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      if (drag.current === state) flush(state);
    });
  }
  function arm(state: DragState) {
    state.dragging = true;
    // Captured only once it is a drag, so a plain press still clicks the point under it.
    try {
      state.target.setPointerCapture?.(state.pointerId);
    } catch {
      // The pointer may already be gone; the drag then ends with its own up/cancel.
    }
    onRangeDragStart?.();
  }
  function finish(state: DragState, outcome: 'commit' | 'cancel') {
    if (drag.current !== state) return;
    drag.current = null;
    if (state.hold) clearTimeout(state.hold);
    detachWindow.current?.();
    detachWindow.current = null;
    if (!state.dragging) {
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      return;
    }
    if (outcome === 'commit') flush(state);
    else if (state.frame !== null) cancelAnimationFrame(state.frame);
    try {
      state.target.releasePointerCapture?.(state.pointerId);
    } catch {
      // Already released.
    }
    onRangeDragEnd?.(outcome);
  }
  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onSelectRange || !event.isPrimary || event.button !== 0 || event.shiftKey) return;
    const anchor = pointAtClientX(event.clientX);
    if (!anchor) return;
    if (drag.current) finish(drag.current, 'cancel');
    const state: DragState = {
      pointerId: event.pointerId,
      touchLike: event.pointerType !== 'mouse',
      originX: event.clientX,
      originY: event.clientY,
      anchor,
      dragging: false,
      last: null,
      pendingX: null,
      frame: null,
      hold: null,
      target: event.currentTarget,
    };
    drag.current = state;
    // The press is watched on the window, not only on the chart: before the drag captures
    // the pointer, a release outside the chart never reaches it, and a press left alive
    // would let a later hover drag out a range with no button held.
    // Escape abandons the press from the start: during a touch hold it stops the drag from
    // arming, and during a drag it puts the saved selection back.
    const onKey = (next: KeyboardEvent) => {
      if (next.key === 'Escape') finish(state, 'cancel');
    };
    const onUp = (next: PointerEvent) => {
      if (next.pointerId === state.pointerId) release(state, next.clientX, next.clientY);
    };
    const onCancel = (next: PointerEvent) => {
      if (next.pointerId === state.pointerId) finish(state, 'cancel');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    detachWindow.current = () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    if (state.touchLike)
      state.hold = setTimeout(() => {
        state.hold = null;
        if (drag.current === state && !state.dragging) arm(state);
      }, touchHoldMs);
  }
  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    // Hover alone never selects anything: without a press there is no drag state.
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A mouse move with the primary button up means the release was lost (it happened
    // somewhere nothing reported it): the press is over, and this is a hover.
    if (!state.touchLike && (event.buttons & 1) === 0) {
      finish(state, 'cancel');
      return;
    }
    if (!state.dragging) {
      if (state.touchLike) {
        // Moving before the hold completes is a scroll or a swipe: give the press up.
        const moved = Math.hypot(event.clientX - state.originX, event.clientY - state.originY);
        if (moved > touchHoldSlopPx) finish(state, 'cancel');
        return;
      }
      if (Math.abs(event.clientX - state.originX) < mouseDragThresholdPx) return;
      arm(state);
    }
    schedule(state, event.clientX);
  }
  /** Whether a press landed on (within the hit radius of) the anchor's drawn point. */
  function pressedOnAnchor(state: DragState): boolean {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return false;
    // Uniform scale: the SVG keeps its aspect ratio at 100% width.
    const scale = box.width / viewWidth;
    const pointX = box.left + x(state.anchor.time) * scale;
    const pointY = box.top + y(state.anchor.value) * scale;
    return Math.hypot(state.originX - pointX, state.originY - pointY) <= tapHitRadiusPx;
  }
  /** The end of a press, from the chart itself or from the window. */
  function release(state: DragState, clientX: number, clientY: number) {
    if (drag.current !== state) return;
    if (!state.dragging) {
      // Never became a drag: a plain click, which the point's own click handler serves.
      finish(state, 'commit');
      return;
    }
    if (
      state.last === null &&
      Math.hypot(clientX - state.originX, clientY - state.originY) <= touchHoldSlopPx
    ) {
      // A slow tap: held long enough to arm, released where it was pressed, no range drawn.
      // It is a tap, not a range — put the selection back, and select the observation only
      // when the tap was on its point (the drag captured the pointer, so the point's own
      // click may not arrive). A tap on the empty chart selects nothing.
      const onPoint = pressedOnAnchor(state);
      finish(state, 'cancel');
      if (onPoint) onSelect(state.anchor.index, state.anchor.time);
      return;
    }
    const end = pointAtClientX(clientX);
    if (end === null || end.time === state.anchor.time) {
      // Dragged away and back onto the first observation: no range is left, so the drag
      // is abandoned and the selection it replaced comes back.
      finish(state, 'cancel');
      return;
    }
    state.pendingX = clientX;
    finish(state, 'commit');
  }
  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    release(state, event.clientX, event.clientY);
  }
  function onPointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    finish(state, 'cancel');
  }
  /** Shift+click extends from the chosen observation or the current range's start. */
  function extendTo(point: ChartPoint): boolean {
    if (!onSelectRange) return false;
    const anchorTime =
      points.find((candidate) => candidate.index === selected)?.time ?? range?.start ?? null;
    if (anchorTime === null) return false;
    emitRange({ index: -1, time: anchorTime, value: 0 }, point, null);
    return true;
  }
  function choose(point: ChartPoint, extend: boolean) {
    if (extend && extendTo(point)) return;
    onSelect(point.index, point.time);
  }

  const band =
    range !== null && range.start < range.end && range.end >= minTime && range.start <= maxTime
      ? { from: x(Math.max(range.start, minTime)), to: x(Math.min(range.end, maxTime)) }
      : null;
  return (
    <figure className={styles.figure}>
      <figcaption>
        {label} · 가로축 관측 시각 UTC · 세로축 {metric === 'distanceMeters' ? 'm' : 'bpm'}
      </figcaption>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewWidth} 190`}
        role="img"
        aria-label={`${label} 차트`}
        className={onSelectRange ? styles.rangeSurface : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {band ? (
          <rect
            className={styles.band}
            data-testid="chart-range-band"
            x={band.from}
            y={25}
            width={Math.max(1, band.to - band.from)}
            height={135}
            aria-hidden="true"
          />
        ) : null}
        <text x="2" y="25">
          {maxValue}
        </text>
        <text x="5" y="160">
          0
        </text>
        {segments.map((segment, index) => (
          <polyline
            key={index}
            fill="none"
            className={styles.line}
            points={segment.map((point) => `${x(point.time)},${y(point.value)}`).join(' ')}
          />
        ))}
        {points.map((point) => (
          <circle
            key={point.index}
            cx={x(point.time)}
            cy={y(point.value)}
            r={selected === point.index ? 6 : 3}
            className={styles.point}
            data-selected={selected === point.index}
            data-in-range={
              range !== null &&
              recordInRange(
                {
                  index: point.index,
                  timestamp: new Date(point.time).toISOString(),
                  distanceMeters: null,
                  heartRateBpm: null,
                },
                range,
              )
            }
            role="button"
            tabIndex={-1}
            aria-label={`차트 관측 ${point.index} 선택`}
            onClick={(event) => choose(point, event.shiftKey)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose(point, event.shiftKey);
              }
            }}
          >
            <title>
              관측 {point.index} · {new Date(point.time).toISOString()} · {point.value}
            </title>
          </circle>
        ))}
        <text x="35" y="185">
          {new Date(minTime).toISOString()}
        </text>
      </svg>
      <p>
        종료 시각 {new Date(maxTime).toISOString()}. 정확한 값과 키보드 선택은 관측 표·선택 버튼을
        사용하세요.
        {onSelectRange
          ? ' 차트를 가로로 끌거나(터치는 0.2초 누른 뒤 끌기) 한 관측을 고른 뒤 Shift+클릭하면 두 관측 사이 구간을 고릅니다. Esc는 끌던 구간을 취소합니다. 키보드로는 구간 탭의 "관측 구간 선택" UTC 입력으로 같은 구간을 고를 수 있습니다.'
          : null}
      </p>
    </figure>
  );
}
