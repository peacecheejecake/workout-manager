import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  elevationDatasetDocumentSchema,
  placeDatasetDocumentSchema,
} from '@workout/contracts/geo-data';
import {
  createElevationIndex,
  createPlaceIndex,
  type ElevationIndex,
  type PlaceIndex,
} from '@workout/server-courses/geo-data';

/**
 * Loading the self-hosted geo datasets (M2-01j).
 *
 * Both datasets are build artifacts produced by `scripts/build-geo-datasets.mjs` from the
 * same allowlisted regional extract as the basemap and the routing graph. This is the only
 * place the server reads them, it reads them from a configured directory and it reads them
 * once at startup: there is no URL here, no fetch, no fallback to a public endpoint and no
 * way for a request to steer what is loaded.
 *
 * Absence is a supported state. With `GEO_DATA_DIR` unset, or a document that does not
 * satisfy its contract, the index is `null` and the routes answer `no_dataset` — which the
 * screen shows as "this server has no place data", never as "no such place".
 */
export interface GeoDatasets {
  readonly places: PlaceIndex | null;
  readonly elevation: ElevationIndex | null;
}

export const MAX_DATASET_BYTES = 256 * 1024 * 1024;

/**
 * Read one dataset document, refusing an oversized file **before** reading it.
 *
 * The size is taken from the directory entry, not from the bytes. Checking after
 * `readFile` refused nothing that mattered: by then the whole file was already in this
 * process's heap, which is the thing the bound exists to prevent. The file is a deployment
 * artefact rather than user input, so this is a deployment mistake guard — but a guard
 * that only reports a problem it has already caused is not one.
 */
export async function readDatasetDocument(
  path: string,
  maxBytes: number = MAX_DATASET_BYTES,
): Promise<unknown> {
  const entry = await stat(path);
  if (entry.size > maxBytes) throw new Error('GEO_DATASET_TOO_LARGE');
  const bytes = await readFile(path);
  // The entry could have grown between the two calls; the bytes in hand are the ones that
  // count, so the same bound is applied to them as well.
  if (bytes.byteLength > maxBytes) throw new Error('GEO_DATASET_TOO_LARGE');
  // A file at the bound still costs its own size decoded to a string and again as parsed
  // objects, so this number is a deployment sanity limit and not a heap ceiling. That is
  // acceptable because the file is a build artefact of ours read once at startup, never a
  // request payload; a real ceiling would mean streaming the parse, which is work this
  // feature does not need. The number is stated here so the next reader does not mistake
  // it for one.
  return JSON.parse(bytes.toString('utf8'));
}

export async function loadGeoDatasets(directory?: string | undefined): Promise<GeoDatasets> {
  const configured = directory ?? process.env['GEO_DATA_DIR'];
  if (configured === undefined || configured === '') return { places: null, elevation: null };
  const root = resolve(configured);
  let places: PlaceIndex | null = null;
  let elevation: ElevationIndex | null = null;
  try {
    places = createPlaceIndex(
      placeDatasetDocumentSchema.parse(await readDatasetDocument(join(root, 'places.json'))),
    );
  } catch {
    places = null;
  }
  try {
    elevation = createElevationIndex(
      elevationDatasetDocumentSchema.parse(await readDatasetDocument(join(root, 'elevation.json'))),
    );
  } catch {
    elevation = null;
  }
  return { places, elevation };
}
