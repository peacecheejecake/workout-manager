import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  basemapPointerPath,
  mapDataLicencePagePath,
  mapDataLicenceReadPath,
  odblLicenceUrl,
  osmCopyrightUrl,
  type BasemapDataDisclosure,
  type GeoDatasetsDisclosure,
  type RoutingDataDisclosure,
} from '@workout/contracts/map-data-licence';
import {
  odblLicenceUrl as kitOdblLicenceUrl,
  osmCopyrightUrl as kitOsmCopyrightUrl,
} from '@workout/geo-kit/basemap';

import { RouteReviewSummary } from '../src/course-editor';
import { MapDataLicenceView } from '../src/map-data-licence';
import { RouteDataNotice } from '../src/route-data-notice';

/**
 * ODbL on the screens (M0-06b-odbl): the notice wherever a computed route is shown, and the
 * public page that shows the alteration method of what is being served.
 */
const sha = (character: string) => character.repeat(64);

const basemap: BasemapDataDisclosure = {
  schemaVersion: 1,
  kind: 'basemap-tiles',
  licence: {
    name: 'ODbL-1.0',
    url: odblLicenceUrl,
    copyrightUrl: osmCopyrightUrl,
    attribution: '© OpenStreetMap contributors',
  },
  buildId: 'ab12cd34ef56',
  deploymentId: 'ab12cd34ef56-mub9zzzz',
  region: 'Seoul (BBBike city extract)',
  source: {
    sha256: sha('7'),
    bytes: 51_884_841,
    acquisition: {
      sourceId: 'osm-extract-seoul',
      url: 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
      lastModified: 'Sat, 19 Sep 2026 16:20:02 GMT',
      etag: null,
      recordedBy: 'earlier-build-report',
    },
  },
  alterationMethod: {
    description: 'Layer-by-layer osmium tag filter.',
    layerFilters: [{ layer: 'roads', expressions: ['w/highway'] }],
    osmiumExportFormat: 'geojsonseq (--add-unique-id=type_id)',
    tippecanoeArguments: ['--force', '--minimum-zoom', '9'],
    minzoom: 9,
    maxzoom: 15,
    glyphRanges: ['0-255'],
    scripts: { 'scripts/build-basemap.mjs': sha('a') },
  },
  toolVersions: { osmium: 'osmium version 1.19.1', tippecanoe: 'tippecanoe v2', node: 'v24.12.0' },
};

const routing: RoutingDataDisclosure = {
  schemaVersion: 1,
  kind: 'routing-graph',
  licence: basemap.licence,
  graph: {
    graphBuildId: '92e0fa5f319a41df',
    graphContentSha256: sha('5'),
    graphImportedAt: '2026-09-26T07:03:27.000Z',
    roadDataAt: '2026-09-01T20:20:50.000Z',
  },
  engine: { engine: 'graphhopper', engineVersion: '10.0', engineArtifactSha256: sha('e') },
  profile: { profileId: 'foot-v1', profileName: 'foot', profileConfigSha256: sha('9') },
  extract: {
    sha256: sha('8'),
    region: 'South Korea (Geofabrik extract 2026-09-01)',
    byteLength: 286_403_403,
    acquisition: null,
  },
  derivation: {
    osmium: 'osmium version 1.19.1',
    militaryPerimeterBarriers: {
      tool: 'scripts/geo/MilitaryPerimeterBarriers.java',
      toolSha256: sha('f'),
      summary: { barrierNodes: 4220 },
      changesSha256: sha('c'),
      derivedExtractSha256: sha('6'),
      keptHeaderOptions: [],
    },
    timeConditionalWays: 77,
    scripts: { 'scripts/build-routing-graph.mts': sha('2') },
  },
  artifactNotice: 'missing',
};

const geoDatasets: GeoDatasetsDisclosure = {
  schemaVersion: 1,
  kind: 'geo-datasets',
  licence: basemap.licence,
  datasets: {
    placesDatasetId: '0123456789ab',
    elevationDatasetId: 'beef0123cafe',
  },
  source: {
    sha256: sha('4'),
    bytes: 286_403_403,
    acquisition: {
      sourceId: 'osm-extract-south-korea',
      url: 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf',
      lastModified: null,
      etag: null,
      recordedBy: 'none',
    },
  },
  alterationMethod: {
    description: 'Build place and elevation datasets from tagged OpenStreetMap nodes.',
    placeFilters: ['n/place'],
    elevationFilters: ['n/ele'],
    maxElevationSourceDistanceMeters: 300,
    scripts: { 'scripts/build-geo-datasets.mjs': sha('1') },
  },
  toolVersions: { osmium: 'osmium version 1.19.1', node: 'v24.12.0' },
};

