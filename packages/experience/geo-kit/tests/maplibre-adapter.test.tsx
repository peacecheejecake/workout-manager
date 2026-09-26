/**
 * The MapLibre adapter's render observation, against a stand-in renderer.
 *
 * What is under test is which of our layers the adapter counts as "the line". The real
 * renderer draws each role in the layer whose filter admits it; here the stand-in answers
 * `queryRenderedFeatures` per layer, so a layer the adapter forgets to count shows up as a
 * line that is on screen but reported as not drawn — the M2-01r/M2-01q conflict on
 * `/courses/new`, where the only line is the dashed uncomputed draft.
 */
import { describe, expect, it, vi } from 'vitest';
import { judgeRender } from '@workout/geo-kit/render-evidence';
import type { MapRenderIdleInfo } from '@workout/geo-kit/render-evidence';
import { toFeatureCollection } from '@workout/geo-kit/map-path';
import type { MapViewportEvent } from '@workout/geo-kit/map-adapter';

const renderer = vi.hoisted(() => ({
  /** Features the stand-in says are drawn, per layer id. */
  drawn: new Map<string, number>(),
  /** The role property of every feature a layer drew, when the stand-in is told one. */
  roles: new Map<string, string>(),
  /** Features with properties the stand-in returns per layer, after the counted ones. */
  features: new Map<string, { properties: Record<string, unknown> }[]>(),
  handlers: new Map<string, ((event?: unknown) => void)[]>(),
  layers: [] as { id: string; type: string }[],
}));

