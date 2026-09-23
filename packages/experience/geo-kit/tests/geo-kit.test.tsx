import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
import type {
  MapAdapterFactory,
  MapAdapterFailure,
  MapAdapterHandle,
} from '@workout/geo-kit/map-adapter';
import { MapView } from '@workout/geo-kit/map-view';
import {
  collectionKey,
  expectedVisibleGeometry,
  judgeRender,
} from '@workout/geo-kit/render-evidence';
import type { MapRenderIdleInfo } from '@workout/geo-kit/render-evidence';

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
  fail(failure?: MapAdapterFailure): void;
  idle(info: MapRenderIdleInfo): void;
}

/** What a renderer reports at idle. Defaults: a line in view, drawn. */
function idleInfo(overrides: Partial<MapRenderIdleInfo> = {}): MapRenderIdleInfo {
  const lines = overrides.renderedLineFeatures ?? 1;
  const points = overrides.renderedPointFeatures ?? 0;
  return {
    renderedPathFeatures: lines + points,
    renderedLineFeatures: lines,
    renderedPointFeatures: points,
    pathFeatures: 1,
    expected: { line: true, point: false },
    ...overrides,
  };
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
  let fail: ((failure: MapAdapterFailure) => void) | null = null;
  let idle: ((info: MapRenderIdleInfo) => void) | null = null;
  const factory: MapAdapterFactory = async (options) => {
    pick = options.onPick;
    fail = (failure) => options.onFailure(failure);
    idle = (info) => options.onIdle?.(info);
    options.onReady();
    return handle;
  };
  return {
    handle,
    factory,
    pick: (position) => pick?.(position),
    fail: (failure = 'RENDERER_UNAVAILABLE') => fail?.(failure),
    idle: (info) => act(() => idle?.(info)),
  };
}

