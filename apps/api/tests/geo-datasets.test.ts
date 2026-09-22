import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadGeoDatasets, MAX_DATASET_BYTES, readDatasetDocument } from '../src/geo-datasets.js';

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
  licenceUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
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
