import { describe, expect, it } from 'vitest';
import {
  initialTrackPreviewState,
  presentTrackPreview,
  trackPreviewReducer,
  type TrackPreviewState,
} from '../src/track-preview-state.js';
import {
  gappedPreviewFile,
  multiTrackPreviewFile,
  noGpsPreviewFile,
  normalPreviewFile,
} from './track-preview-fixtures.js';

const loading = (generation = 1): TrackPreviewState =>
  trackPreviewReducer(initialTrackPreviewState, {
    type: 'file-selected',
    filename: 'run.gpx',
    generation,
  });

describe('track preview state', () => {
  it('drops a result that belongs to a superseded file', () => {
    const replaced = trackPreviewReducer(loading(1), {
      type: 'file-selected',
      filename: 'second.gpx',
      generation: 2,
    });
    const stale = trackPreviewReducer(replaced, {
      type: 'parsed',
      generation: 1,
      file: normalPreviewFile(),
    });
    expect(stale).toBe(replaced);
    expect(stale.status.kind).toBe('loading');
  });

  it('ignores a late cancellation or failure once a newer file is loading', () => {
    const state = trackPreviewReducer(loading(1), {
      type: 'file-selected',
      filename: 'second.gpx',
      generation: 2,
    });
    expect(trackPreviewReducer(state, { type: 'cancelled', generation: 1 })).toBe(state);
    expect(trackPreviewReducer(state, { type: 'failed', generation: 1, code: 'X_Y' })).toBe(state);
  });

  it('fits the viewport on a track switch and on a whole-view request, never on a selection', () => {
    const ready = trackPreviewReducer(loading(), {
      type: 'parsed',
      generation: 1,
      file: multiTrackPreviewFile(),
    });
    expect(ready.fitRequest).toBe(0);
    const selected = trackPreviewReducer(ready, {
      type: 'vertex-selected',
      selection: { pathId: 'local-preview', vertexIndex: 1 },
    });
    expect(selected.fitRequest).toBe(0);
    const switched = trackPreviewReducer(selected, { type: 'track-selected', trackIndex: 1 });
    expect(switched.fitRequest).toBe(1);
    expect(switched.selection).toBeNull();
    expect(trackPreviewReducer(switched, { type: 'whole-view' }).fitRequest).toBe(2);
  });

  it('refuses a track index outside the parsed file', () => {
    const ready = trackPreviewReducer(loading(), {
      type: 'parsed',
      generation: 1,
      file: normalPreviewFile(),
    });
    expect(trackPreviewReducer(ready, { type: 'track-selected', trackIndex: 5 })).toBe(ready);
    expect(trackPreviewReducer(ready, { type: 'track-selected', trackIndex: -1 })).toBe(ready);
  });

  it('separates normal, gap, no-GPS, loading, cancelled and failed presentations', () => {
    expect(presentTrackPreview(initialTrackPreviewState)).toEqual({ kind: 'idle' });
    expect(presentTrackPreview(loading())).toEqual({ kind: 'loading' });
    expect(
      presentTrackPreview(trackPreviewReducer(loading(), { type: 'cancelled', generation: 1 })),
    ).toEqual({ kind: 'cancelled' });
    expect(
      presentTrackPreview(
        trackPreviewReducer(loading(), {
          type: 'failed',
          generation: 1,
          code: 'TRACK_FIT_INVALID',
        }),
      ),
    ).toEqual({ kind: 'failed', code: 'TRACK_FIT_INVALID' });
    const ready = (file: ReturnType<typeof normalPreviewFile>) =>
      presentTrackPreview(trackPreviewReducer(loading(), { type: 'parsed', generation: 1, file }));
    expect(ready(normalPreviewFile())).toEqual({ kind: 'normal' });
    expect(ready(gappedPreviewFile())).toEqual({ kind: 'gap' });
    expect(ready(noGpsPreviewFile())).toEqual({ kind: 'no-gps' });
  });

  it('clears everything when the file is removed', () => {
    const ready = trackPreviewReducer(loading(), {
      type: 'parsed',
      generation: 1,
      file: normalPreviewFile(),
    });
    const cleared = trackPreviewReducer(ready, { type: 'file-cleared', generation: 2 });
    expect(cleared.status).toEqual({ kind: 'idle' });
    expect(cleared.selection).toBeNull();
  });
});
