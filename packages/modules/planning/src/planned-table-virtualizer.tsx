import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualizerOptions,
  type VirtualItem,
} from '@tanstack/virtual-core';

type Options = Omit<
  VirtualizerOptions<HTMLDivElement, HTMLTableRowElement>,
  'onChange' | 'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>;
interface Snapshot {
  items: VirtualItem[];
  totalSize: number;
}
/** Core lifecycle follows TanStack's MIT React adapter; rendering consumes immutable external snapshots.
 * https://github.com/TanStack/virtual/tree/main/packages/react-virtual
 */
class TableVirtualizerAdapter {
  readonly instance: Virtualizer<HTMLDivElement, HTMLTableRowElement>;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { items: [], totalSize: 0 };
  private previousItems: VirtualItem[] | null = null;
  constructor(options: Options) {
    this.instance = new Virtualizer(this.options(options));
    this.publish();
  }
  private options(options: Options): VirtualizerOptions<HTMLDivElement, HTMLTableRowElement> {
    return {
      ...options,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      onChange: () => this.publish(),
    };
  }
  private publish = () => {
    const items = this.instance.getVirtualItems();
    const totalSize = this.instance.getTotalSize();
    if (items === this.previousItems && totalSize === this.snapshot.totalSize) return;
    this.previousItems = items;
    this.snapshot = { items: items.map((item) => ({ ...item })), totalSize };
    this.listeners.forEach((listener) => listener());
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  mount = () => this.instance._didMount();
  update(options: Options) {
    this.instance.setOptions(this.options(options));
    this.instance._willUpdate();
    this.publish();
  }
}
export function useTableVirtualizer(options: Options) {
  const [adapter] = useState(() => new TableVirtualizerAdapter(options));
  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getSnapshot,
  );
  useLayoutEffect(() => adapter.mount(), [adapter]);
  useLayoutEffect(() => {
    adapter.update(options);
  }, [adapter, options]);
  const commands = useMemo(
    () => ({
      measureElement: (element: HTMLTableRowElement | null) =>
        adapter.instance.measureElement(element),
      scrollToIndex: (index: number) => {
        adapter.instance.scrollToIndex(index, { align: 'start' });
        return adapter.instance.getOffsetForIndex(index, 'start')?.[0];
      },
      scrollToOffset: (offset: number) => adapter.instance.scrollToOffset(offset),
    }),
    [adapter],
  );
  return { ...snapshot, ...commands };
}
