import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { shells } from './course-editor-support';

/**
 * M0-06b-odbl: the public map-data licence page, in both shells.
 *
 * It opens with no sign-in (a fresh browser context: no cookie, no session read), carries the
 * ODbL notice with both links, and names exactly what this deployment serves right now: the
 * background deployment `current.json` points at, and the routing graph the API reports.
 * The expectation is read from the same public sources independently of the page, so a page
 * that showed another deployment or graph — or a stale copy — fails here.
 */
const odbl = 'https://opendatacommons.org/licenses/odbl/1-0/';
const copyright = 'https://www.openstreetmap.org/copyright';

async function servedBasemap(request: APIRequestContext, origin: string) {
  const pointer = await request.get(`${origin}/map/basemap/current.json`);
  // The Vite preview with no background proxy answers its own page (single-page fallback).
  if (pointer.status() === 404 || !(pointer.headers()['content-type'] ?? '').includes('json'))
    return { kind: 'none' } as const;
  expect(pointer.status()).toBe(200);
  const { deploymentId } = (await pointer.json()) as { deploymentId: string };
  const record = await request.get(`${origin}/map/basemap/${deploymentId}/odbl-disclosure.json`);
  return record.status() === 200
    ? ({ kind: 'disclosed', deploymentId } as const)
    : ({ kind: 'undisclosed', deploymentId } as const);
}

async function servedGraph(request: APIRequestContext, origin: string) {
  const response = await request.get(`${origin}/bff/v1/map-data/licence`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    routing: { graph: { graphBuildId: string }; artifactNotice: string } | null;
    geoDatasets:
      | { kind: 'none' }
      | { kind: 'unavailable' }
      | { kind: 'undisclosed'; placesDatasetId: string | null; elevationDatasetId: string | null }
      | {
          kind: 'disclosed';
          disclosure: { datasets: { placesDatasetId: string; elevationDatasetId: string } };
        };
  };
  return body;
}

