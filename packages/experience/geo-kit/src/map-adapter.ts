/**
 * The boundary between the kit and whatever renderer draws the map.
 *
 * `MapView` only ever sees this port, so no MapLibre type escapes into the component,
 * into modules or into tests. The MapLibre implementation lives in `maplibre-adapter.ts`
 * and is loaded lazily, keeping the renderer out of the initial bundle.
 */
import type { GeoPosition, MapBounds, MapPathFeatureCollection } from './map-path';
import type { BasemapDescriptor } from './basemap';

export type MapAdapterFailure =
  'RENDERER_UNAVAILABLE' | 'CONTEXT_LOST' | 'STYLE_LOAD_FAILED' | 'BASEMAP_REJECTED';

/**
 * A classified initialisation failure.
 *
 * Failures that happen *after* a renderer exists arrive through `onFailure`, but the ones
 * that stop initialisation reject the factory promise instead, and a bare `Error` there
 * leaves the caller unable to tell "this device has no WebGL" from "the background map
 * did not load". Those are different states on screen, so the adapter classifies them and
 * the view forwards the classification rather than guessing from a message string.
 */
export class MapAdapterError extends Error {
  readonly failure: MapAdapterFailure;

  constructor(failure: MapAdapterFailure, message?: string) {
    super(message === undefined || message === '' ? failure : message);
    this.name = 'MapAdapterError';
    this.failure = failure;
  }
}

export interface MapAdapterHandle {
  /** Replace the drawn geometry. Called whenever the path revision changes. */
  setPaths(collection: MapPathFeatureCollection): void;
  /** Move only the selection marker; never recompute or refit the whole view. */
  setSelection(position: GeoPosition | null): void;
  /** Explicit viewport change: first render, track switch, or a "show all" request. */
  fitBounds(bounds: MapBounds): void;
  resize(): void;
  destroy(): void;
}

export interface MapAdapterOptions {
  readonly container: HTMLElement;
  /** `null` renders the geometry with no background map at all. */
  readonly basemap: BasemapDescriptor | null;
  readonly onReady: () => void;
  /** `detail` is a bounded renderer message for diagnostics; the view never displays it. */
  readonly onFailure: (failure: MapAdapterFailure, detail?: string) => void;
  /** A click/tap on the map surface, in map coordinates. */
  readonly onPick: (position: GeoPosition) => void;
  /**
   * The renderer settled: it finished drawing everything it currently has.
   * `renderedPathFeatures` is how many of our path features are actually on screen, which
   * is what distinguishes "initialised" from "the track is visible".
   */
  readonly onIdle?: (info: { readonly renderedPathFeatures: number }) => void;
  /**
   * Abort initialisation. Without this a renderer whose style never loads could not be
   * cleaned up, because no handle had been returned yet.
   */
  readonly signal?: AbortSignal;
}

export type MapAdapterFactory = (options: MapAdapterOptions) => Promise<MapAdapterHandle>;
