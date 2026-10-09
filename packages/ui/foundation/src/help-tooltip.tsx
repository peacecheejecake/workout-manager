import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { Button } from './button';
import styles from './help-tooltip.module.css';

export interface HelpTooltipProps {
  label: string;
  description: string;
  interaction: 'available' | 'dragging';
}
type Point = { x: number; y: number };
type Corridor = { from: Point; edgeA: Point; edgeB: Point; target: DOMRect; distance: number };
type PositionStyle = CSSProperties & { '--help-x': string; '--help-y': string };
const capability = () =>
  typeof HTMLElement !== 'undefined' &&
  typeof HTMLElement.prototype.showPopover === 'function' &&
  typeof HTMLElement.prototype.hidePopover === 'function';
const subscribeCapability = () => () => {};
// Instance-scoped external browser capability. An imperative native failure
// updates subscribers through useSyncExternalStore; it is never shared across SSR requests.
function createPopoverStatus() {
  let healthy = true;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => healthy,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    failed() {
      healthy = false;
      for (const listener of listeners) listener();
    },
  };
}
function distance(point: Point, box: DOMRect) {
  return Math.hypot(
    Math.max(box.left - point.x, 0, point.x - box.right),
    Math.max(box.top - point.y, 0, point.y - box.bottom),
  );
}
function inTriangle(point: Point, a: Point, b: Point, c: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const values = [cross(point, a, b), cross(point, b, c), cross(point, c, a)];
  return !(values.some((value) => value < 0) && values.some((value) => value > 0));
}

