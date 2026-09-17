import { useMemo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor } from '@tanstack/virtual-core';
import { useTableVirtualizer } from './planned-table-virtualizer';
import type { PlannedSession } from '@workout/contracts/planning';
import type { PlannedTableInteractionStore } from './planned-table-interaction';

export function usePlannedTableViewport(
  rows: PlannedSession[],
  mode: 'virtual' | 'all',
  store: PlannedTableInteractionStore,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const virtual = mode === 'virtual' && rows.length > 50;
  const orderedKey = JSON.stringify(rows.map((row) => row.id));
  const focusedIndex = rows.findIndex((row) => row.id === focusedId);
  const options = useMemo(
    () => ({
      count: rows.length,
      getScrollElement: () => viewport.current,
      estimateSize: () => 140,
      getItemKey: (index: number) => rows[index]?.id ?? index,
      overscan: 5,
      enabled: virtual,
      initialRect: { width: 960, height: 480 },
      scrollMargin: margin,
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range);
        if (focusedIndex >= 0) indexes.push(focusedIndex);
        return [...new Set(indexes)].sort((a, b) => a - b);
      },
    }),
    [rows, virtual, margin, focusedIndex],
  );
  const virtualizer = useTableVirtualizer(options);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      setWidth(element.clientWidth);
      setMargin(body.current?.offsetTop ?? 0);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  function restoreIndex(index: number, offset: number) {
    if (virtual) {
      const top = virtualizer.scrollToIndex(index);
      if (top !== undefined) virtualizer.scrollToOffset(top + offset);
    } else {
      const row = viewport.current?.querySelector<HTMLTableRowElement>(`[data-index="${index}"]`);
      if (row && viewport.current) viewport.current.scrollTop = row.offsetTop + offset;
    }
  }
  const restoring = useRef(false);
  const cancelRestore = useRef<(() => void) | null>(null);
  const restoreAnchor = useEffectEvent(() => {
    const anchor = store.getState().state.scrollAnchor;
    const element = viewport.current;
    if (!element) return;
    element.scrollLeft = store.getState().state.scrollLeft;
    if (!anchor) return;
    const index = rows.findIndex((row) => row.id === anchor.id);
    if (index < 0) return;
    restoring.current = true;
    restoreIndex(index, anchor.offset);
    let frame = 0;
    let attempts = 0;
    let stableFrames = 0;
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      restoring.current = false;
      if (cancelRestore.current === stop) cancelRestore.current = null;
      element.removeEventListener('wheel', stop);
      element.removeEventListener('touchstart', stop);
      element.removeEventListener('pointerdown', stop);
      element.removeEventListener('keydown', stop);
    };
    cancelRestore.current = stop;
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('touchstart', stop, { passive: true });
    element.addEventListener('pointerdown', stop);
    element.addEventListener('keydown', stop);
    const settle = () => {
      if (cancelled) return;
      attempts += 1;
      const row = element.querySelector<HTMLTableRowElement>(`[data-index="${index}"]`);
      if (row) {
        const desired = Math.max(0, row.offsetTop + anchor.offset);
        if (Math.abs(element.scrollTop - desired) <= 1) stableFrames += 1;
        else {
          stableFrames = 0;
          element.scrollTop = desired;
        }
      }
      if (stableFrames >= 3 || attempts >= 30) {
        stop();
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return stop;
  });
  useLayoutEffect(() => restoreAnchor(), [orderedKey, mode, virtual, margin]);
  const rememberScroll = () => {
    if (restoring.current) return;
    const element = viewport.current;
    if (!element) return;
    store.getState().actions.setScrollLeft(element.scrollLeft);
    const visible = [...element.querySelectorAll<HTMLTableRowElement>('tbody tr[data-index]')].find(
      (row) => row.offsetTop + row.offsetHeight > element.scrollTop,
    );
    const id = visible?.dataset.sessionId;
    if (visible && id)
      store
        .getState()
        .actions.setScrollAnchor({ id, offset: element.scrollTop - visible.offsetTop });
  };
  const pendingJump = useRef<string | null>(null);
  const scrollHorizontal = (left: number) => {
    cancelRestore.current?.();
    viewport.current?.scrollBy({ left, behavior: 'auto' });
  };
  const jump = (id: string) => {
    cancelRestore.current?.();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    restoreIndex(index, 0);
    pendingJump.current = id;
    setFocusedId(id);
    const existing = [
      ...(viewport.current?.querySelectorAll<HTMLButtonElement>('[data-planned-session]') ?? []),
    ].find((button) => button.dataset.plannedSession === id);
    if (existing) {
      existing.focus();
      pendingJump.current = null;
    }
  };
  useLayoutEffect(() => {
    const jumpId = pendingJump.current;
    if (!jumpId) return;
    const button = [
      ...(viewport.current?.querySelectorAll<HTMLButtonElement>('[data-planned-session]') ?? []),
    ].find((button) => button.dataset.plannedSession === jumpId);
    if (button) {
      button.focus();
      pendingJump.current = null;
    }
  });
  const items = virtualizer.items;
  const rendered = virtual
    ? items
    : rows.map((row, index) => ({ index, key: row.id, start: 0, end: 0, size: 0, lane: 0 }));
  return {
    viewport,
    body,
    width,
    margin,
    virtual,
    virtualizer,
    rendered,
    rememberScroll,
    scrollHorizontal,
    jump,
    setFocusedId,
  };
}