type Answers = Record<string, { status: number; body?: unknown }>;

function fetcher(answers: Answers) {
  return vi.fn<typeof fetch>(async (input) => {
    const answer = answers[String(input)] ?? { status: 404 };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.body === undefined ? {} : { 'content-type': 'application/json' },
    });
  });
}

const served = (deploymentId = basemap.deploymentId): Answers => ({
  [basemapPointerPath]: { status: 200, body: { deploymentId } },
  [`/map/basemap/${deploymentId}/odbl-disclosure.json`]: { status: 200, body: basemap },
  [mapDataLicenceReadPath]: {
    status: 200,
    body: {
      schemaVersion: 1,
      routing,
      geoDatasets: { kind: 'disclosed', disclosure: geoDatasets },
    },
  },
});

describe('the route data notice', () => {
  it('names the OSM copyright page, the licence URI and the public method page', () => {
    render(<RouteDataNotice />);
    expect(screen.getByRole('link', { name: '저작권·출처' })).toHaveAttribute(
      'href',
      osmCopyrightUrl,
    );
    expect(screen.getByRole('link', { name: 'ODbL 1.0 라이선스' })).toHaveAttribute(
      'href',
      odblLicenceUrl,
    );
    expect(screen.getByRole('link', { name: '지도 데이터 변경 방법' })).toHaveAttribute(
      'href',
      mapDataLicencePagePath,
    );
    // The kit's plain-text line uses the same two URIs.
    expect([kitOsmCopyrightUrl, kitOdblLicenceUrl]).toEqual([osmCopyrightUrl, odblLicenceUrl]);
  });

  it('is part of every computed-route review', () => {
    render(
      <RouteReviewSummary
        route={{
          draftRevision: 1,
          proposalId: 'proposal-1',
          coordinates: [
            [126.97, 37.56],
            [126.98, 37.57],
          ],
          engineDistanceMeters: 1200,
          engineDurationSeconds: 900,
          maxSnapDistanceMeters: 3,
          graphBuildId: '92e0fa5f319a41df',
          engineVersion: '10.0',
          computedAt: '2026-09-26T08:00:00.000Z',
          warnings: [],
        }}
      />,
    );
    const notice = screen.getByTestId('route-data-notice');
    expect(within(notice).getByRole('link', { name: 'ODbL 1.0 라이선스' })).toHaveAttribute(
      'href',
      odblLicenceUrl,
    );
  });
});