/** The map's own live status line: what a screen reader announces for this map. */
function mapStatus(label = '기록 지도') {
  return within(screen.getByRole('region', { name: label })).getAllByRole('status')[0];
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
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
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
    expect(
      await screen.findByText(/지도 렌더러\(WebGL\)를 사용할 수 없습니다/),
    ).toBeInTheDocument();
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
    const info = idleInfo({ renderedLineFeatures: 2, renderedPointFeatures: 1 });
    adapter.idle(info);
    expect(onRenderIdle).toHaveBeenCalledWith(info);
    const region = screen.getByRole('region', { name: '기록 지도' });
    expect(region).toHaveAttribute('data-rendered-lines', '2');
    expect(region).toHaveAttribute('data-rendered-points', '1');
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

/**
 * M2-01q. What the map says about itself must be what the renderer actually drew.
 *
 * The style loads without the renderer's worker, so a map whose worker never started
 * used to report "지도 표시 중" over an empty canvas, to sighted users and to screen
 * readers alike (M2-01k F2/F3). These tests hold the status line — the element with
 * `role="status"` inside the map region, which is what assistive technology announces —
 * to the evidence each state needs.
 */
describe('render evidence', () => {
  const line = toFeatureCollection([path()]);
  const single = toFeatureCollection([path({ positions: [[126.978, 37.566]] })]);
  const around = { west: 126.97, south: 37.56, east: 126.99, north: 37.57 };

  it('expects a line only when one of its vertices is inside the viewport', () => {
    expect(expectedVisibleGeometry(line, around)).toEqual({ line: true, point: false });
    expect(
      expectedVisibleGeometry(line, { west: 127.5, south: 37.0, east: 127.6, north: 37.1 }),
    ).toEqual({ line: false, point: false });
    // The line crosses this narrow box between two vertices; no vertex lies inside it, so
    // whether it is drawn there is left undecided rather than guessed.
    expect(
      expectedVisibleGeometry(line, {
        west: 126.9805,
        south: 37.5665,
        east: 126.9806,
        north: 37.5666,
      }),
    ).toEqual({ line: false, point: false });
  });

  it('keys a collection by its content, not by its array identity', () => {
    const same = collectionKey(toFeatureCollection([path()]));
    expect(collectionKey(toFeatureCollection([path()]))).toBe(same);
    // Same ids, same counts, one vertex moved by about a metre: a different line.
    const moved = path({
      positions: [
        [126.978, 37.566],
        [126.98001, 37.568],
        [126.982, 37.566],
      ],
    });
    expect(collectionKey(toFeatureCollection([moved]))).not.toBe(same);
    // Same numbers split differently across features is a different collection too.
    const split = path({ breaks: [1] });
    expect(collectionKey(toFeatureCollection([split]))).not.toBe(same);
  });

  it('does not expect waypoint points that are off screen while the line is on it', () => {
    // Review N3: the course line in view, its waypoint markers outside it.
    const course = toFeatureCollection([
      path(),
      path({
        id: 'waypoints',
        revision: 'w1',
        positions: [
          [127.5, 37.9],
          [127.6, 37.95],
        ],
        breaks: [1],
      }),
    ]);
    expect(expectedVisibleGeometry(course, around)).toEqual({ line: true, point: false });
    expect(
      judgeRender(
        idleInfo({
          pathFeatures: course.features.length,
          expected: expectedVisibleGeometry(course, around),
          renderedPointFeatures: 0,
        }),
      ),
    ).toBe('drawn');
  });

  it('expects a lone sample as a point, and handles a viewport that wraps the world', () => {
    expect(expectedVisibleGeometry(single, around)).toEqual({ line: false, point: true });
    // MapLibre reports edges past ±180° when the map wraps.
    expect(
      expectedVisibleGeometry(single, { west: -233.1, south: 37.5, east: -232.9, north: 37.6 }),
    ).toEqual({ line: false, point: true });
    expect(expectedVisibleGeometry(line, { west: -540, south: -85, east: 540, north: 85 })).toEqual(
      { line: true, point: false },
    );
  });

  it('turns one idle into a verdict, lines and points judged apart', () => {
    expect(judgeRender(idleInfo({ pathFeatures: 0 }))).toBe('no-evidence');
    expect(judgeRender(idleInfo({ expected: { line: false, point: false } }))).toBe('out-of-view');
    expect(judgeRender(idleInfo({ renderedLineFeatures: 0 }))).toBe('not-drawn');
    // Points on screen do not stand in for a line that should be there.
    expect(judgeRender(idleInfo({ renderedLineFeatures: 0, renderedPointFeatures: 4 }))).toBe(
      'not-drawn',
    );
    expect(
      judgeRender(idleInfo({ expected: { line: true, point: true }, renderedPointFeatures: 0 })),
    ).toBe('not-drawn');
    expect(judgeRender(idleInfo())).toBe('drawn');
  });
});

describe('MapView status honesty', () => {
  const basemap = { styleUrl: '/map/basemap/abc/style.json', attribution: '© OpenStreetMap' };
  const props = {
    label: '기록 지도',
    selection: null,
    onSelect: vi.fn(),
    basemap,
  };

  it('says the background is ready but the path is still being drawn after a style load', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    expect(mapStatus()).toHaveTextContent('배경 지도를 불러왔습니다. 경로를 그리는 중입니다.');
    expect(screen.getByRole('region', { name: '기록 지도' })).toHaveAttribute(
      'data-map-status',
      'drawing',
    );
    expect(screen.queryByText(/표시 중|표시했습니다/)).not.toBeInTheDocument();
  });

  it('says it could not draw when the renderer never settles, and recovers if it later does', async () => {
    const adapter = fakeAdapter();
    const onStatusChange = vi.fn();
    render(
      <MapView
        {...props}
        paths={[path()]}
        createAdapter={adapter.factory}
        renderDeadlineMs={30}
        onStatusChange={onStatusChange}
      />,
    );
    await waitFor(() =>
      expect(mapStatus()).toHaveTextContent(
        '지도가 경로를 그리지 못했습니다. 아래 좌표 목록을 사용하세요.',
      ),
    );
    // Reported outward from an effect, which may run just after the text is committed.
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('not-drawn', undefined));
    expect(screen.queryByText(/표시했습니다/)).not.toBeInTheDocument();
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
  });

  it('says it could not draw when the path is in view and the renderer drew none of it', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo({ renderedLineFeatures: 0, renderedPointFeatures: 2 }));
    expect(mapStatus()).toHaveTextContent('지도가 경로를 그리지 못했습니다.');
  });

  it('says the path is outside the view rather than drawn or failed', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo({ renderedLineFeatures: 0, expected: { line: false, point: false } }));
    expect(mapStatus()).toHaveTextContent('경로가 지금 보이는 지도 영역 밖에 있습니다.');
  });

  it('does not call a renderer that already drew it unable to draw when the view stops showing it', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
    // Zoomed far out: a vertex is still inside the viewport, but the line is below a pixel.
    adapter.idle(idleInfo({ renderedLineFeatures: 0 }));
    expect(mapStatus()).toHaveTextContent('경로가 지도에 그려졌는지 지금은 확인하지 못했습니다.');
    expect(screen.queryByText(/그리지 못했습니다|표시했습니다/)).not.toBeInTheDocument();
  });

  /**
   * Review B1: a renderer that drew, a changed path, and nothing confirming the new path
   * within the deadline (off screen while slow tiles hold back idle). That silence says
   * nothing about whether the renderer can draw; it must not be announced as "cannot".
   */
  it('says a changed path is unconfirmed, not undrawable, when a renderer that drew goes silent', async () => {
    const adapter = fakeAdapter();
    const onStatusChange = vi.fn();
    const view = render(
      <MapView
        {...props}
        paths={[path()]}
        createAdapter={adapter.factory}
        renderDeadlineMs={10_000}
        onStatusChange={onStatusChange}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
    // A waypoint is added; no observation follows.
    view.rerender(
      <MapView
        {...props}
        paths={[
          path({
            positions: [
              [126.978, 37.566],
              [126.98, 37.568],
              [127.3, 37.9],
            ],
          }),
        ]}
        createAdapter={adapter.factory}
        renderDeadlineMs={40}
        onStatusChange={onStatusChange}
      />,
    );
    await waitFor(() =>
      expect(mapStatus()).toHaveTextContent('경로가 지도에 그려졌는지 지금은 확인하지 못했습니다.'),
    );
    expect(screen.queryByText(/그리지 못했습니다|표시했습니다/)).not.toBeInTheDocument();
    expect(onStatusChange).not.toHaveBeenCalledWith('not-drawn', undefined);
    // And a later observation of the new path restores "drawn" for it.
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
  });

  /**
   * Review NB1: after a change, "drawn" about the previous path may carry over only
   * briefly. Past the grace, the status line stops saying the path is shown until the new
   * path is confirmed — a dead worker must not keep "shown" for the whole deadline.
   */
  it('stops saying a changed path is shown once its confirmation is overdue', async () => {
    const adapter = fakeAdapter();
    const common = {
      ...props,
      createAdapter: adapter.factory,
      renderDeadlineMs: 10_000,
      confirmGraceMs: 30,
    };
    const view = render(<MapView {...common} paths={[path()]} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
    view.rerender(
      <MapView
        {...common}
        paths={[
          path({
            positions: [
              [126.978, 37.566],
              [127.3, 37.9],
            ],
          }),
        ]}
      />,
    );
    await waitFor(() => expect(mapStatus()).toHaveTextContent('경로를 그리는 중입니다.'));
    expect(screen.queryByText(/표시했습니다/)).not.toBeInTheDocument();
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
  });

  it('still says a renderer that never drew cannot draw a changed path', async () => {
    const adapter = fakeAdapter();
    const view = render(
      <MapView {...props} paths={[path()]} createAdapter={adapter.factory} renderDeadlineMs={40} />,
    );
    await waitFor(() => expect(mapStatus()).toHaveTextContent('지도가 경로를 그리지 못했습니다.'));
    view.rerender(
      <MapView
        {...props}
        paths={[
          path({
            positions: [
              [126.978, 37.566],
              [127.3, 37.9],
            ],
          }),
        ]}
        createAdapter={adapter.factory}
        renderDeadlineMs={40}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mapStatus()).toHaveTextContent('지도가 경로를 그리지 못했습니다.');
  });

  it('marks which path a verdict is about', async () => {
    const adapter = fakeAdapter();
    const view = render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    const region = screen.getByRole('region', { name: '기록 지도' });
    adapter.idle(idleInfo());
    const first = region.getAttribute('data-paths-generation');
    expect(region).toHaveAttribute('data-evidence-generation', first);
    view.rerender(
      <MapView
        {...props}
        paths={[
          path({
            positions: [
              [126.978, 37.566],
              [127.3, 37.9],
            ],
          }),
        ]}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalledTimes(2));
    // The standing verdict is about the previous path until an observation of this one.
    expect(region.getAttribute('data-paths-generation')).not.toBe(first);
    expect(region).toHaveAttribute('data-evidence-generation', first);
    adapter.idle(idleInfo());
    expect(region).toHaveAttribute(
      'data-evidence-generation',
      region.getAttribute('data-paths-generation'),
    );
  });

  it('holds the deadline across re-renders that rebuild the same lines', async () => {
    // The course editor builds a new paths array on every render. Each rebuild used to
    // re-send the data and restart the deadline, so a screen that kept re-rendering kept a
    // map with no worker at "drawing" indefinitely (found in the real browser, M2-01q).
    const adapter = fakeAdapter();
    const view = render(
      <MapView {...props} paths={[path()]} createAdapter={adapter.factory} renderDeadlineMs={80} />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      view.rerender(
        <MapView
          {...props}
          paths={[path()]}
          createAdapter={adapter.factory}
          renderDeadlineMs={80}
        />,
      );
    }
    expect(mapStatus()).toHaveTextContent('지도가 경로를 그리지 못했습니다.');
    expect(adapter.handle.setPaths).toHaveBeenCalledTimes(1);
  });

  it('ignores an idle over a source that holds nothing yet', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo({ pathFeatures: 0, renderedLineFeatures: 0 }));
    expect(mapStatus()).toHaveTextContent('경로를 그리는 중입니다.');
  });

  it('never waits for a feature when there is legitimately nothing to draw', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} paths={[]} createAdapter={adapter.factory} renderDeadlineMs={10} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mapStatus()).toHaveTextContent('표시할 좌표가 없습니다.');
    expect(screen.queryByText(/그리지 못했습니다|그리는 중/)).not.toBeInTheDocument();
  });

  it('says there is no background map when it drew the path without one', async () => {
    const adapter = fakeAdapter();
    render(<MapView {...props} basemap={null} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    expect(mapStatus()).toHaveTextContent('경로를 그리는 중입니다.');
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('배경 지도 없이 경로를 표시했습니다.');
  });

  it('tells a background-map failure apart from a device without WebGL', async () => {
    const first = fakeAdapter();
    const view = render(<MapView {...props} paths={[path()]} createAdapter={first.factory} />);
    await waitFor(() => expect(first.handle.setPaths).toHaveBeenCalled());
    act(() => first.fail('STYLE_LOAD_FAILED'));
    expect(mapStatus()).toHaveTextContent('배경 지도를 불러오지 못해 지도를 표시할 수 없습니다.');
    view.unmount();

    const second = fakeAdapter();
    render(<MapView {...props} paths={[path()]} createAdapter={second.factory} />);
    await waitFor(() => expect(second.handle.setPaths).toHaveBeenCalled());
    act(() => second.fail('RENDERER_UNAVAILABLE'));
    expect(mapStatus()).toHaveTextContent(
      '이 브라우저에서 지도 렌더러(WebGL)를 사용할 수 없습니다.',
    );
  });

  it('does not carry "drawn" over to a new renderer created for a new background map', async () => {
    const adapter = fakeAdapter();
    const view = render(<MapView {...props} paths={[path()]} createAdapter={adapter.factory} />);
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalled());
    adapter.idle(idleInfo());
    expect(mapStatus()).toHaveTextContent('지도에 경로를 표시했습니다.');
    view.rerender(
      <MapView
        {...props}
        basemap={{ ...basemap, styleUrl: '/map/basemap/def/style.json' }}
        paths={[path()]}
        createAdapter={adapter.factory}
      />,
    );
    await waitFor(() =>
      expect(mapStatus()).toHaveTextContent('배경 지도를 불러왔습니다. 경로를 그리는 중입니다.'),
    );
  });
});

