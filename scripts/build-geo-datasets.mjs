/**
 * M2-01j: build the self-hosted place-search and elevation datasets.
 *
 *   node scripts/build-geo-datasets.mjs --execute [--reuse]
 *
 * Opt-in only, refuses to run in CI, and reads exactly one allowlisted source: the same
 * regional OSM extract the basemap and the routing graph are built from
 * (`scripts/geo/sources.mjs`). There is no geocoding service here, no elevation service and
 * no user-supplied URL — the script takes an allowlist id, never an address.
 *
 * Two datasets come out, into the gitignored `.geo-build/geo-data` directory:
 *
 * - `places.json`: named point features (places, parks, stations, schools, hospitals,
 *   attractions). Korean and English names are both kept, because a search in this region
 *   happens in both.
 * - `elevation.json`: every node in the extract that carries an `ele` tag. This is **not** a
 *   digital elevation model: OSM elevation is sparse, and the number of points this finds is
 *   recorded in the report so nobody can mistake it for terrain coverage. The server treats
 *   a point with no fact within its radius as unknown and never interpolates.
 *
 * Both documents carry an identity — dataset id, the extract's SHA-256, licence, attribution,
 * build time, update cadence, feature count and bounding box — which the API returns with
 * every answer, so "which version of which data said this" is part of the answer.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { allowedSource, fetchAllowedSource, sha256File } from './geo/sources.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/self-hosted-geo-datasets.json',
);

const DATASET_VERSION = 1;
/** How often the operations plan says these are rebuilt. Stated intent, not a promise. */
const UPDATE_CADENCE = '월 1회, basemap·routing graph와 같은 extract에서 함께 빌드';
const ATTRIBUTION = '장소·고도 데이터 © OpenStreetMap contributors (ODbL 1.0)';

const region = {
  id: 'seoul-bbbike',
  name: 'Seoul (BBBike city extract)',
  bbox: [126.734, 37.413, 127.269, 37.715],
};

/**
 * Named point features worth searching for when planning a walk. Nodes only: a way or a
 * relation would need its member geometry to get a centre, and inventing one from a
 * bounding box would put a name at a coordinate nothing states.
 */
const placeFilters = [
  'n/place',
  'n/leisure=park,pitch,sports_centre,stadium,garden',
  'n/amenity=school,university,hospital,library,community_centre',
  'n/railway=station',
  'n/public_transport=station',
  'n/tourism=attraction,museum',
];

/** Elevation facts the extract actually carries. Sparse by nature; measured, not assumed. */
const elevationFilters = ['n/ele'];

/** How far from a vertex an elevation fact may be and still be used for it. */
const MAX_ELEVATION_SOURCE_DISTANCE_METERS = 150;

/** @param {string[]} args */
function parseArguments(args) {
  const allowed = new Set(['--execute', '--reuse']);
  for (const argument of args)
    if (!allowed.has(argument)) throw new Error(`UNKNOWN_ARGUMENT: ${argument}`);
  if (!args.includes('--execute')) return null;
  return { reuse: args.includes('--reuse') };
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(undefined);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function toolVersion(command) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => resolvePromise(null));
    child.on('close', () => resolvePromise(output.split('\n')[0]?.trim() ?? null));
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one GeoJSONSeq file line by line. The whole file is never held in memory at once,
 * and a line that is not a positioned feature is skipped rather than guessed at.
 *
 * @param {string} path
 * @param {(feature: {geometry: {type: string, coordinates: number[]}, properties: Record<string, string>, id?: unknown}) => void} onFeature
 */
async function readFeatures(path, onFeature) {
  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of stream) {
    // GeoJSON text sequences prefix every record with RS (U+001E). Leaving it in makes
    // every line unparseable and the dataset silently empty, which is exactly what the
    // first run of this script produced.
    // RS (U+001E), stripped by code point rather than by a regular expression so the
    // control character never has to appear in one.
    const record = (line.codePointAt(0) === 0x1e ? line.slice(1) : line).trim();
    if (record === '') continue;
    let feature;
    try {
      feature = JSON.parse(record);
    } catch {
      continue;
    }
    if (feature?.geometry?.type !== 'Point') continue;
    const coordinates = feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    if (!Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) continue;
    onFeature(feature);
  }
}

