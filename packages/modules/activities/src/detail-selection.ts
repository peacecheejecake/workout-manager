import { createStore } from 'zustand/vanilla';
import type { TimeRange } from './detail-projection';

export interface DetailSelectionState {
  recordIndex: number | null;
  lapIndex: number | null;
  range: TimeRange | null;
  selectRecord(index: number, time: number | null): void;
  selectLap(index: number, range: TimeRange | null): void;
  selectRange(range: TimeRange | null): void;
  clear(): void;
}
const copiedRange = (range: TimeRange | null): TimeRange | null =>
  range === null ? null : { ...range };
/** Memory-only selection. The owner scopes this factory to activity and source revision. */
export function createDetailSelectionStore() {
  return createStore<DetailSelectionState>()((set) => ({
    recordIndex: null,
    lapIndex: null,
    range: null,
    selectRecord: (index, time) =>
      set({
        recordIndex: index,
        lapIndex: null,
        range: time === null ? null : { start: time, end: time },
      }),
    selectLap: (index, range) =>
      set({ recordIndex: null, lapIndex: index, range: copiedRange(range) }),
    selectRange: (range) => set({ recordIndex: null, lapIndex: null, range: copiedRange(range) }),
    clear: () => set({ recordIndex: null, lapIndex: null, range: null }),
  }));
}
export type DetailSelectionStore = ReturnType<typeof createDetailSelectionStore>;