/**
 * Plan §5: fitBounds only on first render, on switching the displayed track, and on an
 * explicit "show all" request. A resize only resizes.
 */
describe('MapView viewport', () => {
  const basemap = { styleUrl: '/map/basemap/abc/style.json', attribution: '© OpenStreetMap' };

  it('only resizes on a container resize, never refits', async () => {
    const callbacks: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
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
      await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1));
      expect(callbacks).toHaveLength(1);
      act(() => callbacks[0]?.());
      act(() => callbacks[0]?.());
      expect(adapter.handle.resize).toHaveBeenCalledTimes(2);
      expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('refits to the new track on a switch, and not for a data update without one', async () => {
    const adapter = fakeAdapter();
    const first = path();
    const second = path({
      id: 'track-2',
      revision: 'r2',
      positions: [
        [127.05, 37.5],
        [127.06, 37.51],
      ],
    });
    const common = {
      label: '기록 지도',
      selection: null,
      onSelect: vi.fn(),
      basemap,
      createAdapter: adapter.factory,
    };
    const view = render(<MapView {...common} paths={[first]} fitRequest={0} />);
    await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1));
    // A data update on the same track (a highlight, an edit) keeps the user's viewport.
    view.rerender(
      <MapView
        {...common}
        paths={[first, path({ id: 'highlight', revision: 'h1' })]}
        fitRequest={0}
      />,
    );
    await waitFor(() => expect(adapter.handle.setPaths).toHaveBeenCalledTimes(2));
    expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(1);
    // Switching the displayed track raises the request, and the fit is to the new track.
    view.rerender(<MapView {...common} paths={[second]} fitRequest={1} />);
    await waitFor(() => expect(adapter.handle.fitBounds).toHaveBeenCalledTimes(2));
    expect(adapter.handle.fitBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ west: 127.05, east: 127.06, south: 37.5, north: 37.51 }),
    );
  });
});
