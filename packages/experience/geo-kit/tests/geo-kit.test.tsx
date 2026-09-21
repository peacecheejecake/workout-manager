import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createSelfHostedLoader,
  findExternalStyleReferences,
  loadSelfHostedStyle,
  selfHostedPrefix,
  prepareSelfHostedStyle,
  resolveSameOriginPath,
  validateAttributionMarkup,
  validateBasemap,
} from '@workout/geo-kit/basemap';
import {
  computeBounds,
  findNearestVertex,
  selectedVertexKey,
  splitSegments,
  toFeatureCollection,
  validateMapPath,
} from '@workout/geo-kit/map-path';
import type { MapPath, MapSelection } from '@workout/geo-kit/map-path';
import type { MapAdapterFactory, MapAdapterHandle } from '@workout/geo-kit/map-adapter';
import { MapView } from '@workout/geo-kit/map-view';

function path(overrides: Partial<MapPath> = {}): MapPath {
  return {
    id: 'track-1',
    role: 'recorded',
    revision: 'r1',
    positions: [
      [126.978, 37.566],
      [126.98, 37.568],
      [126.982, 37.566],
    ],
    ...overrides,
  };
}

describe('map path validation', () => {
  it('rejects an empty path', () => {
    expect(validateMapPath(path({ positions: [] }))).toEqual({
      ok: false,
      problem: 'EMPTY_PATH',
      index: null,
    });
  });

  it('rejects non-finite and out-of-range coordinates with the offending index', () => {
    expect(validateMapPath(path({ positions: [[Number.NaN, 37]] }))).toEqual({
      ok: false,
      problem: 'NON_FINITE_COORDINATE',
      index: 0,
    });
    expect(
      validateMapPath(
        path({
          positions: [
            [126, 37],
            [181, 37],
          ],
        }),
      ),
    ).toEqual({ ok: false, problem: 'LONGITUDE_OUT_OF_RANGE', index: 1 });
    expect(validateMapPath(path({ positions: [[126, 91]] }))).toEqual({
      ok: false,
      problem: 'LATITUDE_OUT_OF_RANGE',
      index: 0,
    });
  });

  it('requires one vertex key per position', () => {
    expect(validateMapPath(path({ vertexKeys: ['a'] })).ok).toBe(false);
    expect(validateMapPath(path({ vertexKeys: ['a', 'b', 'c'] })).ok).toBe(true);
  });

  it('requires ascending in-range breaks', () => {
    expect(validateMapPath(path({ breaks: [0] })).ok).toBe(false);
    expect(validateMapPath(path({ breaks: [3] })).ok).toBe(false);
    expect(validateMapPath(path({ breaks: [2, 1] })).ok).toBe(false);
    expect(validateMapPath(path({ breaks: [1, 2] })).ok).toBe(true);
  });
});

describe('segments and features', () => {
  it('never bridges a gap: a break produces two features', () => {
    const collection = toFeatureCollection([path({ breaks: [2] })]);
    const [first, second] = collection.features;
    expect(collection.features).toHaveLength(2);
    expect(first?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [126.978, 37.566],
        [126.98, 37.568],
      ],
    });
    expect(second?.geometry.type).toBe('Point');
    expect(second?.properties.insufficient).toBe(true);
  });

  it('keeps the source vertex index of each segment', () => {
    expect(splitSegments(path({ breaks: [1] })).map((segment) => segment.startIndex)).toEqual([
      0, 1,
    ]);
  });

  it('renders a single sample as a point, not a line', () => {
    const collection = toFeatureCollection([path({ positions: [[126.98, 37.57]] })]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features.at(0)?.geometry.type).toBe('Point');
    expect(collection.features.at(0)?.properties.insufficient).toBe(true);
  });

  it('changes the feature id when the revision changes', () => {
    const before = toFeatureCollection([path()]).features.at(0)?.id;
    const after = toFeatureCollection([path({ revision: 'r2' })]).features.at(0)?.id;
    expect(before).not.toEqual(after);
  });
});

describe('bounds', () => {
  it('returns null when there is no usable coordinate', () => {
    expect(computeBounds([])).toBeNull();
  });

  it('uses the plain span for an ordinary track', () => {
    expect(computeBounds([path()])).toEqual({
      west: 126.978,
      east: 126.982,
      south: 37.566,
      north: 37.568,
      crossesAntimeridian: false,
    });
  });

  it('takes the narrow span across the antimeridian instead of the whole world', () => {
    const bounds = computeBounds([
      path({
        positions: [
          [179.9, 1],
          [-179.9, 1.5],
        ],
      }),
    ]);
    expect(bounds?.crossesAntimeridian).toBe(true);
    expect(bounds?.west).toBeCloseTo(179.9, 5);
    expect(bounds?.east).toBeCloseTo(-179.9, 5);
  });
});

