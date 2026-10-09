import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import styles from './action-menu.module.css';

export type ActionMenuAction =
  | { id: string; label: string; state: 'enabled'; onSelect: () => void }
  | { id: string; label: string; state: 'disabled' };
export interface ActionMenuProps {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly ActionMenuAction[];
}
const available = () =>
  typeof HTMLElement !== 'undefined' &&
  typeof HTMLElement.prototype.showPopover === 'function' &&
  typeof HTMLElement.prototype.hidePopover === 'function';
const noSubscription = () => () => {};
function createNativeStatus() {
  let healthy = true;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => healthy,
    subscribe(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    fail() {
      healthy = false;
      for (const listener of listeners) listener();
    },
  };
}

function enclosingModal(element: HTMLElement | null): HTMLDialogElement | null {
  for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDialogElement) {
      try {
        if (ancestor.matches(':modal')) return ancestor;
      } catch {
        /* Unsupported UA pseudo is not proof of a modal. */
      }
    }
  }
  return null;
}
function visibleInScope(element: HTMLElement): boolean {
  if (element.matches(':disabled')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.inert || ancestor.hasAttribute('inert')) return false;
    const style = getComputedStyle(ancestor);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden'
    )
      return false;
    if (ancestor instanceof HTMLDialogElement && !ancestor.open) return false;
  }
  return true;
}

/** Controlled actions only; the inline fallback does not promise top-layer clipping protection. */
export function ActionMenu({ label, open, onOpenChange, actions }: ActionMenuProps) {
  const id = useId();
  const triggerId = `action-trigger-${id}`;
  const menuId = `action-menu-${id}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const wasOpen = useRef(false);
  const focusedAction = useRef<{ element: HTMLButtonElement; index: number } | null>(null);
  const search = useRef({ text: '', at: 0 });
  const capability = useSyncExternalStore(noSubscription, available, () => false);
  const [status] = useState(createNativeStatus);
  const healthy = useSyncExternalStore(status.subscribe, status.snapshot, () => true);
  const native = capability && healthy;
  const previousNative = useRef(native);
  function items() {
    return Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }
  function dismiss(restore: boolean) {
    focusedAction.current = null;
    if (restore && trigger.current?.isConnected) trigger.current.focus();
    onOpenChange(false);
  }
  function openAt(where: 'first' | 'last') {
    initialFocus.current = where;
    if (open) {
      const buttons = items();
      (where === 'first' ? buttons[0] : buttons.at(-1))?.focus();
    } else onOpenChange(true);
  }
  useEffect(() => {
    const element = menu.current;
    if (!open || !native || !element) return;
    try {
      element.showPopover();
    } catch {
      status.fail();
      return;
    }
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const box = element.getBoundingClientRect();
      const x = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8));
      const below = anchor.bottom + 4;
      const y = Math.max(
        8,
        Math.min(
          below + box.height <= window.innerHeight - 8 ? below : anchor.top - box.height - 4,
          window.innerHeight - box.height - 8,
        ),
      );
      element.style.setProperty('--menu-x', `${x}px`);
      element.style.setProperty('--menu-y', `${y}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      try {
        element.hidePopover();
      } catch {
        /* Detached native surfaces need no fallback activation. */
      }
    };
  }, [open, native, status]);
  useEffect(() => {
    if (open && (!wasOpen.current || previousNative.current !== native)) {
      const buttons = Array.from(
        menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      );
      (initialFocus.current === 'first' ? buttons[0] : buttons.at(-1))?.focus();
      if (buttons.length === 0) menu.current?.focus();
    }
    if (!open && wasOpen.current && menu.current?.contains(document.activeElement))
      trigger.current?.focus();
    previousNative.current = native;
    wasOpen.current = open;
    if (!open) search.current = { text: '', at: 0 };
  }, [open, native]);
  useEffect(() => {
    const owned = focusedAction.current;
    if (!open || !owned || owned.element.isConnected) return;
    const buttons = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    focusedAction.current = null;
    (buttons[Math.min(owned.index, buttons.length - 1)] ?? menu.current)?.focus();
  }, [actions, open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      ) {
        focusedAction.current = null;
        onOpenChange(false);
      }
    };
    const focusOutside = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      ) {
        focusedAction.current = null;
        onOpenChange(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focusOutside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', focusOutside);
    };
  }, [open, onOpenChange]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const buttons = items();
    const current = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    if (event.key === 'Tab') {
      const anchor = trigger.current;
      const modal = enclosingModal(menu.current);
      const scope = modal ?? document;
      const tabbable = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 && !menu.current?.contains(element) && visibleInScope(element),
      );
      const index = tabbable.findIndex((element) => element === anchor);
      const target = event.shiftKey
        ? anchor
        : (tabbable[index + 1] ?? (modal ? tabbable[0] : undefined));
      if (target) event.preventDefault();
      focusedAction.current = null;
      onOpenChange(false);
      (target ?? anchor)?.focus();
      return;
    }
    const destination =
      event.key === 'ArrowDown'
        ? (current + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? current < 0
            ? buttons.length - 1
            : (current - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null;
    if (destination !== null) {
      event.preventDefault();
      buttons[destination]?.focus();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key !== ' '
    ) {
      event.preventDefault();
      const now = performance.now();
      const previous = now - search.current.at < 700 ? search.current.text : '';
      const next = previous + event.key.toLocaleLowerCase();
      const text = Array.from(next).every((character) => character === next[0])
        ? event.key.toLocaleLowerCase()
        : next;
      search.current = { text, at: now };
      for (let step = 1; step <= buttons.length; step++) {
        const index = (Math.max(-1, current) + step) % buttons.length;
        if (actions[index]?.label.toLocaleLowerCase().startsWith(text)) {
          buttons[index]?.focus();
          break;
        }
      }
    }
  }
  return (
    <div className={styles.root}>
      <button
        type="button"
        id={triggerId}
        ref={trigger}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? dismiss(true) : openAt('first'))}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openAt(event.key === 'ArrowUp' ? 'last' : 'first');
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            dismiss(true);
          }
        }}
      >
        {label}
      </button>
      <div
        id={menuId}
        ref={menu}
        role="menu"
        aria-labelledby={triggerId}
        tabIndex={-1}
        className={styles.menu}
        hidden={!open}
        popover={native ? 'manual' : undefined}
        data-presentation={native ? 'native-popover' : 'inline-fallback'}
        onKeyDown={keyDown}
      >
        {actions.map((action, index) => (
          <button
            type="button"
            key={action.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={action.state === 'disabled'}
            className={styles.item}
            onFocus={(event) => {
              focusedAction.current = { element: event.currentTarget, index };
            }}
            onClick={() => {
              if (action.state !== 'enabled') return;
              dismiss(true);
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
