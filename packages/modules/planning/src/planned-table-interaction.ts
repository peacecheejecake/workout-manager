import { createStore } from 'zustand/vanilla';

export interface PlannedTableInteractionState {
  anchorId: string | null;
  rangeIds: string[];
  scrollLeft: number;
  rowMode: 'virtual' | 'all';
  scrollAnchor: { id: string; offset: number } | null;
}
interface Interaction {
  state: PlannedTableInteractionState;
  actions: {
    startRange(id: string): void;
    endRange(id: string, orderedIds: readonly string[]): void;
    toggleRange(id: string): void;
    clearRange(): void;
    setScrollLeft(left: number): void;
    setRowMode(mode: PlannedTableInteractionState['rowMode']): void;
    setScrollAnchor(anchor: PlannedTableInteractionState['scrollAnchor']): void;
  };
}

/** Derive the visible selection in current display order without changing stored IDs. */
export function visibleRangeIds(
  rangeIds: readonly string[],
  orderedIds: readonly string[],
): string[] {
  const selected = new Set(rangeIds);
  return [...new Set(orderedIds)].filter((id) => selected.has(id));
}

/** Memory-only interaction state: the caller scopes this above responsive renderers. */
export function createPlannedTableInteractionStore() {
  return createStore<Interaction>()((set) => ({
    state: { anchorId: null, rangeIds: [], rowMode: 'virtual', scrollAnchor: null, scrollLeft: 0 },
    actions: {
      startRange: (id) =>
        set(({ state }) => ({ state: { ...state, anchorId: id, rangeIds: [id] } })),
      endRange: (id, orderedIds) =>
        set(({ state }) => {
          const order = [...new Set(orderedIds)];
          const target = order.indexOf(id);
          if (target < 0) return {};
          const anchor = state.anchorId === null ? -1 : order.indexOf(state.anchorId);
          return {
            state: {
              ...state,
              anchorId: anchor < 0 ? id : state.anchorId,
              rangeIds:
                anchor < 0
                  ? [id]
                  : order.slice(Math.min(anchor, target), Math.max(anchor, target) + 1),
            },
          };
        }),
      toggleRange: (id) =>
        set(({ state }) => {
          const rangeIds = state.rangeIds.includes(id)
            ? state.rangeIds.filter((selected) => selected !== id)
            : [...state.rangeIds, id];
          const anchorId =
            state.anchorId !== null && rangeIds.includes(state.anchorId)
              ? state.anchorId
              : (rangeIds[0] ?? null);
          return { state: { ...state, rangeIds, anchorId } };
        }),
      clearRange: () => set(({ state }) => ({ state: { ...state, anchorId: null, rangeIds: [] } })),
      setScrollLeft: (scrollLeft) => set(({ state }) => ({ state: { ...state, scrollLeft } })),
      setRowMode: (rowMode) => set(({ state }) => ({ state: { ...state, rowMode } })),
      setScrollAnchor: (scrollAnchor) =>
        set(({ state }) => ({
          state: { ...state, scrollAnchor: scrollAnchor === null ? null : { ...scrollAnchor } },
        })),
    },
  }));
}
export type PlannedTableInteractionStore = ReturnType<typeof createPlannedTableInteractionStore>;
