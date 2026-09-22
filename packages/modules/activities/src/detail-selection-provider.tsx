'use client';

/**
 * One selection store, shared by everything that shows the same activity.
 *
 * M1-04au put chart, record-table and lap selection in `detail-selection.ts`, scoped by
 * the owner to one activity and source revision. The stored-track map is a fourth view of
 * that same selection, so it joins this store instead of introducing a second one: the
 * owner mounts the provider with a key built from the activity identity, and every view
 * below reads and writes the one store.
 */
import { createContext, use, useState, type ReactNode } from 'react';
import { createDetailSelectionStore, type DetailSelectionStore } from './detail-selection';

const DetailSelectionContext = createContext<DetailSelectionStore | null>(null);

/**
 * A new `identity` starts a new store, because a selection belongs to one activity and
 * one source revision and must not survive a change of either.
 *
 * The store is replaced *during render* rather than by keying this component, because a
 * key would unmount and remount the whole subtree below it — replacing DOM nodes, focus
 * and scroll position for what is only a change of client state.
 */
export function DetailSelectionProvider({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(() => ({
    identity,
    store: createDetailSelectionStore(),
  }));
  let store = current.store;
  if (current.identity !== identity) {
    const next = { identity, store: createDetailSelectionStore() };
    setCurrent(next);
    store = next.store;
  }
  return <DetailSelectionContext value={store}>{children}</DetailSelectionContext>;
}

/**
 * `null` when no provider is mounted. A view that can also stand alone keeps its own
 * store in that case; it never silently creates a second store while a shared one exists.
 */
export function useSharedDetailSelectionStore(): DetailSelectionStore | null {
  return use(DetailSelectionContext);
}
