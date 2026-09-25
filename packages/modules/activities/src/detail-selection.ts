import { createStore } from 'zustand/vanilla';
import type { TimeRange } from './detail-projection';

/**
 * A point on a stored recorded track.
 *
 * `trackRevision` is an opaque geometry revision, so a selection made against one stored
 * revision is never applied to another one. The store does not interpret either field.
 */
export interface TrackSampleSelection {
  readonly trackRevision: string;
  readonly sampleId: string;
}

/** The selection a range drag replaces, kept so that a cancelled drag can put it back. */
export interface SelectionSnapshot {
  readonly recordIndex: number | null;
  readonly lapIndex: number | null;
  readonly range: TimeRange | null;
  readonly sample: TrackSampleSelection | null;
}

export interface DetailSelectionState {
  rangeStart: string;
  rangeEnd: string;
  rangeError: boolean;
  setRangeStart(value: string): void;
  setRangeEnd(value: string): void;
  setRangeError(value: boolean): void;
  recordIndex: number | null;
  lapIndex: number | null;
  range: TimeRange | null;
  /**
   * The picked track sample, when one was picked directly. It lives here rather than in
   * the map screen's own state so that leaving and returning to the route tab — which
   * unmounts that screen — keeps the same point selected, and so that a sample with no
   * observation to link to is still a selection the whole screen agrees on.
   */
  sample: TrackSampleSelection | null;
  selectRecord(index: number, time: number | null): void;
  selectLap(index: number, range: TimeRange | null): void;
  selectRange(range: TimeRange | null): void;
  /**
   * Pick a track sample. `index`/`time` are the observation it definitely corresponds to;
   * `null` means there is no definite link, and then no observation is selected rather
   * than a plausible one being guessed at.
   */
  selectSample(sample: TrackSampleSelection, index: number | null, time: number | null): void;
  clear(): void;
  /** The selection saved when a range drag started; `null` when no drag is in progress. */
  rangeDragOrigin: SelectionSnapshot | null;
  /** A chart press became a range drag: save the current selection. */
  beginRangeDrag(): void;
  /** The drag ended with its range: forget the saved selection. */
  endRangeDrag(): void;
  /** The drag was cancelled (pointercancel, Escape): restore the saved selection. */
  cancelRangeDrag(): void;
}
const copiedRange = (range: TimeRange | null): TimeRange | null =>
  range === null ? null : { ...range };
/** Memory-only selection. The owner scopes this factory to activity and source revision. */
export function createDetailSelectionStore() {
  return createStore<DetailSelectionState>()((set) => ({
    rangeStart: '',
    rangeEnd: '',
    rangeError: false,
    setRangeStart: (rangeStart) => set({ rangeStart }),
    setRangeEnd: (rangeEnd) => set({ rangeEnd }),
    setRangeError: (rangeError) => set({ rangeError }),
    recordIndex: null,
    lapIndex: null,
    range: null,
    sample: null,
    // An observation selection names an observation, not a sample: any previously picked
    // sample is dropped and the map derives its marker from this observation instead.
    selectRecord: (index, time) =>
      set({
        recordIndex: index,
        lapIndex: null,
        range: time === null ? null : { start: time, end: time },
        sample: null,
      }),
    selectLap: (index, range) =>
      set({ recordIndex: null, lapIndex: index, range: copiedRange(range), sample: null }),
    selectRange: (range) =>
      set({ recordIndex: null, lapIndex: null, range: copiedRange(range), sample: null }),
    selectSample: (sample, index, time) =>
      set({
        sample: { trackRevision: sample.trackRevision, sampleId: sample.sampleId },
        recordIndex: index,
        lapIndex: null,
        range: index === null || time === null ? null : { start: time, end: time },
      }),
    clear: () => set({ recordIndex: null, lapIndex: null, range: null, sample: null }),
    rangeDragOrigin: null,
    beginRangeDrag: () =>
      set((state) => ({
        rangeDragOrigin: {
          recordIndex: state.recordIndex,
          lapIndex: state.lapIndex,
          range: copiedRange(state.range),
          sample: state.sample,
        },
      })),
    endRangeDrag: () => set({ rangeDragOrigin: null }),
    cancelRangeDrag: () =>
      set((state) =>
        state.rangeDragOrigin === null
          ? {}
          : {
              recordIndex: state.rangeDragOrigin.recordIndex,
              lapIndex: state.rangeDragOrigin.lapIndex,
              range: copiedRange(state.rangeDragOrigin.range),
              sample: state.rangeDragOrigin.sample,
              rangeDragOrigin: null,
            },
      ),
  }));
}
export type DetailSelectionStore = ReturnType<typeof createDetailSelectionStore>;