/** Descriptive text only. Inline fallback is not proof of a native overlay. */
export function HelpTooltip({ label, description, interaction }: HelpTooltipProps) {
  const id = useId();
  const descriptionId = `help-description-${id}`;
  const nativeCapability = useSyncExternalStore(subscribeCapability, capability, () => false);
  const [popoverStatus] = useState(createPopoverStatus);
  const healthy = useSyncExternalStore(popoverStatus.subscribe, popoverStatus.snapshot, () => true);
  const [open, setOpen] = useState(false);
  const [previousInteraction, setPreviousInteraction] = useState(interaction);
  if (previousInteraction !== interaction) {
    setPreviousInteraction(interaction);
    if (interaction === 'dragging') setOpen(false);
  }
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const native = nativeCapability && healthy;
  const visible = native && open && interaction === 'available';
  const trigger = useRef<HTMLButtonElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const corridor = useRef<Corridor | null>(null);
  const focused = useRef(false);
  const hovered = useRef(false);
  const dismissed = useRef(false);
  const touchClick = useRef(false);
  const pinned = useRef(false);
  function clearTimers() {
    if (opening.current !== null) clearTimeout(opening.current);
    if (closing.current !== null) clearTimeout(closing.current);
    opening.current = null;
    closing.current = null;
    corridor.current = null;
  }
  function dismiss() {
    clearTimers();
    dismissed.current = true;
    setOpen(false);
  }
  function reveal() {
    clearTimers();
    if (native && interaction === 'available' && !dismissed.current) setOpen(true);
  }
  function leave(point?: Point) {
    if (opening.current !== null) clearTimeout(opening.current);
    opening.current = null;
    if (focused.current || !native) return;
    if (point && visible && tooltip.current) {
      const box = tooltip.current.getBoundingClientRect();
      const y = point.y <= box.top ? box.top : box.bottom;
      if (
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        box.width > 0 &&
        box.height > 0 &&
        distance(point, box) <= 16
      ) {
        corridor.current = {
          from: point,
          edgeA: { x: box.left, y },
          edgeB: { x: box.right, y },
          target: box,
          distance: distance(point, box),
        };
      }
    }
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      closing.current = null;
      corridor.current = null;
      if (!focused.current && !hovered.current) setOpen(false);
    }, 100);
  }
  useEffect(() => {
    if (interaction === 'dragging') {
      if (opening.current !== null) clearTimeout(opening.current);
      if (closing.current !== null) clearTimeout(closing.current);
      opening.current = null;
      closing.current = null;
      corridor.current = null;
      dismissed.current = true;
      pinned.current = false;
    }
  }, [interaction]);
  useEffect(() => {
    const element = tooltip.current;
    if (!native || !element) return;
    if (!visible) {
      if (element.matches(':popover-open')) element.hidePopover();
      return;
    }
    try {
      element.showPopover();
    } catch {
      popoverStatus.failed();
      return;
    }
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      if (!anchor) return;
      const maxX = Math.max(8, window.innerWidth - box.width - 8);
      const below = anchor.bottom + 6;
      const y = below + box.height <= window.innerHeight - 8 ? below : anchor.top - box.height - 6;
      setPosition({
        x: Math.min(maxX, Math.max(8, anchor.left)),
        y: Math.max(8, Math.min(y, Math.max(8, window.innerHeight - box.height - 8))),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const move = (event: PointerEvent) => {
      const active = corridor.current;
      if (!active) return;
      const point = { x: event.clientX, y: event.clientY };
      const currentDistance = distance(point, active.target);
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !inTriangle(point, active.from, active.edgeA, active.edgeB) ||
        currentDistance > active.distance + 1
      ) {
        if (closing.current !== null) clearTimeout(closing.current);
        closing.current = null;
        corridor.current = null;
        setOpen(false);
      } else active.distance = currentDistance;
    };
    document.addEventListener('pointermove', move);

    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointermove', move);

      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [native, visible, description, label, popoverStatus]);
  useEffect(() => {
    if (!native) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (opening.current !== null) clearTimeout(opening.current);
      if (closing.current !== null) clearTimeout(closing.current);
      opening.current = null;
      closing.current = null;
      corridor.current = null;
      dismissed.current = true;
      pinned.current = false;
      setOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [native]);
  useEffect(
    () => () => {
      if (opening.current !== null) clearTimeout(opening.current);
      if (closing.current !== null) clearTimeout(closing.current);
    },
    [],
  );
  const positionStyle: PositionStyle = {
    '--help-x': `${position.x}px`,
    '--help-y': `${position.y}px`,
  };
  return (
    <span className={styles.root} data-presentation={native ? 'popover' : 'inline-description'}>
      <Button
        ref={trigger}
        variant="secondary"
        disabled={interaction === 'dragging'}
        aria-describedby={descriptionId}
        onPointerDown={(event) => {
          touchClick.current = event.pointerType === 'touch';
        }}
        onPointerCancel={() => {
          touchClick.current = false;
          pinned.current = false;
          dismiss();
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return;
          hovered.current = true;
          dismissed.current = false;
          if (closing.current !== null) clearTimeout(closing.current);
          closing.current = null;
          if (opening.current !== null) clearTimeout(opening.current);
          opening.current = setTimeout(reveal, 250);
        }}
        onPointerLeave={(event) => {
          hovered.current = false;
          leave({ x: event.clientX, y: event.clientY });
        }}
        onFocus={() => {
          focused.current = true;
          dismissed.current = false;
          if (!touchClick.current) reveal();
        }}
        onBlur={() => {
          focused.current = false;
          pinned.current = false;
          dismissed.current = false;
          leave();
        }}
        onClick={() => {
          touchClick.current = false;
          if (pinned.current) {
            pinned.current = false;
            dismiss();
          } else {
            pinned.current = true;
            dismissed.current = false;
            reveal();
          }
        }}
      >
        {label}
      </Button>
      <span
        ref={tooltip}
        id={descriptionId}
        role={native ? 'tooltip' : undefined}
        popover={native ? 'manual' : undefined}
        hidden={native && !visible}
        className={native ? styles.tooltip : styles.description}
        style={native ? positionStyle : undefined}
        onPointerEnter={() => {
          hovered.current = true;
          clearTimers();
        }}
        onPointerLeave={() => {
          hovered.current = false;
          leave();
        }}
      >
        {description}
      </span>
    </span>
  );
}