/** Text from OSM is untrusted: control characters and angle brackets never reach a screen. */
function safeText(value) {
  if (typeof value !== 'string') return null;
  let cleaned = '';
  for (const character of value.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e)) continue;
    cleaned += character;
  }
  cleaned = cleaned.trim();
  if (cleaned === '' || cleaned.includes('<') || cleaned.includes('>')) return null;
  return cleaned.slice(0, 120);
}

/** What kind of thing the source called it, as `key:value`. */
function featureKind(properties) {
  for (const key of ['place', 'railway', 'public_transport', 'leisure', 'amenity', 'tourism']) {
    const value = properties[key];
    if (typeof value === 'string' && value !== '') return `${key}:${value}`.slice(0, 64);
  }
  return 'place:unknown';
}

/**
 * An `ele` tag as a number of metres, or `null`.
 *
 * `ele` is free text in OSM. `Number('')` and `Number('   ')` are **0**, so an empty tag
 * used to be stored as a known sea-level elevation and then reported to a reader as a
 * measured value — the exact "missing became a known value" mistake this dataset's own
 * policy exists to prevent. Only a plain decimal number of metres is accepted; a value
 * with a unit, a comma, a range or an exponent is dropped rather than coerced, because a
 * wrong elevation is worse than a missing one.
 *
 * @param {unknown} raw
 */