describe('selection', () => {
  it('picks the nearest vertex deterministically', () => {
    expect(findNearestVertex([path()], [126.9801, 37.5679])).toEqual({
      pathId: 'track-1',
      vertexIndex: 1,
    });
  });

  it('returns the opaque vertex key the caller supplied, and never invents one', () => {
    const withKeys = path({ vertexKeys: ['s0', 's1', 's2'] });
    expect(selectedVertexKey([withKeys], { pathId: 'track-1', vertexIndex: 2 })).toBe('s2');
    expect(selectedVertexKey([path()], { pathId: 'track-1', vertexIndex: 2 })).toBeNull();
  });
});

describe('basemap descriptor', () => {
  const origin = 'https://our.example';

  it('accepts a same-origin absolute path', () => {
    expect(
      validateBasemap({ styleUrl: '/map/basemap/abc/style.json', attribution: '© OSM' }, origin),
    ).toEqual({ ok: true });
  });

  it('rejects every way of pointing at another host', () => {
    const attribution = '© OSM';
    expect(
      validateBasemap({ styleUrl: 'https://tile.example.com/style.json', attribution }, origin),
    ).toEqual({ ok: false, problem: 'ABSOLUTE_URL_NOT_ALLOWED' });
    expect(
      validateBasemap({ styleUrl: '//tile.example.com/style.json', attribution }, origin),
    ).toEqual({ ok: false, problem: 'PROTOCOL_RELATIVE_NOT_ALLOWED' });
    expect(validateBasemap({ styleUrl: 'style.json', attribution }, origin)).toEqual({
      ok: false,
      problem: 'PATH_MUST_BE_ABSOLUTE',
    });
    expect(validateBasemap({ styleUrl: '/map/../../etc/style.json', attribution }, origin)).toEqual(
      { ok: false, problem: 'PATH_TRAVERSAL_NOT_ALLOWED' },
    );
  });

  it('rejects the backslash form a URL parser resolves to another host', () => {
    // `new URL('\\\\outside.example/x', 'https://our.example')` is
    // `https://outside.example/x`: a string check for scheme or `//` does not see it.
    expect(new URL('\\\\outside.example/style.json', origin).origin).toBe(
      'https://outside.example',
    );
    for (const styleUrl of [
      '\\\\outside.example/style.json',
      '/\\outside.example/style.json',
      '\\/outside.example/style.json',
    ]) {
      expect(validateBasemap({ styleUrl, attribution: '© OSM' }, origin)).toEqual({
        ok: false,
        problem: 'BACKSLASH_NOT_ALLOWED',
      });
    }
  });

  it('rejects a percent-encoded traversal that a URL parser would resolve away', () => {
    // `/map/%2e%2e/private/style.json` normalises to `/private/style.json`.
    expect(
      validateBasemap({ styleUrl: '/map/%2e%2e/private/style.json', attribution: '© OSM' }, origin),
    ).toEqual({ ok: false, problem: 'ENCODED_TRAVERSAL_NOT_ALLOWED' });
    expect(
      validateBasemap(
        { styleUrl: '/map/%2E%2E%2Fprivate/style.json', attribution: '© OSM' },
        origin,
      ),
    ).toEqual({ ok: false, problem: 'ENCODED_TRAVERSAL_NOT_ALLOWED' });
  });

  it('still accepts the font stack MapLibre sends for glyphs, encoded or not', () => {
    expect(
      resolveSameOriginPath('/map/basemap/abc/glyphs/Noto%20Sans%20Regular/0-255.pbf', origin).ok,
    ).toBe(true);
    // MapLibre hands a custom protocol the unencoded name.
    expect(
      resolveSameOriginPath('/map/basemap/abc/glyphs/Noto Sans Regular/0-255.pbf', origin).ok,
    ).toBe(true);
  });

  it('rejects leading or trailing whitespace, which a URL parser strips', () => {
    expect(validateBasemap({ styleUrl: ' /map/style.json', attribution: '© OSM' }, origin)).toEqual(
      { ok: false, problem: 'CONTROL_CHARACTER_NOT_ALLOWED' },
    );
  });

  it('rejects control characters a URL parser would strip', () => {
    expect(
      validateBasemap({ styleUrl: '/map/\u0009style.json', attribution: '© OSM' }, origin),
    ).toEqual({ ok: false, problem: 'CONTROL_CHARACTER_NOT_ALLOWED' });
    expect(
      validateBasemap({ styleUrl: '\u0000/map/style.json', attribution: '© OSM' }, origin),
    ).toEqual({ ok: false, problem: 'CONTROL_CHARACTER_NOT_ALLOWED' });
  });

  it('resolves a valid path against the running origin and nothing else', () => {
    const resolved = resolveSameOriginPath('/map/basemap/abc/style.json', origin);
    expect(resolved.ok && resolved.url.href).toBe('https://our.example/map/basemap/abc/style.json');
    expect(resolveSameOriginPath('/map/style.json', 'not-an-origin')).toEqual({
      ok: false,
      problem: 'INVALID_ORIGIN',
    });
  });

  it('requires attribution text and refuses markup in it', () => {
    expect(validateBasemap({ styleUrl: '/map/style.json', attribution: '  ' }, origin)).toEqual({
      ok: false,
      problem: 'EMPTY_ATTRIBUTION',
    });
    expect(
      validateBasemap(
        { styleUrl: '/map/style.json', attribution: '<img src="https://x.example/p.png">' },
        origin,
      ),
    ).toEqual({ ok: false, problem: 'ATTRIBUTION_MARKUP_NOT_ALLOWED' });
  });
});

