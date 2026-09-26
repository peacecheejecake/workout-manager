import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadGeoDatasets,
  MAX_DATASET_BYTES,
  readDatasetDocument,
  readGeoDatasetsLicence,
} from '../src/geo-datasets.js';
import {
  mapDataLicence,
  renderGeoDatasetsAttribution,
  type GeoDatasetsDisclosure,
} from '@workout/contracts/map-data-licence';

/**
 * Loading the self-hosted geo datasets (M2-01j).
 *
 * Two things are worth fixing here. Absence and a bad document must be **states**, not
 * failures: with no directory configured, or a file that does not satisfy its contract,
 * the index is `null` and the routes answer `no_dataset` — which the screen shows as "this
 * server has no place data", never as "no such place". And an oversized file must be
 * refused from its directory entry, before its bytes are in this process's heap.
 */
const identity = {
  datasetVersion: 1 as const,
  region: 'Seoul (BBBike city extract)',
  sourceExtractSha256: 'a'.repeat(64),
  licence: 'ODbL-1.0',
  licenceUrl: mapDataLicence.url,
  attribution: `© OpenStreetMap contributors · ${mapDataLicence.copyrightUrl} · ${mapDataLicence.url}`,
  updateCadence: '월 1회',
  builtAt: '2026-09-22T00:00:00.000Z',
  bbox: [126.734, 37.413, 127.269, 37.715],
};
const placesDocument = {
  identity: { ...identity, kind: 'places', datasetId: '0123456789ab', featureCount: 1 },
  places: [
    {
      placeId: 'p1',
      name: '남산',
      localName: 'Namsan',
      kind: 'place:locality',
      position: [126.9882, 37.5512],
    },
  ],
};
const elevationDocument = {
  identity: { ...identity, kind: 'elevation', datasetId: 'beef0123cafe', featureCount: 1 },
  maxSourceDistanceMeters: 150,
  points: [{ position: [126.988, 37.5522], elevationMeters: 267 }],
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workout-geo-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const writeDocument = (name: string, value: unknown) =>
  writeFile(join(directory, name), JSON.stringify(value), 'utf8');

describe('loading the self-hosted geo datasets', () => {
  it('loads both documents when the directory holds them', async () => {
    await writeDocument('places.json', placesDocument);
    await writeDocument('elevation.json', elevationDocument);
    const datasets = await loadGeoDatasets(directory);
    expect(datasets.places?.identity.datasetId).toBe('0123456789ab');
    expect(datasets.elevation?.identity.datasetId).toBe('beef0123cafe');
  });

  it('is absent rather than failing when no directory is configured', async () => {
    expect(await loadGeoDatasets('')).toEqual({ places: null, elevation: null });
  });

  it('is absent rather than failing when the directory holds nothing', async () => {
    expect(await loadGeoDatasets(directory)).toEqual({ places: null, elevation: null });
  });

  it('is absent for a document that does not satisfy its contract, and the other still loads', async () => {
    // A place without a position is not a place. It must not become an empty index that
    // answers "no such place" to every query.
    await writeDocument('places.json', {
      ...placesDocument,
      places: [{ placeId: 'p1', name: '남산', localName: null, kind: 'place:locality' }],
    });
    await writeDocument('elevation.json', elevationDocument);
    const datasets = await loadGeoDatasets(directory);
    expect(datasets.places).toBeNull();
    expect(datasets.elevation).not.toBeNull();
  });

  it('is absent for a file that is not JSON at all', async () => {
    await writeFile(join(directory, 'places.json'), 'not json', 'utf8');
    expect((await loadGeoDatasets(directory)).places).toBeNull();
  });

  it('reads a document at the size bound and refuses one past it', async () => {
    const path = join(directory, 'places.json');
    await writeDocument('places.json', placesDocument);
    const size = Buffer.byteLength(JSON.stringify(placesDocument), 'utf8');
    await expect(readDatasetDocument(path, size)).resolves.toMatchObject({
      identity: { datasetId: '0123456789ab' },
    });
    await expect(readDatasetDocument(path, size - 1)).rejects.toThrow('GEO_DATASET_TOO_LARGE');
  });

  it('refuses an oversized file from its directory entry rather than after reading it', async () => {
    // A sparse file: the directory entry says 5 GiB while it costs no disk. The size is
    // deliberately past `fs.readFile`'s own 2 GiB ceiling, which is what makes the order
    // observable — reading first fails with ERR_FS_FILE_TOO_LARGE, and this bound never
    // gets to say anything. Checking the entry first is what produces our own refusal.
    const path = join(directory, 'places.json');
    await writeFile(path, '{}', 'utf8');
    await truncate(path, 5 * 1024 * 1024 * 1024);
    expect(5 * 1024 * 1024 * 1024).toBeGreaterThan(MAX_DATASET_BYTES);
    await expect(readDatasetDocument(path)).rejects.toThrow('GEO_DATASET_TOO_LARGE');
    // And through the loader it is a state, not a crash.
    expect((await loadGeoDatasets(directory)).places).toBeNull();
  });
});

const disclosure: GeoDatasetsDisclosure = {
  schemaVersion: 1,
  kind: 'geo-datasets',
  licence: mapDataLicence,
  datasets: { placesDatasetId: '0123456789ab', elevationDatasetId: 'beef0123cafe' },
  source: {
    sha256: 'a'.repeat(64),
    bytes: 100,
    acquisition: {
      sourceId: 'osm-extract-seoul',
      url: 'https://download.example/source.osm.pbf',
      lastModified: null,
      etag: null,
      recordedBy: 'none',
    },
  },
  alterationMethod: {
    description: 'Filter named point nodes and explicit ele tags.',
    placeFilters: ['n/place'],
    elevationFilters: ['n/ele'],
    maxElevationSourceDistanceMeters: 150,
    scripts: { 'scripts/build-geo-datasets.mjs': 'b'.repeat(64) },
  },
  toolVersions: { osmium: '1.18', node: 'v24.12.0' },
};

describe('public licence of the loaded geo datasets', () => {
  it('reports pre-disclosure deployments as undisclosed', async () => {
    await writeDocument('places.json', placesDocument);
    await writeDocument('elevation.json', elevationDocument);
    expect(await readGeoDatasetsLicence(await loadGeoDatasets(directory), directory)).toEqual({
      kind: 'undisclosed',
      placesDatasetId: '0123456789ab',
      elevationDatasetId: 'beef0123cafe',
    });
  });

  it('discloses only a sidecar and notice matching both loaded dataset identities', async () => {
    await writeDocument('places.json', placesDocument);
    await writeDocument('elevation.json', elevationDocument);
    await writeDocument('odbl-disclosure.json', disclosure);
    await writeFile(join(directory, 'ATTRIBUTION.txt'), renderGeoDatasetsAttribution(disclosure));
    const datasets = await loadGeoDatasets(directory);
    expect(await readGeoDatasetsLicence(datasets, directory)).toEqual({
      kind: 'disclosed',
      disclosure,
    });

    await writeFile(join(directory, 'ATTRIBUTION.txt'), '© OpenStreetMap contributors');
    expect(await readGeoDatasetsLicence(datasets, directory)).toEqual({ kind: 'unavailable' });
    await writeFile(join(directory, 'ATTRIBUTION.txt'), renderGeoDatasetsAttribution(disclosure));
    await writeDocument('odbl-disclosure.json', {
      ...disclosure,
      datasets: { ...disclosure.datasets, placesDatasetId: 'f'.repeat(12) },
    });
    expect(await readGeoDatasetsLicence(datasets, directory)).toEqual({ kind: 'unavailable' });
  });

  it('refuses a stale method when the loaded elevation lookup distance changes without a new dataset id', async () => {
    await writeDocument('places.json', placesDocument);
    await writeDocument('elevation.json', { ...elevationDocument, maxSourceDistanceMeters: 151 });
    await writeDocument('odbl-disclosure.json', disclosure);
    await writeFile(join(directory, 'ATTRIBUTION.txt'), renderGeoDatasetsAttribution(disclosure));
    expect(await readGeoDatasetsLicence(await loadGeoDatasets(directory), directory)).toEqual({
      kind: 'unavailable',
    });
  });
});
