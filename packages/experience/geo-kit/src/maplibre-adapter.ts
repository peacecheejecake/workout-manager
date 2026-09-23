/**
 * MapLibre GL JS adapter. This is the only file in the kit that touches the SDK object.
 *
 * It knows nothing about FIT/GPX provenance, activities, courses or server policy: it
 * receives renderer-neutral GeoJSON and reports picks back as plain coordinates.
 *
 * Request containment has four parts, because no single one is sufficient:
 *  - the style document is fetched by us with `redirect: 'error'`, so a redirect to
 *    another host fails instead of being followed (the renderer's own fetch of a style
 *    URL would not pass through `transformRequest` at all);
 *  - the document is then checked and rewritten by `prepareSelfHostedStyle`, so a bad
 *    style cannot introduce an external sprite, glyph, tile or attribution image;
 *  - every asset URL is rewritten onto our own protocol, whose loader is the only place
 *    a real fetch happens. That loader sets `redirect: 'error'` and re-checks the
 *    responding URL, so a same-origin endpoint answering 302 to another host fails
 *    instead of moving there. `transformRequest` alone could not do this: it only sees
 *    the initial URL, and the renderer follows redirects by default. MapLibre's worker
 *    forwards unknown-protocol requests to the main thread, so tiles are covered too;
 *  - `transformRequest` then refuses anything that is not on that protocol.
 */
import { addProtocol, GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import {
  assertBasemap,
  createSelfHostedLoader,
  loadSelfHostedStyle,
  resolveSameOriginPath,
  selfHostedPrefix,
  selfHostedScheme,
} from './basemap';
import { MapAdapterError } from './map-adapter';
import type { MapAdapterFactory, MapAdapterHandle, MapAdapterOptions } from './map-adapter';
import type { GeoPosition, MapBounds, MapPathFeatureCollection } from './map-path';
import { expectedVisibleGeometry, judgeRender } from './render-evidence';

const pathSourceId = 'geo-kit-paths';
const selectionSourceId = 'geo-kit-selection';
const pathLineLayerId = 'geo-kit-path-line';
const pathUncomputedLayerId = 'geo-kit-path-uncomputed';
const pathPointLayerId = 'geo-kit-path-point';
/**
 * Every layer that draws a LineString of ours. `expectedVisibleGeometry` expects a line for
 * any LineString in view, whatever its role, so the count must include the dashed layer
 * that carries uncomputed drafts (M2-01r) — otherwise a draft whose only line is uncomputed
 * (`/courses/new`) is announced as "could not draw" on a working map.
 */
const pathLineLayerIds = [pathLineLayerId, pathUncomputedLayerId];

/** A style that never arrives or never loads must not hang initialisation forever. */
const styleLoadTimeoutMs = 20_000;

/**
 * One deadline for the whole initialisation, combined with the caller's cancellation.
 * Built from a plain AbortController so it does not depend on `AbortSignal.any` or
 * `AbortSignal.timeout` being present; the timeout is never silently dropped.
 */
function initialisationDeadline(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('INITIALISATION_TIMEOUT')),
    styleLoadTimeoutMs,
  );
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

let transportOrigin: string | null = null;

/**
 * Register the only transport the renderer is allowed to use. Every asset URL in the
 * rewritten style is `geokit-self://self/<path>`, and MapLibre's worker forwards
 * unknown-protocol requests to the main thread, so tiles go through the same loader.
 *
 * Registration is global to MapLibre, so it is installed once per origin.
 */
export function installSelfHostedTransport(
  origin: string = currentOrigin(),
  fetchImpl: typeof fetch = fetch,
): void {
  if (transportOrigin === origin) return;
  transportOrigin = origin;
  const load = createSelfHostedLoader(origin, fetchImpl);
  addProtocol(selfHostedScheme, async (parameters, abortController) => {
    const response = await load(parameters, abortController);
    return response as { data: unknown };
  });
}

const emptyCollection: MapPathFeatureCollection = { type: 'FeatureCollection', features: [] };

function currentOrigin(): string {
  return globalThis.location?.origin ?? '';
}

/**
 * Point MapLibre at a worker we serve ourselves. The path is resolved with a real URL
 * parser and must land on this origin; a cross-origin worker would defeat both the CSP
 * and the no-external-request rule.
 */
export function configureMapWorker(workerUrl: string, origin: string = currentOrigin()): void {
  const resolved = resolveSameOriginPath(workerUrl, origin);
  if (!resolved.ok) throw new Error(`WORKER_URL_REJECTED: ${resolved.problem}`);
  setWorkerUrl(resolved.url.href);
}

