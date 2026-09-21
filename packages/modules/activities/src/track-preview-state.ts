/**
 * Preview state as an explicit, exhaustive union.
 *
 * Every state the plan asks to distinguish is a separate variant — loading, a normal
 * recording, a recording with gaps, a recording without GPS, a parse error, a user
 * cancellation — and a result from a superseded file can never overwrite a newer one,
 * because every result carries the generation it was requested for.
 */
import type { ParsedTrackFile } from '@workout/contracts/tracks';
import type { MapSelection } from '@workout/geo-kit/map-path';

export type TrackPreviewStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly filename: string | null }
  | {
      readonly kind: 'ready';
      readonly filename: string | null;
      readonly file: ParsedTrackFile;
      /**
       * Index into `file.recorded`, or `null` when the user has not chosen yet. A file
       * holding several recordings starts unselected: nothing is displayed until one is
       * picked, so no recording is ever shown as if it were the file's single actual.
       */
      readonly trackIndex: number | null;
    }
  | { readonly kind: 'cancelled'; readonly filename: string | null }
  | { readonly kind: 'failed'; readonly filename: string | null; readonly code: string };

export interface TrackPreviewState {
  readonly status: TrackPreviewStatus;
  /** Monotonic id of the chosen file. A reply for an older generation is dropped. */
  readonly generation: number;
  readonly selection: MapSelection | null;
  /** Incremented only for a deliberate viewport fit: track switch or "whole view". */
  readonly fitRequest: number;
}

export type TrackPreviewAction =
  | {
      readonly type: 'file-selected';
      readonly filename: string | null;
      readonly generation: number;
    }
  | { readonly type: 'file-cleared'; readonly generation: number }
  | { readonly type: 'parsed'; readonly generation: number; readonly file: ParsedTrackFile }
  | { readonly type: 'failed'; readonly generation: number; readonly code: string }
  | { readonly type: 'cancelled'; readonly generation: number }
  | { readonly type: 'track-selected'; readonly trackIndex: number }
  | { readonly type: 'vertex-selected'; readonly selection: MapSelection | null }
  | { readonly type: 'whole-view' };

export const initialTrackPreviewState: TrackPreviewState = {
  status: { kind: 'idle' },
  generation: 0,
  selection: null,
  fitRequest: 0,
};

export function trackPreviewReducer(
  state: TrackPreviewState,
  action: TrackPreviewAction,
): TrackPreviewState {
  switch (action.type) {
    case 'file-selected':
      // Replacing the file abandons the previous parse: a later reply for it is stale.
      return {
        status: { kind: 'loading', filename: action.filename },
        generation: action.generation,
        selection: null,
        fitRequest: state.fitRequest,
      };
    case 'file-cleared':
      return { ...initialTrackPreviewState, generation: action.generation };
    case 'parsed':
      if (action.generation !== state.generation || state.status.kind !== 'loading') return state;
      return {
        ...state,
        status: {
          kind: 'ready',
          filename: state.status.filename,
          file: action.file,
          // One recording is unambiguous; several require an explicit choice.
          trackIndex: action.file.recorded.length === 1 ? 0 : null,
        },
        selection: null,
      };
    case 'failed':
      if (action.generation !== state.generation || state.status.kind !== 'loading') return state;
      return {
        ...state,
        status: { kind: 'failed', filename: state.status.filename, code: action.code },
        selection: null,
      };
    case 'cancelled':
      if (action.generation !== state.generation || state.status.kind !== 'loading') return state;
      return {
        ...state,
        status: { kind: 'cancelled', filename: state.status.filename },
        selection: null,
      };
    case 'track-selected': {
      if (state.status.kind !== 'ready') return state;
      if (action.trackIndex === state.status.trackIndex) return state;
      if (action.trackIndex < 0 || action.trackIndex >= state.status.file.recorded.length)
        return state;
      // Switching the displayed recording is one of the three moments a fit is allowed.
      return {
        ...state,
        status: { ...state.status, trackIndex: action.trackIndex },
        selection: null,
        fitRequest: state.fitRequest + 1,
      };
    }
    case 'vertex-selected':
      // A selection changes the marker only; it never refits the viewport.
      return { ...state, selection: action.selection };
    case 'whole-view':
      return { ...state, fitRequest: state.fitRequest + 1 };
  }
}

export type TrackPreviewPresentation =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'no-track-data' }
  | { readonly kind: 'awaiting-selection'; readonly recordedCount: number }
  | { readonly kind: 'no-gps' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'normal' };

/**
 * The one place that decides which recording state the screen is in. Derived from the
 * parsed value, never stored as a second copy of it.
 */
export function presentTrackPreview(state: TrackPreviewState): TrackPreviewPresentation {
  const status = state.status;
  switch (status.kind) {
    case 'idle':
      return { kind: 'idle' };
    case 'loading':
      return { kind: 'loading' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'failed', code: status.code };
    case 'ready': {
      if (status.file.recorded.length === 0) return { kind: 'no-track-data' };
      if (status.trackIndex === null)
        return { kind: 'awaiting-selection', recordedCount: status.file.recorded.length };
      const track = status.file.recorded[status.trackIndex];
      if (!track) return { kind: 'no-track-data' };
      if (track.samples.every((sample) => sample.position === null)) return { kind: 'no-gps' };
      return track.segments.length > 1 ? { kind: 'gap' } : { kind: 'normal' };
    }
  }
}