describe('style document checks', () => {
  const origin = 'http://127.0.0.1:4000';
  const style = () => ({
    version: 8,
    glyphs: '/map/basemap/abc/glyphs/{fontstack}/{range}.pbf',
    sprite: '/map/basemap/abc/sprite',
    sources: {
      basemap: {
        type: 'vector',
        tiles: ['/map/basemap/abc/tiles/{z}/{x}/{y}.pbf'],
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [{ id: 'label', layout: { 'text-field': ['get', 'name:en'] } }],
  });

  it('treats a self-hosted style with tag keys and an attribution link as clean', () => {
    expect(findExternalStyleReferences(style())).toEqual([]);
  });

  it('finds every external reference, whatever key it hides under', () => {
    expect(
      findExternalStyleReferences({
        ...style(),
        sprite: 'https://cdn.example.com/sprite',
        sources: { basemap: { tiles: ['//cdn.example.com/{z}/{x}/{y}.pbf'] } },
      }),
    ).toEqual(['https://cdn.example.com/sprite', '//cdn.example.com/{z}/{x}/{y}.pbf']);
  });

  it('rewrites same-origin paths onto our transport while preserving the placeholders', () => {
    const copy = style() as Record<string, unknown>;
    expect(prepareSelfHostedStyle(copy, origin)).toEqual({ ok: true });
    expect(copy.glyphs).toBe(`${selfHostedPrefix}/map/basemap/abc/glyphs/{fontstack}/{range}.pbf`);
    expect(copy.sprite).toBe(`${selfHostedPrefix}/map/basemap/abc/sprite`);
    expect((copy.sources as { basemap: { tiles: string[] } }).basemap.tiles.at(0)).toBe(
      `${selfHostedPrefix}/map/basemap/abc/tiles/{z}/{x}/{y}.pbf`,
    );
  });

  it('rejects a backslash reference the string checks would miss, and rewrites nothing', () => {
    const copy = { ...style(), sprite: '/\\outside.example/sprite' } as Record<string, unknown>;
    const result = prepareSelfHostedStyle(copy, origin);
    expect(result.ok).toBe(false);
    expect(copy.glyphs).toBe('/map/basemap/abc/glyphs/{fontstack}/{range}.pbf');
  });

  it('rejects an image in attribution, which never reaches the request hook', () => {
    const copy = style() as Record<string, unknown>;
    (copy.sources as { basemap: { attribution: string } }).basemap.attribution =
      '© OSM <img src="https://tracker.example/pixel.png">';
    expect(prepareSelfHostedStyle(copy, origin)).toEqual({
      ok: false,
      problem: 'ATTRIBUTION_MARKUP_NOT_ALLOWED',
      value: '© OSM <img src="https://tracker.example/pixel.png">',
    });
  });

  it('allows only plain text and anchors in attribution markup', () => {
    expect(validateAttributionMarkup('© <a href="https://osm.org/copyright">OSM</a>')).toBe(true);
    expect(validateAttributionMarkup('© OSM contributors (ODbL 1.0)')).toBe(true);
    expect(validateAttributionMarkup('<img src="https://x.example/p.png">')).toBe(false);
    expect(validateAttributionMarkup('<script>fetch("https://x.example")</script>')).toBe(false);
    expect(validateAttributionMarkup('<a href="javascript:alert(1)">x</a>')).toBe(false);
  });
});

describe('style fetching', () => {
  const origin = 'http://127.0.0.1:4000';
  const document = {
    version: 8,
    glyphs: '/map/glyphs/{fontstack}/{range}.pbf',
    sprite: '/map/sprite',
    sources: { basemap: { type: 'vector', tiles: ['/map/tiles/{z}/{x}/{y}.pbf'] } },
    layers: [],
  };
  const respond = (body: unknown, url: string, ok = true) =>
    ({
      ok,
      url,
      status: ok ? 200 : 502,
      json: async () => body,
    }) as unknown as Response;

  it('refuses to follow a redirect off this origin', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      // What a browser does when `redirect: 'error'` is honoured.
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(loadSelfHostedStyle('/map/style.json', origin, { fetchImpl })).rejects.toThrow();
    expect(calls.at(0)?.redirect).toBe('error');
    expect(calls.at(0)?.credentials).toBe('omit');
  });

  it('rejects a response that came back from another origin', async () => {
    const fetchImpl = (async () =>
      respond(document, 'https://outside.example/style.json')) as unknown as typeof fetch;
    await expect(loadSelfHostedStyle('/map/style.json', origin, { fetchImpl })).rejects.toThrow(
      'STYLE_ORIGIN_CHANGED',
    );
  });

  it('rejects the backslash style path before any request is made', async () => {
    const fetchImpl = vi.fn();
    await expect(
      loadSelfHostedStyle('\\\\outside.example/style.json', origin, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('STYLE_URL_REJECTED: BACKSLASH_NOT_ALLOWED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a served style that points anywhere else', async () => {
    const fetchImpl = (async () =>
      respond(
        { ...document, sprite: 'https://cdn.example/sprite' },
        `${origin}/map/style.json`,
      )) as unknown as typeof fetch;
    await expect(loadSelfHostedStyle('/map/style.json', origin, { fetchImpl })).rejects.toThrow(
      'EXTERNAL_STYLE_REFERENCE',
    );
  });

  it('returns a rewritten style for a clean same-origin document', async () => {
    const fetchImpl = (async () =>
      respond(structuredClone(document), `${origin}/map/style.json`)) as unknown as typeof fetch;
    const style = await loadSelfHostedStyle('/map/style.json', origin, { fetchImpl });
    expect(style.sprite).toBe(`${selfHostedPrefix}/map/sprite`);
  });
});

describe('self-hosted asset transport', () => {
  const origin = 'http://127.0.0.1:4000';
  const controller = { signal: new AbortController().signal };
  const respond = (init: { url: string; ok?: boolean; status?: number; body?: unknown }) =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      url: init.url,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(8),
      json: async () => init.body ?? { ok: true },
      text: async () => 'ok',
    }) as unknown as Response;

  it('fetches with redirects refused, not merely transformed', async () => {
    const calls: RequestInit[] = [];
    const load = createSelfHostedLoader(origin, (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return respond({ url: `${origin}/map/tiles/1/2/3.pbf` });
    }) as unknown as typeof fetch);
    await load({ url: `${selfHostedPrefix}/map/tiles/1/2/3.pbf`, type: 'arrayBuffer' }, controller);
    expect(calls.at(0)?.redirect).toBe('error');
    expect(calls.at(0)?.credentials).toBe('omit');
  });

  it('fails when a same-origin asset endpoint answers from another origin', async () => {
    // What a followed 302 would look like: the request went to us, the response did not.
    const load = createSelfHostedLoader(origin, (async () =>
      respond({ url: 'https://cdn.example.com/tiles/1/2/3.pbf' })) as unknown as typeof fetch);
    await expect(
      load({ url: `${selfHostedPrefix}/map/tiles/1/2/3.pbf`, type: 'arrayBuffer' }, controller),
    ).rejects.toThrow('SELF_HOSTED_ORIGIN_CHANGED');
  });

  it('refuses a request that is not on the transport prefix', async () => {
    const fetchImpl = vi.fn();
    const load = createSelfHostedLoader(origin, fetchImpl as unknown as typeof fetch);
    await expect(
      load({ url: 'https://cdn.example.com/tiles/1/2/3.pbf', type: 'arrayBuffer' }, controller),
    ).rejects.toThrow('SELF_HOSTED_REQUEST_REJECTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a traversal smuggled through the transport prefix', async () => {
    const fetchImpl = vi.fn();
    const load = createSelfHostedLoader(origin, fetchImpl as unknown as typeof fetch);
    await expect(
      load({ url: `${selfHostedPrefix}/map/%2e%2e/private/secret.json`, type: 'json' }, controller),
    ).rejects.toThrow('SELF_HOSTED_REQUEST_REJECTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a TileJSON response whose attribution smuggles an image', async () => {
    // MapLibre merges TileJSON attribution into the source and renders it as HTML, so
    // this is a second route to the request the attribution allowlist closed.
    const load = createSelfHostedLoader(origin, (async () =>
      respond({
        url: `${origin}/map/tiles.json`,
        body: {
          tilejson: '3.0.0',
          tiles: ['/map/tiles/{z}/{x}/{y}.pbf'],
          attribution: '© OSM <img src="https://outside.example/pixel">',
        },
      })) as unknown as typeof fetch);
    await expect(
      load({ url: `${selfHostedPrefix}/map/tiles.json`, type: 'json' }, controller),
    ).rejects.toThrow('SELF_HOSTED_JSON_REJECTED_ATTRIBUTION_MARKUP_NOT_ALLOWED');
  });

  it('rejects a TileJSON response that points its tiles at another host', async () => {
    const load = createSelfHostedLoader(origin, (async () =>
      respond({
        url: `${origin}/map/tiles.json`,
        body: { tilejson: '3.0.0', tiles: ['https://cdn.example.com/{z}/{x}/{y}.pbf'] },
      })) as unknown as typeof fetch);
    await expect(
      load({ url: `${selfHostedPrefix}/map/tiles.json`, type: 'json' }, controller),
    ).rejects.toThrow('SELF_HOSTED_JSON_REJECTED_EXTERNAL_STYLE_REFERENCE');
  });

  it('rewrites a clean TileJSON response onto the transport', async () => {
    const load = createSelfHostedLoader(origin, (async () =>
      respond({
        url: `${origin}/map/tiles.json`,
        body: {
          tilejson: '3.0.0',
          tiles: ['/map/tiles/{z}/{x}/{y}.pbf'],
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      })) as unknown as typeof fetch);
    const result = await load(
      { url: `${selfHostedPrefix}/map/tiles.json`, type: 'json' },
      controller,
    );
    expect((result.data as { tiles: string[] }).tiles).toEqual([
      `${selfHostedPrefix}/map/tiles/{z}/{x}/{y}.pbf`,
    ]);
  });

  it('reports a failed status instead of returning a body', async () => {
    const load = createSelfHostedLoader(origin, (async () =>
      respond({
        url: `${origin}/map/tiles/1/2/3.pbf`,
        ok: false,
        status: 404,
      })) as unknown as typeof fetch);
    await expect(
      load({ url: `${selfHostedPrefix}/map/tiles/1/2/3.pbf`, type: 'arrayBuffer' }, controller),
    ).rejects.toThrow('SELF_HOSTED_REQUEST_FAILED_404');
  });
});

interface FakeAdapter {
  readonly handle: MapAdapterHandle;
  readonly factory: MapAdapterFactory;
  pick(position: [number, number]): void;
  fail(): void;
  idle(renderedPathFeatures: number): void;
}

function fakeAdapter(): FakeAdapter {
  const handle: MapAdapterHandle = {
    setPaths: vi.fn(),
    setSelection: vi.fn(),
    fitBounds: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  let pick: ((position: [number, number]) => void) | null = null;
  let fail: (() => void) | null = null;
  let idle: ((count: number) => void) | null = null;
  const factory: MapAdapterFactory = async (options) => {
    pick = options.onPick;
    fail = () => options.onFailure('RENDERER_UNAVAILABLE');
    idle = (count) => options.onIdle?.({ renderedPathFeatures: count });
    options.onReady();
    return handle;
  };
  return {
    handle,
    factory,
    pick: (position) => pick?.(position),
    fail: () => fail?.(),
    idle: (count) => idle?.(count),
  };
}

describe('MapView', () => {
  const basemap = { styleUrl: '/map/basemap/abc/style.json', attribution: '© OpenStreetMap' };

  it('renders geometry through the adapter and shows the attribution', async () => {
    const adapter = fakeAdapter();
    render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    expect(screen.getByText('© OpenStreetMap')).toBeInTheDocument();
    expect(await screen.findByText('지도 표시 중')).toBeInTheDocument();
  });

  it('fits once on first ready and not again for a selection change', async () => {
    const adapter = fakeAdapter();
    const paths = [path()];
    const view = render(
      <MapView
        label="기록 지도"
        paths={paths}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1));
    view.rerender(
      <MapView
        label="기록 지도"
        paths={paths}
        selection={{ pathId: 'track-1', vertexIndex: 1 }}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() =>
      expect(adapter.handle.setSelection).toHaveBeenLastCalledWith([126.98, 37.568]),
    );
    expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('refits only when the caller raises the fit request', async () => {
    const adapter = fakeAdapter();
    const paths = [path()];
    const props = {
      label: '기록 지도',
      paths,
      selection: null,
      onSelect: vi.fn(),
      basemap,
      createAdapter: adapter.factory,
    };
    const view = render(<MapView {...props} fitRequest={0} />);
    await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1));
    view.rerender(<MapView {...props} fitRequest={1} />);
    await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(2));
  });

  it('maps a map pick to the nearest vertex', async () => {
    const adapter = fakeAdapter();
    const onSelect = vi.fn<(selection: MapSelection | null) => void>();
    render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={onSelect}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.pick([126.9819, 37.5661]);
    expect(onSelect).toHaveBeenCalledWith({ pathId: 'track-1', vertexIndex: 2 });
  });

  it('keeps a keyboard-reachable coordinate list when the renderer fails', async () => {
    const adapter = fakeAdapter();
    const onSelect = vi.fn<(selection: MapSelection | null) => void>();
    render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={onSelect}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.fail();
    expect(await screen.findByText(/지도를 표시할 수 없습니다/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: '37.56800, 126.98000' }));
    expect(onSelect).toHaveBeenCalledWith({ pathId: 'track-1', vertexIndex: 1 });
  });

  it('reports invalid geometry instead of drawing it', async () => {
    const adapter = fakeAdapter();
    render(
      <MapView
        label="기록 지도"
        paths={[path({ positions: [[500, 37]] })]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    expect(await screen.findByText(/LONGITUDE_OUT_OF_RANGE/)).toBeInTheDocument();
    expect(adapter.handle.setPaths).not.toHaveBeenCalled();
  });

  it('bounds the fallback list and says how much of the track it shows', async () => {
    const adapter = fakeAdapter();
    const long = path({
      positions: Array.from(
        { length: 50 },
        (_unused, index) => [126.98 + index * 0.0001, 37.566] as const,
      ),
    });
    render(
      <MapView
        label="기록 지도"
        paths={[long]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        fallbackLimit={10}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    expect(screen.getAllByRole('button')).toHaveLength(10);
    expect(screen.getByText('좌표 50개 중 10개만 목록에 표시했습니다.')).toBeInTheDocument();
  });

  it('aborts initialisation that has not returned a handle yet', async () => {
    let captured: AbortSignal | undefined;
    const factory: MapAdapterFactory = (options) => {
      captured = options.signal;
      // A renderer whose style never loads: the promise never settles.
      return new Promise(() => {});
    };
    const view = render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={factory}
      />,
    );
    expect(captured?.aborted).toBe(false);
    view.unmount();
    expect(captured?.aborted).toBe(true);
  });

  it('destroys a renderer that arrives after unmount', async () => {
    const handle: MapAdapterHandle = {
      setPaths: vi.fn(),
      setSelection: vi.fn(),
      fitBounds: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    const control: { settle?: () => void } = {};
    const factory: MapAdapterFactory = () =>
      new Promise((resolveHandle) => {
        control.settle = () => resolveHandle(handle);
      });
    const view = render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={factory}
      />,
    );
    view.unmount();
    control.settle?.();
    await waitFor(() => expect(handle.destroy).toHaveBeenCalledTimes(1));
    expect(handle.setPaths).not.toHaveBeenCalled();
  });

  it('reports a renderer idle with how much of the path is on screen', async () => {
    const adapter = fakeAdapter();
    const onRenderIdle = vi.fn();
    render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
        onRenderIdle={onRenderIdle}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(3);
    expect(onRenderIdle).toHaveBeenCalledWith({ renderedPathFeatures: 3 });
  });

  it('destroys the renderer on unmount', async () => {
    const adapter = fakeAdapter();
    const view = render(
      <MapView
        label="기록 지도"
        paths={[path()]}
        selection={null}
        onSelect={vi.fn()}
        basemap={basemap}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    view.unmount();
    expect(adapter.handle.destroy).toHaveBeenCalledTimes(1);
  });
});