for (const shell of shells) {
  test(`${shell.name}: anonymous script link downloads the disclosed bytes`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: shell.origin });
    const page = await context.newPage();
    const bytes = Buffer.from('osmium tags-filter -R w/highway\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const deploymentId = 'abc123abc123-public';
    await page.route('**/map/basemap/current.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deploymentId }),
      }),
    );
    await page.route(`**/map/basemap/${deploymentId}/odbl-disclosure.json`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'basemap-tiles',
          licence: {
            name: 'ODbL-1.0',
            url: odbl,
            copyrightUrl: copyright,
            attribution: '© OpenStreetMap contributors',
          },
          buildId: 'abc123abc123',
          deploymentId,
          region: 'Fixture',
          source: {
            sha256: 'a'.repeat(64),
            bytes: 10,
            acquisition: {
              sourceId: 'fixture',
              url: 'https://example.test/source.pbf',
              lastModified: null,
              etag: null,
              recordedBy: 'none',
            },
          },
          alterationMethod: {
            description: 'Fixture filter',
            layerFilters: [{ layer: 'roads', expressions: ['w/highway'] }],
            osmiumExportFormat: 'geojsonseq',
            tippecanoeArguments: ['--minimum-zoom', '9'],
            minzoom: 9,
            maxzoom: 15,
            glyphRanges: [],
            scripts: { 'scripts/build-basemap.mjs': digest },
          },
          toolVersions: { osmium: null, tippecanoe: null, node: 'v24.12.0' },
        }),
      }),
    );
    await page.route('**/bff/v1/map-data/licence', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, routing: null, geoDatasets: { kind: 'none' } }),
      }),
    );
    await page.route(`**/map/basemap/${deploymentId}/odbl-scripts/0.txt`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: bytes }),
    );
    await page.goto('/map-data-licence');
    const link = page.getByRole('link', { name: 'scripts/build-basemap.mjs' });
    await expect(link).toHaveAttribute('href', `/map/basemap/${deploymentId}/odbl-scripts/0.txt`);
    await expect(link).toHaveAttribute('download', '');
    const href = await link.getAttribute('href');
    if (href === null) throw new Error('script link has no address');
    const downloaded = Buffer.from(
      await page.evaluate(async (href) => {
        const response = await fetch(href, { credentials: 'omit' });
        if (!response.ok) throw new Error(`download response ${response.status}`);
        return [...new Uint8Array(await response.arrayBuffer())];
      }, href),
    );
    expect(downloaded).toEqual(bytes);
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(digest);
    expect(await context.cookies()).toEqual([]);
    await context.close();
  });
  test(`${shell.name}: the licence page opens with no sign-in and names what is served`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: shell.origin });
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      requests.push(url.pathname);
      expect(request.headers()['cookie'], url.pathname).toBeUndefined();
    });
    const basemap = await servedBasemap(context.request, shell.origin);
    const { routing: graph, geoDatasets } = await servedGraph(context.request, shell.origin);

    const response = await page.goto('/map-data-licence');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/map-data-licence$/);
    await expect(
      page.getByRole('heading', { level: 1, name: '지도·경로 데이터 라이선스' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: copyright })).toHaveAttribute('href', copyright);
    await expect(page.getByRole('link', { name: odbl })).toHaveAttribute('href', odbl);

    const tiles = page.getByTestId('map-data-basemap');
    if (basemap.kind === 'none')
      await expect(tiles).toContainText('이 서버는 배경 지도 타일을 제공하지 않습니다.');
    else if (basemap.kind === 'undisclosed')
      await expect(page.getByTestId('map-data-basemap-undisclosed')).toContainText(
        basemap.deploymentId,
      );
    else {
      await expect(page.getByTestId('map-data-deployment')).toHaveText(basemap.deploymentId);
      await expect(tiles).toContainText('osmium tags-filter');
      await expect(tiles).toContainText('tippecanoe');
      await expect(tiles.getByRole('link', { name: 'scripts/build-basemap.mjs' })).toHaveAttribute(
        'href',
        new RegExp(`/map/basemap/${basemap.deploymentId}/odbl-scripts/[0-9]+\\.txt$`),
      );
    }

    const geo = page.getByTestId('map-data-geo-datasets');
    if (geoDatasets.kind === 'none')
      await expect(geo).toContainText('이 서버는 장소·고도 데이터셋을 제공하지 않습니다.');
    else if (geoDatasets.kind === 'unavailable')
      await expect(geo).toContainText('배포 기록을 확인하지 못했습니다.');
    else if (geoDatasets.kind === 'undisclosed')
      await expect(page.getByTestId('map-data-geo-undisclosed')).toContainText(
        geoDatasets.placesDatasetId ?? '없음',
      );
    else {
      await expect(page.getByTestId('map-data-places-dataset')).toHaveText(
        geoDatasets.disclosure.datasets.placesDatasetId,
      );
      await expect(page.getByTestId('map-data-elevation-dataset')).toHaveText(
        geoDatasets.disclosure.datasets.elevationDatasetId,
      );
      await expect(geo).toContainText('변경 방법');
    }

    const routing = page.getByTestId('map-data-routing');
    if (graph === null) await expect(routing).toContainText('이 서버는 경로를 계산하지 않습니다.');
    else {
      await expect(page.getByTestId('map-data-graph')).toHaveText(graph.graph.graphBuildId);
      await expect(page.getByTestId('map-data-military-barriers')).toBeVisible();
    }

    // No session was asked for: the page is not behind the sign-in.
    expect(requests.filter((path) => path.startsWith('/bff/v1/session'))).toEqual([]);
    expect(await context.cookies()).toEqual([]);

    // 320px reflow: the long hashes and arguments wrap instead of widening the page.
    await page.setViewportSize({ width: 320, height: 800 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);
    await context.close();
  });
}