export function elevationMetresOrNull(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < -12_000 || value > 12_000) return null;
  return value;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node scripts/build-geo-datasets.mjs --execute [--reuse]. Builds the self-hosted place and elevation datasets from one allowlisted regional OSM extract into .geo-build/geo-data. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Geo dataset builds are disabled in CI');

  const sourceDirectory = join(workRoot, 'source');
  const stageDirectory = join(workRoot, 'geo-data-stage');
  const outputDirectory = join(workRoot, 'geo-data');
  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });

  const extractPath = join(sourceDirectory, 'region.osm.pbf');
  const source = allowedSource('osm-extract-seoul');
  let download;
  if (options.reuse && (await exists(extractPath))) {
    const info = await stat(extractPath);
    download = {
      sourceId: source.id,
      url: null,
      bytes: info.size,
      sha256: await sha256File(extractPath),
      reusedFromDisk: true,
    };
  } else {
    download = {
      ...(await fetchAllowedSource({ id: source.id, destination: extractPath })),
      reusedFromDisk: false,
    };
  }

  const osmiumVersion = await toolVersion('osmium');
  const steps = [];

  /** @param {string} name @param {string[]} filters */
  async function extract(name, filters) {
    const started = performance.now();
    const filtered = join(stageDirectory, `${name}.osm.pbf`);
    const exported = join(stageDirectory, `${name}.geojsonseq`);
    // `-R` keeps referenced nodes out: we want the tagged nodes themselves, not the
    // geometry of anything that mentions them.
    await run('osmium', [
      'tags-filter',
      '-R',
      '--overwrite',
      '-o',
      filtered,
      extractPath,
      ...filters,
    ]);
    await run('osmium', ['export', '-f', 'geojsonseq', '--overwrite', '-o', exported, filtered]);
    steps.push({
      step: name,
      command: `osmium tags-filter -R ${filters.join(' ')} | osmium export`,
      durationMs: Math.round(performance.now() - started),
    });
    return exported;
  }

  const placeSeq = await extract('places', placeFilters);
  const elevationSeq = await extract('elevation', elevationFilters);

  /** @type {{placeId: string, name: string, localName: string | null, kind: string, position: [number, number]}[]} */
  const places = [];
  let placeFeatures = 0;
  let placesWithoutName = 0;
  await readFeatures(placeSeq, (feature) => {
    placeFeatures += 1;
    const properties = feature.properties ?? {};
    const primary =
      safeText(properties['name']) ??
      safeText(properties['name:ko']) ??
      safeText(properties['name:en']);
    if (primary === null) {
      placesWithoutName += 1;
      return;
    }
    const english = safeText(properties['name:en']);
    const localName = english !== null && english !== primary ? english : null;
    const identity = `${feature.id ?? ''}|${primary}|${feature.geometry.coordinates.join(',')}`;
    places.push({
      placeId: createHash('sha256').update(identity).digest('hex').slice(0, 24),
      name: primary,
      localName,
      kind: featureKind(properties),
      position: [
        round(feature.geometry.coordinates[0], 7),
        round(feature.geometry.coordinates[1], 7),
      ],
    });
  });

  /** @type {{position: [number, number], elevationMeters: number}[]} */
  const elevationPoints = [];
  let elevationFeatures = 0;
  let unparsableElevations = 0;
  await readFeatures(elevationSeq, (feature) => {
    elevationFeatures += 1;
    const value = elevationMetresOrNull(feature.properties?.['ele']);
    if (value === null) {
      unparsableElevations += 1;
      return;
    }
    elevationPoints.push({
      position: [
        round(feature.geometry.coordinates[0], 7),
        round(feature.geometry.coordinates[1], 7),
      ],
      elevationMeters: round(value, 2),
    });
  });

  const builtAt = new Date().toISOString();
  /** @param {'places' | 'elevation'} kind @param {number} featureCount @param {string[]} filters */
  const identity = (kind, featureCount, filters) => ({
    kind,
    datasetId: createHash('sha256')
      .update(
        JSON.stringify([kind, DATASET_VERSION, download.sha256, region.id, filters, osmiumVersion]),
      )
      .digest('hex')
      .slice(0, 12),
    datasetVersion: DATASET_VERSION,
    region: region.name,
    sourceExtractSha256: download.sha256,
    licence: source.license,
    licenceUrl: source.licenseUrl,
    attribution: ATTRIBUTION,
    updateCadence: UPDATE_CADENCE,
    builtAt,
    featureCount,
    bbox: region.bbox,
  });

  const placeDocument = {
    identity: identity('places', places.length, placeFilters),
    places,
  };
  const elevationDocument = {
    identity: identity('elevation', elevationPoints.length, elevationFilters),
    maxSourceDistanceMeters: MAX_ELEVATION_SOURCE_DISTANCE_METERS,
    points: elevationPoints,
  };

  await writeFile(join(stageDirectory, 'places.json'), JSON.stringify(placeDocument));
  await writeFile(join(stageDirectory, 'elevation.json'), JSON.stringify(elevationDocument));
  // Intermediates are not part of the dataset directory the server reads.
  for (const name of [
    'places.osm.pbf',
    'places.geojsonseq',
    'elevation.osm.pbf',
    'elevation.geojsonseq',
  ])
    await rm(join(stageDirectory, name), { force: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await rename(stageDirectory, outputDirectory);

  const placeBytes = (await stat(join(outputDirectory, 'places.json'))).size;
  const elevationBytes = (await stat(join(outputDirectory, 'elevation.json'))).size;
  const report = {
    executedAt: builtAt,
    node: process.version,
    osmiumVersion,
    source: {
      id: source.id,
      license: source.license,
      sha256: download.sha256,
      bytes: download.bytes,
      reusedFromDisk: download.reusedFromDisk,
    },
    region,
    steps,
    places: {
      datasetId: placeDocument.identity.datasetId,
      matchedFeatures: placeFeatures,
      withoutUsableName: placesWithoutName,
      stored: places.length,
      bytes: placeBytes,
    },
    elevation: {
      datasetId: elevationDocument.identity.datasetId,
      matchedFeatures: elevationFeatures,
      unparsableValues: unparsableElevations,
      stored: elevationPoints.length,
      bytes: elevationBytes,
      maxSourceDistanceMeters: MAX_ELEVATION_SOURCE_DISTANCE_METERS,
      // Stated plainly, because the number is small and the conclusion matters: OSM `ele`
      // tags are not terrain. Coverage of an arbitrary course is expected to be near zero.
      note: 'OSM ele tags, not a digital elevation model. Sparse by nature; unknown is the normal answer.',
    },
    outputDirectory: '.geo-build/geo-data',
  };
  let history = [];
  if (await exists(reportPath)) {
    try {
      const previous = JSON.parse(await readFile(reportPath, 'utf8'));
      history = Array.isArray(previous.previousRuns) ? previous.previousRuns : [];
      const last = { ...previous };
      delete last.previousRuns;
      history = [last, ...history].slice(0, 5);
    } catch {
      history = [];
    }
  }
  await writeFile(reportPath, `${JSON.stringify({ ...report, previousRuns: history }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

// Only when run as a script. Importing this file for its helpers must not build anything.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