vi.mock('maplibre-gl', () => {
  class GeoJSONSource {
    setData() {}
  }
  class StandInMap {
    private readonly sources = new Map<string, GeoJSONSource>();
    isStyleLoaded() {
      return true;
    }
    once() {}
    on(event: string, handler: (event?: unknown) => void) {
      renderer.handlers.set(event, [...(renderer.handlers.get(event) ?? []), handler]);
    }
    getCanvas() {
      return { addEventListener() {} };
    }
    addSource(id: string) {
      this.sources.set(id, new GeoJSONSource());
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addLayer(layer: { id: string; type: string }) {
      renderer.layers.push(layer);
    }
    queryRenderedFeatures({ layers }: { layers: string[] }) {
      return [
        ...layers.flatMap((id) =>
          Array.from({ length: renderer.drawn.get(id) ?? 0 }, () => {
            const role = renderer.roles.get(id);
            return role === undefined ? {} : { properties: { role } };
          }),
        ),
        ...layers.flatMap((id) => renderer.features.get(id) ?? []),
      ];
    }
    isSourceLoaded() {
      return true;
    }
    getBounds() {
      return {
        getWest: () => 126.9,
        getSouth: () => 37.5,
        getEast: () => 127.1,
        getNorth: () => 37.6,
      };
    }
    fitBounds(_bounds: unknown, _options: unknown, eventData?: unknown) {
      for (const handler of renderer.handlers.get('movestart') ?? []) handler(eventData);
      for (const handler of renderer.handlers.get('moveend') ?? []) handler(eventData);
    }
    resize(eventData?: unknown) {
      const event = eventData ?? {};
      for (const handler of renderer.handlers.get('movestart') ?? []) handler(event);
      for (const handler of renderer.handlers.get('moveend') ?? []) handler(event);
    }
    remove() {}
  }
  return { Map: StandInMap, GeoJSONSource, addProtocol: vi.fn(), setWorkerUrl: vi.fn() };
});

async function adapterWith(
  drawn: Record<string, number>,
  roles: Record<string, string> = {},
  features: Record<string, { properties: Record<string, unknown> }[]> = {},
  onViewportChange?: (event: MapViewportEvent) => void,
) {
  renderer.drawn = new Map(Object.entries(drawn));
  renderer.roles = new Map(Object.entries(roles));
  renderer.features = new Map(Object.entries(features));
  renderer.handlers.clear();
  renderer.layers = [];
  const { createMapLibreAdapter } = await import('../src/maplibre-adapter');
  const observations: MapRenderIdleInfo[] = [];
  const container = document.createElement('div');
  const handle = await createMapLibreAdapter({
    container,
    basemap: null,
    onReady: () => undefined,
    onFailure: () => undefined,
    onPick: () => undefined,
    onIdle: (info) => observations.push(info),
    ...(onViewportChange ? { onViewportChange } : {}),
  });
  return { handle, observations, container };
}

/** A new-course draft whose only line is uncomputed: the dashed layer draws it. */
const uncomputedDraft = toFeatureCollection([
  {
    id: 'course-draft',
    role: 'uncomputed',
    revision: 'draft:1',
    positions: [
      [126.978, 37.566],
      [126.99, 37.57],
    ],
  },
]);

describe('MapLibre adapter render observation', () => {
  it('does not label resize as a new user move after a wheel since the last fit', async () => {
    const events: MapViewportEvent[] = [];
    const { handle, container } = await adapterWith({}, {}, {}, (event) => events.push(event));
    handle.fitBounds({
      west: 126.9,
      east: 127.1,
      south: 37.5,
      north: 37.6,
      crossesAntimeridian: false,
    });
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    handle.resize();
    expect(events.at(-1)?.source).toBe('programmatic');
    handle.destroy();
  });

  it('reports full fit and responsive resize as programmatic even immediately after a wheel', async () => {
    const events: MapViewportEvent[] = [];
    const { handle, container } = await adapterWith({}, {}, {}, (event) => events.push(event));
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    handle.fitBounds({
      west: 126.9,
      east: 127.1,
      south: 37.5,
      north: 37.6,
      crossesAntimeridian: false,
    });
    expect(events.at(-1)?.source).toBe('programmatic');
    handle.resize();
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.source).toBe('programmatic');
    for (const handler of renderer.handlers.get('movestart') ?? []) handler({});
    for (const handler of renderer.handlers.get('moveend') ?? []) handler({});
    expect(events.at(-1)?.source).toBe('programmatic');
    // An actual SDK move following a later gesture still has user provenance.
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    for (const handler of renderer.handlers.get('movestart') ?? []) handler({});
    for (const handler of renderer.handlers.get('moveend') ?? []) handler({});
    expect(events.at(-1)?.source).toBe('user');
    handle.destroy();
  });

  it('counts the dashed uncomputed line as a drawn line', async () => {
    const { handle, observations } = await adapterWith({ 'geo-kit-path-uncomputed': 1 });
    handle.setPaths(uncomputedDraft);
    for (const handler of renderer.handlers.get('idle') ?? []) handler();
    const info = observations.at(-1);
    expect(info?.renderedLineFeatures).toBe(1);
    expect(info?.expected).toEqual({ line: true, point: false });
    expect(info && judgeRender(info)).toBe('drawn');
  });

  it('still reports a line that no layer drew as not drawn', async () => {
    const { handle, observations } = await adapterWith({});
    handle.setPaths(uncomputedDraft);
    for (const handler of renderer.handlers.get('idle') ?? []) handler();
    const info = observations.at(-1);
    expect(info?.renderedLineFeatures).toBe(0);
    expect(info && judgeRender(info)).toBe('not-drawn');
  });

  it('counts every line layer it adds, and never the point layer as a line', async () => {
    const { handle, observations } = await adapterWith({ 'geo-kit-path-point': 3 });
    const lineLayers = renderer.layers.filter((layer) => layer.type === 'line');
    expect(lineLayers.map((layer) => layer.id).sort()).toEqual([
      'geo-kit-path-line',
      'geo-kit-path-uncomputed',
    ]);
    handle.setPaths(uncomputedDraft);
    for (const handler of renderer.handlers.get('idle') ?? []) handler();
    expect(observations.at(-1)?.renderedLineFeatures).toBe(0);
    expect(observations.at(-1)?.renderedPointFeatures).toBe(3);
  });

  it('says which roles among our lines it drew, so an overlap stretch is observable', async () => {
    const { handle, observations } = await adapterWith(
      { 'geo-kit-path-line': 3, 'geo-kit-path-uncomputed': 1 },
      { 'geo-kit-path-line': 'overlap', 'geo-kit-path-uncomputed': 'uncomputed' },
    );
    handle.setPaths(uncomputedDraft);
    for (const handler of renderer.handlers.get('idle') ?? []) handler();
    expect(observations.at(-1)?.renderedLineRoles).toEqual(['overlap', 'uncomputed']);
  });

  it('reports which of our pieces it drew, once per piece, from the rendered features', async () => {
    const piece = (pathId: string, revision: string, startIndex: number) => ({
      properties: { pathId, role: 'candidate', revision, startIndex, insufficient: false },
    });
    const { handle, observations } = await adapterWith(
      {},
      {},
      {
        // A line split across two tiles comes back twice.
        'geo-kit-path-line': [
          piece('range', 'r1', 3),
          piece('range', 'r1', 0),
          piece('range', 'r1', 3),
        ],
        'geo-kit-path-point': [piece('range', 'r1', 2), { properties: { pathId: 'range' } }],
      },
    );
    handle.setPaths(uncomputedDraft);
    for (const handler of renderer.handlers.get('idle') ?? []) handler();
    const info = observations.at(-1);
    expect(info?.renderedLineFeatures).toBe(3);
    expect(info?.renderedPieces).toEqual([
      { pathId: 'range', revision: 'r1', startIndex: 0, kind: 'line' },
      { pathId: 'range', revision: 'r1', startIndex: 3, kind: 'line' },
      { pathId: 'range', revision: 'r1', startIndex: 2, kind: 'point' },
    ]);
  });

  it('carries each path revision on its features', () => {
    expect(uncomputedDraft.features.map((feature) => feature.properties.revision)).toEqual([
      'draft:1',
    ]);
  });
});
