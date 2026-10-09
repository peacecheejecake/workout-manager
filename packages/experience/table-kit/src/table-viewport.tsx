import { useMemo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor } from '@tanstack/virtual-core';
import { useTableVirtualizer } from './table-virtualizer';
export interface TableViewportState {
  scrollAnchor: { id: string; offset: number } | null;
  scrollLeft: number;
}
/** No persistence or domain ownership: the consumer supplies its scoped interaction state. */
export interface TableViewportOptions<Row> {
  rows: readonly Row[];
  mode: 'virtual' | 'all';
  getRowId(row: Row): string;
  focusedRowId: string | null;
  onFocusedRowChange(id: string | null): void;
  readState(): TableViewportState;
  onScrollLeftChange(left: number): void;
  onScrollAnchorChange(anchor: TableViewportState['scrollAnchor']): void;
  getFocusTarget(viewport: HTMLDivElement, id: string): HTMLElement | null;
}
/** Mount with a stable account/workspace key; all supplied rows remain in the logical roster. */
export function useTableViewport<Row>(options: TableViewportOptions<Row>) {
  const { rows, mode, getRowId, focusedRowId, onFocusedRowChange } = options;
  const viewport = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const virtual = mode === 'virtual' && rows.length > 50;
  const orderedKey = JSON.stringify(rows.map(getRowId));
  const focusedIndex = rows.findIndex((row) => getRowId(row) === focusedRowId);
  const virtualOptions = useMemo(
    () => ({
      count: rows.length,
      getScrollElement: () => viewport.current,
      estimateSize: () => 140,
      getItemKey: (index: number) => {
        const row = rows[index];
        return row === undefined ? index : getRowId(row);
      },
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
    [rows, getRowId, virtual, margin, focusedIndex],
  );
  const virtualizer = useTableVirtualizer(virtualOptions);
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
    const anchor = options.readState().scrollAnchor;
    const element = viewport.current;
    if (!element) return;
    element.scrollLeft = options.readState().scrollLeft;
    if (!anchor) return;
    const index = rows.findIndex((row) => getRowId(row) === anchor.id);
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
    options.onScrollLeftChange(element.scrollLeft);
    const visible = [...element.querySelectorAll<HTMLTableRowElement>('tbody tr[data-index]')].find(
      (row) => row.offsetTop + row.offsetHeight > element.scrollTop,
    );
    const index = visible?.dataset.index;
    const row = index === undefined ? undefined : rows[Number(index)];
    const id = row === undefined ? undefined : getRowId(row);
    if (visible && id)
      options.onScrollAnchorChange({ id, offset: element.scrollTop - visible.offsetTop });
  };
  const pendingJump = useRef<string | null>(null);
  const scrollHorizontal = (left: number) => {
    cancelRestore.current?.();
    viewport.current?.scrollBy({ left, behavior: 'auto' });
  };
  const jump = (id: string) => {
    cancelRestore.current?.();
    const index = rows.findIndex((row) => getRowId(row) === id);
    if (index < 0) return;
    restoreIndex(index, 0);
    pendingJump.current = id;
    onFocusedRowChange(id);
    const element = viewport.current;
    const existing = element ? options.getFocusTarget(element, id) : null;
    if (existing) {
      existing.focus();
      pendingJump.current = null;
    }
  };
  useLayoutEffect(() => {
    const jumpId = pendingJump.current;
    if (!jumpId) return;
    const element = viewport.current;
    const button = element ? options.getFocusTarget(element, jumpId) : null;
    if (button) {
      button.focus();
      pendingJump.current = null;
    }
  });
  const items = virtualizer.items;
  const rendered = virtual
    ? items
    : rows.map((row, index) => ({ index, key: getRowId(row), start: 0, end: 0, size: 0, lane: 0 }));
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
    setFocusedId: onFocusedRowChange,
  };
}