/** No-background style used when the caller has no self-hosted basemap available. */
function plainStyle() {
  return {
    version: 8 as const,
    sources: {},
    layers: [
      { id: 'background', type: 'background' as const, paint: { 'background-color': '#eef1f5' } },
    ],
  };
}

function message(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Constructing the renderer is where a device without a usable WebGL context fails, and
 * that is a different state on screen from a background map that would not load.
 */
function createRenderer(options: ConstructorParameters<typeof MapLibreMap>[0]): MapLibreMap {
  try {
    return new MapLibreMap(options);
  } catch (error) {
    throw new MapAdapterError('RENDERER_UNAVAILABLE', message(error));
  }
}

export const createMapLibreAdapter: MapAdapterFactory = async (options: MapAdapterOptions) => {
  const origin = currentOrigin();
  if (options.basemap) {
    try {
      assertBasemap(options.basemap, origin);
    } catch (error) {
      throw new MapAdapterError('BASEMAP_REJECTED', message(error));
    }
  }
  const deadline = initialisationDeadline(options.signal);
  try {
    return await initialise(options, origin, deadline.signal);
  } finally {
    deadline.release();
  }
};

/**
 * Everything from creating the renderer to returning the handle runs inside one guard.
 * If any step throws — a style that never loads, a duplicate source id, a WebGL failure —
 * the renderer is removed before the error leaves, so a caller that never received a
 * handle can never be left with one it cannot destroy.
 */
async function initialise(
  options: MapAdapterOptions,
  origin: string,
  signal: AbortSignal,
): Promise<MapAdapterHandle> {
  const { container, basemap, onReady, onFailure, onPick, onIdle } = options;
  if (signal.aborted) throw new Error('ADAPTER_ABORTED');
  // Install the transport before the renderer exists, so no asset can be fetched any
  // other way.
  if (basemap) installSelfHostedTransport(origin);
  let style: unknown;
  if (basemap) {
    try {
      style = await loadSelfHostedStyle(basemap.styleUrl, origin, { signal });
    } catch (error) {
      // Cancellation is not a background-map failure: it is the caller going away, and
      // classifying it as `STYLE_LOAD_FAILED` would put a false state on screen.
      if (signal.aborted) throw new Error('ADAPTER_ABORTED');
      throw new MapAdapterError('STYLE_LOAD_FAILED', message(error));
    }
  } else {
    style = plainStyle();
  }
  if (signal.aborted) throw new Error('ADAPTER_ABORTED');

  let destroyed = false;
  // The paths the source currently holds, so an idle can be judged against them.
  let current: MapPathFeatureCollection = emptyCollection;
  // New paths were handed over and no frame has yet shown them drawn.
  let awaitingDraw = false;
  const map = createRenderer({
    container,
    style: style as never,
    center: [0, 0],
    zoom: 1,
    // Page scrolling must not be captured permanently by the map surface.
    cooperativeGestures: true,
    attributionControl: basemap ? { compact: true } : false,
    // `exactOptionalPropertyTypes`: the option must be absent, not explicitly undefined.
    ...(basemap?.localIdeographFontFamily
      ? { localIdeographFontFamily: basemap.localIdeographFontFamily }
      : {}),
    transformRequest: (url: string) => {
      // After the style rewrite every renderer request must be on our own protocol.
      // Anything else — including a plain same-origin http URL — is refused, because
      // only the protocol loader can refuse redirects.
      if (url.startsWith(`${selfHostedPrefix}/`)) return { url };
      onFailure('BASEMAP_REJECTED', 'REQUEST_OUTSIDE_SELF_HOSTED_TRANSPORT');
      return { url: '' };
    },
  });

  const fail = (reason: Parameters<typeof onFailure>[0], detail?: string) => {
    if (!destroyed) onFailure(reason, detail?.slice(0, 300));
  };

  try {
    await new Promise<void>((resolveLoad, rejectLoad) => {
      if (map.isStyleLoaded()) {
        resolveLoad();
        return;
      }
      const abort = () => rejectLoad(new Error('ADAPTER_ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      map.once('load', () => {
        signal.removeEventListener('abort', abort);
        resolveLoad();
      });
    });

    map.on('error', (event: { error?: { message?: string } }) =>
      fail('STYLE_LOAD_FAILED', event.error?.message),
    );
    map.getCanvas().addEventListener('webglcontextlost', () => fail('CONTEXT_LOST'));
    map.on('click', (event: { lngLat: { lng: number; lat: number } }) => {
      onPick([event.lngLat.lng, event.lngLat.lat]);
    });

    map.addSource(pathSourceId, { type: 'geojson', data: emptyCollection });
    map.addSource(selectionSourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: pathLineLayerId,
      type: 'line',
      source: pathSourceId,
      filter: [
        'all',
        ['==', ['geometry-type'], 'LineString'],
        ['!=', ['get', 'role'], 'uncomputed'],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 4,
        'line-color': [
          'match',
          ['get', 'role'],
          'planned',
          '#2f6f4e',
          'candidate',
          '#9a6b1f',
          '#6256b8',
        ],
      },
    });
    map.addLayer({
      // A line nobody computed. Thin, grey and dashed, in its own layer, so it cannot be
      // mistaken for a route even before anyone reads the words the caller puts beside it.
      id: pathUncomputedLayerId,
      type: 'line',
      source: pathSourceId,
      filter: [
        'all',
        ['==', ['geometry-type'], 'LineString'],
        ['==', ['get', 'role'], 'uncomputed'],
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-width': 2, 'line-color': '#6b6f78', 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      // A path with a single sample is a point, never a line joined across a gap.
      id: pathPointLayerId,
      type: 'circle',
      source: pathSourceId,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': '#6256b8' },
    });
    map.addLayer({
      id: 'geo-kit-selection',
      type: 'circle',
      source: selectionSourceId,
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#31343c',
      },
    });

    if (onIdle) {
      // Lines and points are counted apart: points alone must not stand in for a line.
      const count = (layers: string[]) => {
        try {
          return map.queryRenderedFeatures({ layers }).length;
        } catch {
          return 0;
        }
      };
      const observe = () => {
        const renderedLineFeatures = count(pathLineLayerIds);
        const renderedPointFeatures = count([pathPointLayerId]);
        const viewport = map.getBounds();
        return {
          renderedPathFeatures: renderedLineFeatures + renderedPointFeatures,
          renderedLineFeatures,
          renderedPointFeatures,
          pathFeatures: current.features.length,
          expected: expectedVisibleGeometry(current, {
            west: viewport.getWest(),
            south: viewport.getSouth(),
            east: viewport.getEast(),
            north: viewport.getNorth(),
          }),
        };
      };
      // `idle` means the renderer finished drawing everything it currently has, so it is
      // the one point where "nothing of the track is on screen" can be concluded.
      map.on('idle', () => {
        if (destroyed) return;
        awaitingDraw = false;
        onIdle(observe());
      });
      // But `idle` also waits for every background tile, and a cold or slow tile server
      // held it past the render deadline while the line was already on screen (seen in
      // the Vite shell on a first load, M2-01q). So once our own source has loaded new
      // paths, each rendered frame is checked too — and reported only when it shows them
      // drawn. A frame can prove a draw early; only `idle` or the deadline can say "not".
      map.on('render', () => {
        if (destroyed || !awaitingDraw) return;
        let loaded = false;
        try {
          loaded = map.isSourceLoaded(pathSourceId);
        } catch {
          loaded = false;
        }
        if (!loaded) return;
        const info = observe();
        if (judgeRender(info) !== 'drawn') return;
        awaitingDraw = false;
        onIdle(info);
      });
    }

    const handle: MapAdapterHandle = {
      setPaths(collection) {
        const source = map.getSource(pathSourceId);
        if (!(source instanceof GeoJSONSource)) return;
        current = collection;
        awaitingDraw = collection.features.length > 0;
        source.setData(collection as never);
      },
      setSelection(position: GeoPosition | null) {
        const source = map.getSource(selectionSourceId);
        if (!(source instanceof GeoJSONSource)) return;
        source.setData({
          type: 'FeatureCollection',
          features: position
            ? [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'Point', coordinates: [position[0], position[1]] },
                },
              ]
            : [],
        } as never);
      },
      fitBounds(bounds: MapBounds) {
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north],
          ],
          { padding: 24, animate: false },
        );
      },
      resize() {
        map.resize();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        map.remove();
      },
    };
    if (signal.aborted) throw new Error('ADAPTER_ABORTED');
    onReady();
    return handle;
  } catch (error) {
    destroyed = true;
    map.remove();
    throw error instanceof Error ? error : new Error('ADAPTER_INITIALISATION_FAILED');
  }
}