describe('the public map-data licence page', () => {
  it('shows the notice and the served deployment and graph, read without credentials', async () => {
    const fetch = fetcher(served());
    render(<MapDataLicenceView fetcher={fetch} />);
    expect(await screen.findByTestId('map-data-deployment')).toHaveTextContent(
      basemap.deploymentId,
    );
    expect(screen.getByTestId('map-data-graph')).toHaveTextContent('92e0fa5f319a41df');
    expect(screen.getByTestId('map-data-places-dataset')).toHaveTextContent('0123456789ab');
    expect(screen.getByTestId('map-data-elevation-dataset')).toHaveTextContent('beef0123cafe');
    expect(screen.getByTestId('map-data-geo-extract-url')).toHaveTextContent(
      'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf',
    );
    expect(screen.getByTestId('map-data-notice')).toHaveTextContent(osmCopyrightUrl);
    expect(screen.getByRole('link', { name: odblLicenceUrl })).toHaveAttribute(
      'href',
      odblLicenceUrl,
    );
    // The alteration method from both records, with the military perimeter derivation.
    expect(screen.getByText(/osmium tags-filter w\/highway/)).toBeInTheDocument();
    expect(screen.getByTestId('map-data-military-barriers')).toHaveTextContent(sha('6'));
    expect(
      screen.getByText('Build place and elevation datasets from tagged OpenStreetMap nodes.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('map-data-basemap-extract-url')).toHaveTextContent(
      'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
    );
    expect(screen.getByTestId('map-data-routing-notice-state')).toHaveTextContent(
      '라이선스 고지 파일이 없습니다',
    );
    expect(screen.getByRole('link', { name: 'scripts/build-basemap.mjs' })).toHaveAttribute(
      'href',
      `/map/basemap/${basemap.deploymentId}/odbl-scripts/0.txt`,
    );
    expect(screen.getByRole('link', { name: 'scripts/build-geo-datasets.mjs' })).toHaveAttribute(
      'href',
      '/bff/v1/map-data/licence/scripts/geo/0123456789ab-beef0123cafe/0',
    );
    expect(screen.getByRole('link', { name: 'scripts/build-routing-graph.mts' })).toHaveAttribute(
      'href',
      '/bff/v1/map-data/licence/scripts/routing/92e0fa5f319a41df/0',
    );
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
    }
    expect(fetch.mock.calls.map(([input]) => String(input)).sort()).toEqual(
      Object.keys(served()).sort(),
    );
  });

  it('says a served deployment has no record, rather than showing another one', async () => {
    render(
      <MapDataLicenceView
        fetcher={fetcher({
          ...served(),
          [`/map/basemap/${basemap.deploymentId}/odbl-disclosure.json`]: { status: 404 },
        })}
      />,
    );
    expect(await screen.findByTestId('map-data-basemap-undisclosed')).toHaveTextContent(
      basemap.deploymentId,
    );
    expect(screen.queryByTestId('map-data-deployment')).not.toBeInTheDocument();
  });

  it('refuses a record that names another deployment than the one served', async () => {
    const answers = served();
    answers[basemapPointerPath] = { status: 200, body: { deploymentId: 'other-deployment' } };
    answers['/map/basemap/other-deployment/odbl-disclosure.json'] = { status: 200, body: basemap };
    render(<MapDataLicenceView fetcher={fetcher(answers)} />);
    const section = await screen.findByTestId('map-data-basemap');
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      '배경 지도 배포 기록을 읽지 못했습니다',
    );
    expect(screen.queryByTestId('map-data-deployment')).not.toBeInTheDocument();
  });

  it('reads a single-page fallback in place of the pointer as no deployment', async () => {
    const spaFallback = vi.fn<typeof fetch>(async (input) =>
      String(input) === mapDataLicenceReadPath
        ? new Response(
            JSON.stringify({ schemaVersion: 1, routing: null, geoDatasets: { kind: 'none' } }),
            {
              headers: { 'content-type': 'application/json' },
            },
          )
        : new Response('<!doctype html><title>shell</title>', {
            headers: { 'content-type': 'text/html' },
          }),
    );
    render(<MapDataLicenceView fetcher={spaFallback} />);
    expect(
      await screen.findByText('이 서버는 배경 지도 타일을 제공하지 않습니다.'),
    ).toBeInTheDocument();
  });

  it('keeps no deployment, no routing and a failed read apart', async () => {
    render(
      <MapDataLicenceView
        fetcher={fetcher({
          [mapDataLicenceReadPath]: {
            status: 200,
            body: { schemaVersion: 1, routing: null, geoDatasets: { kind: 'none' } },
          },
        })}
      />,
    );
    expect(
      await screen.findByText('이 서버는 배경 지도 타일을 제공하지 않습니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('이 서버는 경로를 계산하지 않습니다.')).toBeInTheDocument();
    expect(
      screen.getByText('이 서버는 장소·고도 데이터셋을 제공하지 않습니다.'),
    ).toBeInTheDocument();
  });

  it('distinguishes an old deployed dataset without a method from a failed read', async () => {
    const answers = served();
    answers[mapDataLicenceReadPath] = {
      status: 200,
      body: {
        schemaVersion: 1,
        routing: null,
        geoDatasets: {
          kind: 'undisclosed',
          placesDatasetId: '0123456789ab',
          elevationDatasetId: null,
        },
      },
    };
    render(<MapDataLicenceView fetcher={fetcher(answers)} />);
    expect(await screen.findByTestId('map-data-geo-undisclosed')).toHaveTextContent(
      '장소 데이터셋 0123456789ab·고도 데이터셋 없음',
    );
    expect(screen.queryByTestId('map-data-places-dataset')).not.toBeInTheDocument();
  });

  it('does not show a malformed disclosure as the served dataset', async () => {
    const answers = served();
    answers[mapDataLicenceReadPath] = {
      status: 200,
      body: {
        schemaVersion: 1,
        routing: null,
        geoDatasets: { kind: 'disclosed', disclosure: { ...geoDatasets, kind: 'other' } },
      },
    };
    render(<MapDataLicenceView fetcher={fetcher(answers)} />);
    const section = await screen.findByTestId('map-data-geo-datasets');
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      '장소·고도 데이터셋의 배포 기록을 확인하지 못했습니다',
    );
    expect(screen.queryByTestId('map-data-places-dataset')).not.toBeInTheDocument();
  });

  it('says a routing read failed rather than that there is no routing', async () => {
    render(
      <MapDataLicenceView
        fetcher={fetcher({ ...served(), [mapDataLicenceReadPath]: { status: 503, body: {} } })}
      />,
    );
    const section = await screen.findByTestId('map-data-routing');
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      '경로 graph 기록을 읽지 못했습니다',
    );
    expect(screen.queryByText('이 서버는 경로를 계산하지 않습니다.')).not.toBeInTheDocument();
  });
});
