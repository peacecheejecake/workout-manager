import { describe, expect, it } from 'vitest';

import {
  assertGeoDatasetArtifacts,
  createGeoDatasetDisclosure,
  elevationMetresOrNull,
  renderGeoDatasetsAttribution,
} from '../../../scripts/build-geo-datasets.mjs';
import { ODBL_LICENCE_URL, OSM_COPYRIGHT_URL } from '../../../scripts/geo/odbl.mjs';

/**
 * The build step that turns an OSM `ele` tag into a stored elevation (M2-01j).
 *
 * This is where a missing value can silently become a known one: `Number('')` is 0, and a
 * stored 0 is reported to a reader as a measured sea-level elevation rather than as "we
 * have no fact here". The lookup tests work from an already-built dataset, so they cannot
 * see this conversion at all — it is tested here.
 */
describe('elevation tag conversion', () => {
  it('treats an empty or blank tag as missing, never as 0 m', () => {
    expect(elevationMetresOrNull('')).toBeNull();
    expect(elevationMetresOrNull('   ')).toBeNull();
    expect(elevationMetresOrNull('\n\t')).toBeNull();
    expect(elevationMetresOrNull(undefined)).toBeNull();
    expect(elevationMetresOrNull(null)).toBeNull();
  });

  it('keeps a real zero, which is a measured value', () => {
    expect(elevationMetresOrNull('0')).toBe(0);
    expect(elevationMetresOrNull(' 0.0 ')).toBe(0);
  });

  it('drops a value that is not a plain number of metres rather than coercing it', () => {
    // Real OSM values: units, ranges, commas, feet, prose.
    for (const raw of ['123 m', '123m', '1,5', '12-15', '1e3', '약 200', 'approx 200', '200ft'])
      expect(elevationMetresOrNull(raw)).toBeNull();
  });

  it('refuses a value outside the range the contract accepts', () => {
    expect(elevationMetresOrNull('99999')).toBeNull();
    expect(elevationMetresOrNull('-99999')).toBeNull();
    expect(elevationMetresOrNull('8848')).toBe(8848);
  });

  it('reads an ordinary decimal', () => {
    expect(elevationMetresOrNull('267')).toBe(267);
    expect(elevationMetresOrNull('267.45')).toBe(267.45);
    expect(elevationMetresOrNull('-4.2')).toBe(-4.2);
    expect(elevationMetresOrNull('+31')).toBe(31);
  });
});

function datasetArtifacts() {
  const sourceHash = 'a'.repeat(64);
  const placeId = '1'.repeat(12);
  const elevationId = '2'.repeat(12);
  const identity = {
    sourceExtractSha256: sourceHash,
    licence: 'ODbL-1.0',
    licenceUrl: ODBL_LICENCE_URL,
    attribution: `Data © OpenStreetMap contributors ${OSM_COPYRIGHT_URL} ${ODBL_LICENCE_URL}`,
  };
  const places = { identity: { ...identity, kind: 'places', datasetId: placeId }, places: [] };
  const elevation = {
    identity: { ...identity, kind: 'elevation', datasetId: elevationId },
    points: [],
  };
  const disclosure = createGeoDatasetDisclosure({
    placesDatasetId: placeId,
    elevationDatasetId: elevationId,
    source: {
      sha256: sourceHash,
      bytes: 234,
      acquisition: {
        sourceId: 'osm-extract-seoul',
        url: 'https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf',
        lastModified: null,
        etag: null,
        recordedBy: 'none',
      },
    },
    scripts: { 'scripts/build-geo-datasets.mjs': 'b'.repeat(64) },
    osmiumVersion: 'osmium version 1.19.1',
  });
  return {
    places,
    elevation,
    disclosure,
    attribution: renderGeoDatasetsAttribution(disclosure),
  };
}

describe('place and elevation distribution ODbL disclosure', () => {
  it('renders an exact notice and alteration method from build inputs', () => {
    const artifacts = datasetArtifacts();
    expect(() => assertGeoDatasetArtifacts(artifacts)).not.toThrow();
    expect(artifacts.attribution).toContain(OSM_COPYRIGHT_URL);
    expect(artifacts.attribution).toContain(ODBL_LICENCE_URL);
    expect(artifacts.attribution).toContain('Last-Modified not recorded (none)');
    expect(artifacts.attribution).toContain('n/ele');
    expect(artifacts.attribution).toContain('scripts/build-geo-datasets.mjs');
  });

  it.each(['places', 'elevation'])('rejects a %s dataset with a missing licence URI', (kind) => {
    const artifacts = datasetArtifacts();
    artifacts[kind].identity.attribution = '© OpenStreetMap contributors';
    expect(() => assertGeoDatasetArtifacts(artifacts)).toThrow('ODBL_NOTICE_MISSING');
  });

  it('rejects an altered licence URI, mismatched identity and stale notice', () => {
    const alteredLicence = datasetArtifacts();
    alteredLicence.disclosure.licence.url = 'https://example.invalid/odbl';
    expect(() => assertGeoDatasetArtifacts(alteredLicence)).toThrow(
      'GEO_DATA_ODBL_DISCLOSURE_INVALID',
    );

    const wrongDataset = datasetArtifacts();
    wrongDataset.elevation.identity.datasetId = 'f'.repeat(12);
    expect(() => assertGeoDatasetArtifacts(wrongDataset)).toThrow(
      'GEO_DATA_ODBL_DISCLOSURE_INVALID',
    );

    const stale = datasetArtifacts();
    stale.attribution += 'stale';
    expect(() => assertGeoDatasetArtifacts(stale)).toThrow('GEO_DATA_ODBL_ATTRIBUTION_STALE');
  });
});
