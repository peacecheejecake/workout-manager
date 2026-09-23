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

const renderer = vi.hoisted(() => ({
  /** Features the stand-in says are drawn, per layer id. */
  drawn: new Map<string, number>(),
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
      const total = layers.reduce((sum, id) => sum + (renderer.drawn.get(id) ?? 0), 0);
      return Array.from({ length: total }, () => ({}));
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
    fitBounds() {}
    resize() {}
    remove() {}
  }
  return { Map: StandInMap, GeoJSONSource, addProtocol: vi.fn(), setWorkerUrl: vi.fn() };
});

async function adapterWith(drawn: Record<string, number>) {
  renderer.drawn = new Map(Object.entries(drawn));
  renderer.handlers.clear();
  renderer.layers = [];
  const { createMapLibreAdapter } = await import('../src/maplibre-adapter');
  const observations: MapRenderIdleInfo[] = [];
  const handle = await createMapLibreAdapter({
    container: document.createElement('div'),
    basemap: null,
    onReady: () => undefined,
    onFailure: () => undefined,
    onPick: () => undefined,
    onIdle: (info) => observations.push(info),
  });
  return { handle, observations };
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
});
