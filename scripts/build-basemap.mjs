/**
 * M2-01d: build a self-hosted vector basemap from a permitted regional OSM extract.
 *
 *   node scripts/build-basemap.mjs --execute [--reuse]
 *
 * Opt-in only, refuses to run in CI, and fetches only allowlisted URLs (see
 * scripts/geo/sources.mjs). Everything it writes lands in the gitignored `.geo-build`
 * directory; only the measurement manifest is committed.
 *
 * Pipeline: osmium tags-filter -> osmium export (GeoJSONSeq) -> tippecanoe (MBTiles)
 * -> static gzip-encoded XYZ pyramid + style + glyphs + sprite + attribution.
 *
 * The manifest is written with JSON.stringify, whose short-array layout differs from
 * Prettier's; run `pnpm format` after a build before committing the manifest.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fetchAllowedSource, sha256File } from './geo/sources.mjs';
import { drawCircle, encodePng } from './geo/png.mjs';
import { assertSelfHostedStyle, createBasemapStyle, fontStack } from './geo/style.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/self-hosted-basemap-build.json',
);

/** Seoul city extract: the smallest permitted region that still exercises Korean data. */
const region = {
  id: 'seoul-bbbike',
  name: 'Seoul (BBBike city extract)',
  bounds: /** @type {[number, number, number, number]} */ ([126.734, 37.413, 127.269, 37.715]),
  center: /** @type {[number, number]} */ ([126.9779, 37.5663]),
  minzoom: 9,
  maxzoom: 15,
};

const attribution =
  '지도 데이터 © OpenStreetMap contributors (ODbL 1.0) · 자체 생성 타일 · <a href="https://www.openstreetmap.org/copyright">라이선스</a>';
/** Same obligation without markup, for surfaces that render text rather than HTML. */
const attributionText =
  '지도 데이터 © OpenStreetMap contributors (ODbL 1.0) · 자체 생성 타일 · https://www.openstreetmap.org/copyright';

/** Layer name -> osmium tags-filter expressions. One extract pass per rendered layer. */
const layerFilters = [
  { layer: 'roads', expressions: ['w/highway'] },
  { layer: 'water', expressions: ['nwr/natural=water', 'nwr/waterway', 'nwr/landuse=reservoir'] },
  { layer: 'structures', expressions: ['nwr/building', 'nwr/leisure=park', 'nwr/landuse'] },
];

const glyphRanges = ['0-255', '256-511', '8192-8447'];

/** @param {string[]} args */
export function parseArguments(args) {
  const allowed = new Set(['--execute', '--reuse']);
  let basePath = '/map/basemap';
  for (const argument of args) {
    if (allowed.has(argument)) continue;
    const match = /^--base-path=(\/[A-Za-z0-9/_-]{1,120})$/.exec(argument);
    // MapLibre requires an absolute sprite URL, so the serving prefix is fixed at build
    // time. It must stay a same-origin path: no scheme, no host, no traversal.
    if (!match || match[1].includes('//') || match[1].split('/').includes('..')) return null;
    basePath = match[1].replace(/\/$/, '');
  }
  if (!args.includes('--execute')) return null;
  return { reuse: args.includes('--reuse'), basePath };
}

/**
 * Run one build command, capturing wall time and (on macOS) peak RSS via /usr/bin/time.
 * stderr is bounded because tippecanoe streams progress.
 * @param {string} label @param {string} command @param {string[]} args
 */
async function measured(label, command, args) {
  const wrapped = process.platform === 'darwin';
  const file = wrapped ? '/usr/bin/time' : command;
  const argv = wrapped ? ['-l', command, ...args] : args;
  const started = performance.now();
  const child = spawn(file, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    tail = `${tail}${chunk}`.slice(-16384);
  });
  const code = await new Promise((resolveCode, rejectSpawn) => {
    child.on('error', rejectSpawn);
    child.on('close', resolveCode);
  });
  const durationMs = Math.round(performance.now() - started);
  if (code !== 0) throw new Error(`${label} failed with exit ${code}: ${tail.slice(-2000)}`);
  const peak = /(\d+)\s+maximum resident set size/.exec(tail);
  return {
    step: label,
    command,
    durationMs,
    peakRssBytes: peak ? Number(peak[1]) : null,
  };
}

/** @param {string} path */
async function directoryBytes(path) {
  let total = 0;
  let files = 0;
  const walk = async (/** @type {string} */ current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else {
        const info = await stat(next);
        total += info.size;
        files += 1;
      }
    }
  };
  await walk(path);
  return { bytes: total, files };
}

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * MBTiles stores TMS rows; the served pyramid uses XYZ. Tiles stay gzip-compressed and
 * the serving layer must send `Content-Encoding: gzip`.
 * @param {string} mbtilesPath @param {string} tileRoot
 */
function extractPyramid(mbtilesPath, tileRoot) {
  const database = new DatabaseSync(mbtilesPath, { readOnly: true });
  try {
    const metadata = Object.fromEntries(
      database
        .prepare('select name, value from metadata')
        .all()
        .map((row) => [row.name, row.value]),
    );
    const rows = database
      .prepare(
        'select zoom_level as z, tile_column as x, tile_row as y, tile_data as data from tiles',
      )
      .iterate();
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
      const z = Number(row.z);
      const x = Number(row.x);
      const y = 2 ** z - 1 - Number(row.y);
      const directory = join(tileRoot, String(z), String(x));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${y}.pbf`), row.data);
      count += 1;
      bytes += row.data.length;
    }
    return { tileCount: count, tileBytes: bytes, metadata };
  } finally {
    database.close();
  }
}

/** @param {string} spriteRoot */
async function writeSprite(spriteRoot) {
  const icons = [
    { id: 'park-dot', fill: /** @type {[number,number,number]} */ ([108, 158, 108]) },
    { id: 'marker-dot', fill: /** @type {[number,number,number]} */ ([98, 86, 184]) },
  ];
  /** @type {Record<string, unknown>} */
  const index = {};
  for (const pixelRatio of [1, 2]) {
    const size = 16 * pixelRatio;
    const width = size * icons.length;
    const rgba = new Uint8Array(width * size * 4);
    icons.forEach((icon, position) => {
      drawCircle({
        rgba,
        sheetWidth: width,
        x: position * size,
        y: 0,
        size,
        fill: icon.fill,
        ring: [255, 255, 255],
      });
      if (pixelRatio === 1) {
        index[icon.id] = {
          x: position * size,
          y: 0,
          width: size,
          height: size,
          pixelRatio: 1,
          sdf: false,
        };
      }
    });
    const suffix = pixelRatio === 1 ? '' : '@2x';
    await writeFile(`${spriteRoot}${suffix}.png`, encodePng(width, size, rgba));
    if (pixelRatio === 2) {
      const retina = Object.fromEntries(
        icons.map((icon, position) => [
          icon.id,
          { x: position * size, y: 0, width: size, height: size, pixelRatio: 2, sdf: false },
        ]),
      );
      await writeFile(`${spriteRoot}@2x.json`, `${JSON.stringify(retina, null, 2)}\n`);
    }
  }
  await writeFile(`${spriteRoot}.json`, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * A staged build is only publishable when every artifact the style references exists and
 * is non-empty. Without this, a failed glyph download would publish a broken basemap.
 * @param {string} stagingRoot @param {number} tileCount
 */
export async function verifyStagedBuild(stagingRoot, tileCount) {
  if (tileCount === 0) throw new Error('STAGED_BUILD_HAS_NO_TILES');
  const style = JSON.parse(await readFile(join(stagingRoot, 'style.json'), 'utf8'));
  assertSelfHostedStyle(style);
  const required = [
    'style.json',
    'tiles.json',
    'ATTRIBUTION.txt',
    'sprite.json',
    'sprite.png',
    'sprite@2x.json',
    'sprite@2x.png',
    join('glyphs', 'OFL.txt'),
    ...glyphRanges.map((range) => join('glyphs', fontStack, `${range}.pbf`)),
  ];
  for (const entry of required) {
    // A missing artifact and an empty one are the same defect to the reader of the map.
    const info = await stat(join(stagingRoot, entry)).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`STAGED_BUILD_INCOMPLETE: ${entry}`);
  }
}

/**
 * Exclusive lock over the distribution directory.
 *
 * Publishing, the pointer write and pruning must be one critical section: otherwise a
 * concurrent build can flip the pointer between another build's publish and its prune,
 * and that prune then deletes the live deployment.
 *
 * @param {string} distributionRoot
 * @param {() => Promise<T>} body
 * @template T
 */
export async function withDistributionLock(distributionRoot, body) {
  const lockPath = join(distributionRoot, '.publish.lock');
  await mkdir(distributionRoot, { recursive: true });
  try {
    // `wx` fails if the file exists: no lost-update window.
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, {
      flag: 'wx',
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('DISTRIBUTION_LOCKED: another publish is in progress');
    throw error;
  }
  try {
    return await body();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/** @param {string} distributionRoot */
async function readPointer(distributionRoot) {
  try {
    const pointer = JSON.parse(await readFile(join(distributionRoot, 'current.json'), 'utf8'));
    return typeof pointer.deploymentId === 'string' ? pointer : null;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * Publish with a single rename into a directory that has never existed, flip the pointer,
 * then prune — all inside one lock, with the pointer re-read inside it.
 *
 * A deployment directory is immutable: it is never replaced, so there is no window in
 * which the deployed path is missing and no way for a crash to leave a half-swapped
 * copy. Two builds of identical content simply get two deployment ids. Rollback is a
 * pointer rewrite to `previousDeploymentId`, whose directory still holds the old bytes —
 * which is only meaningful because that id is distinct from the new one.
 *
 * @param {{ distributionRoot: string, stagingRoot: string, deploymentId: string, buildId: string, prune?: boolean }} options
 */
export async function publishStagedBuild({
  distributionRoot,
  stagingRoot,
  deploymentId,
  buildId,
  prune = true,
}) {
  return withDistributionLock(distributionRoot, async () => {
    const publishRoot = join(distributionRoot, deploymentId);
    if (await exists(publishRoot))
      throw new Error(`DEPLOYMENT_ID_ALREADY_PUBLISHED: ${deploymentId}`);
    // Read inside the lock: a pointer read before acquiring it can already be stale.
    const previous = await readPointer(distributionRoot);
    const previousDeploymentId = previous?.deploymentId ?? null;
    // One rename. Nothing that is currently served is touched.
    await rename(stagingRoot, publishRoot);
    const pointer = {
      deploymentId,
      buildId,
      publishedAt: new Date().toISOString(),
      previousDeploymentId,
      rollback:
        'Rewrite current.json with previousDeploymentId; that directory is untouched and holds the previous bytes.',
    };
    const pointerPath = join(distributionRoot, 'current.json');
    const temporary = `${pointerPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`);
    await rename(temporary, pointerPath);
    const prunedDeployments = prune ? await pruneLocked(distributionRoot) : [];
    return { ...pointer, prunedDeployments };
  });
}

/**
 * Keep whatever the CURRENT pointer names plus its previous deployment, and remove older
 * ones. Never trust a pointer handed in by the caller: by the time pruning runs it may
 * describe a deployment that is no longer live. Dot-prefixed entries (another build's
 * staging directory, the lock file) are left alone.
 *
 * @param {string} distributionRoot
 */
async function pruneLocked(distributionRoot) {
  const pointer = await readPointer(distributionRoot);
  if (!pointer) return [];
  const keep = new Set([pointer.deploymentId, pointer.previousDeploymentId].filter(Boolean));
  const removed = [];
  for (const entry of await readdir(distributionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || keep.has(entry.name)) continue;
    await rm(join(distributionRoot, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Prune on its own, taking the same lock and re-reading the pointer inside it.
 * @param {string} distributionRoot
 */
export async function pruneDeployments(distributionRoot) {
  return withDistributionLock(distributionRoot, () => pruneLocked(distributionRoot));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node scripts/build-basemap.mjs --execute [--reuse] [--base-path=/map/basemap]. Downloads one allowlisted regional OSM extract and builds self-hosted tiles/style/glyphs/sprite into .geo-build. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Basemap builds are disabled in CI');

  const sourceDirectory = join(workRoot, 'source');
  const stageDirectory = join(workRoot, 'stage');
  await mkdir(stageDirectory, { recursive: true });
  /** @type {{ step: string, command: string, durationMs: number, peakRssBytes: number | null }[]} */
  const steps = [];

  const extractPath = join(sourceDirectory, 'region.osm.pbf');
  let download;
  if (options.reuse && (await exists(extractPath))) {
    const info = await stat(extractPath);
    download = {
      sourceId: 'osm-extract-seoul',
      url: null,
      bytes: info.size,
      sha256: await sha256File(extractPath),
      reusedFromDisk: true,
    };
  } else {
    const started = performance.now();
    download = {
      ...(await fetchAllowedSource({ id: 'osm-extract-seoul', destination: extractPath })),
      reusedFromDisk: false,
    };
    steps.push({
      step: 'download-extract',
      command: 'curl',
      durationMs: Math.round(performance.now() - started),
      peakRssBytes: null,
    });
  }

  /** @type {{ file: string, layer: string }[]} */
  const layerInputs = [];
  for (const { layer, expressions } of layerFilters) {
    const filtered = join(stageDirectory, `${layer}.osm.pbf`);
    const geojson = join(stageDirectory, `${layer}.geojsons`);
    await rm(filtered, { force: true });
    await rm(geojson, { force: true });
    steps.push(
      await measured(`tags-filter:${layer}`, 'osmium', [
        'tags-filter',
        '--overwrite',
        '--output',
        filtered,
        extractPath,
        ...expressions,
      ]),
    );
    steps.push(
      await measured(`export:${layer}`, 'osmium', [
        'export',
        '--overwrite',
        '--output-format',
        'geojsonseq',
        '--add-unique-id',
        'type_id',
        '--output',
        geojson,
        filtered,
      ]),
    );
    layerInputs.push({ file: geojson, layer });
  }

  const mbtilesPath = join(stageDirectory, 'basemap.mbtiles');
  const tippecanoeArguments = [
    '--force',
    '--output',
    mbtilesPath,
    '--minimum-zoom',
    String(region.minzoom),
    '--maximum-zoom',
    String(region.maxzoom),
    '--drop-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    '--name',
    'workout-manager-basemap',
    '--attribution',
    attribution,
    '--quiet',
    ...layerInputs.map(
      ({ file, layer }) => `-L{"file":${JSON.stringify(file)},"layer":"${layer}"}`,
    ),
  ];
  steps.push(await measured('tippecanoe', 'tippecanoe', tippecanoeArguments));

  const toolVersions = {
    osmium: await commandVersion('osmium', ['--version']),
    tippecanoe: await commandVersion('tippecanoe', ['--version']),
    node: process.version,
  };
  const buildId = createHash('sha256')
    .update(
      JSON.stringify({
        extract: download.sha256,
        region,
        layerFilters,
        toolVersions,
        // The serving prefix is baked into style.json and tiles.json, so content built
        // for a different prefix must not be able to claim the same immutable path.
        basePath: options.basePath,
        styleRevision: 1,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  // Build into a staging directory, verify it, then publish it into a deployment
  // directory that has never existed and flip the pointer. Nothing already deployed is
  // ever replaced, so a failure part way through cannot damage it.
  const distributionRoot = join(workRoot, 'dist');
  const deploymentId = `${buildId}-${Date.now().toString(36)}`;
  const publishRoot = join(distributionRoot, deploymentId);
  const stagingRoot = join(distributionRoot, `.staging-${deploymentId}-${process.pid}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, 'tiles'), { recursive: true });
  const pyramidStarted = performance.now();
  const pyramid = extractPyramid(mbtilesPath, join(stagingRoot, 'tiles'));
  steps.push({
    step: 'extract-pyramid',
    command: 'node:sqlite',
    durationMs: Math.round(performance.now() - pyramidStarted),
    peakRssBytes: null,
  });

  const glyphDirectory = join(stagingRoot, 'glyphs', fontStack);
  /** @type {{ range: string, bytes: number, sha256: string }[]} */
  const glyphs = [];
  for (const range of glyphRanges) {
    const result = await fetchAllowedSource({
      id: 'glyphs-noto-sans-regular',
      destination: join(glyphDirectory, `${range}.pbf`),
      range,
    });
    glyphs.push({ range, bytes: result.bytes, sha256: result.sha256 });
  }
  const glyphLicense = await fetchAllowedSource({
    id: 'glyphs-noto-sans-license',
    destination: join(stagingRoot, 'glyphs', 'OFL.txt'),
  });

  await writeSprite(join(stagingRoot, 'sprite'));

  const style = createBasemapStyle({
    basePath: `${options.basePath}/${deploymentId}`,
    attribution,
    minzoom: region.minzoom,
    maxzoom: region.maxzoom,
    bounds: region.bounds,
    center: region.center,
  });
  assertSelfHostedStyle(style);
  await writeFile(join(stagingRoot, 'style.json'), `${JSON.stringify(style, null, 2)}\n`);
  await writeFile(
    join(stagingRoot, 'tiles.json'),
    `${JSON.stringify(
      {
        tilejson: '3.0.0',
        name: 'workout-manager-basemap',
        tiles: [`${options.basePath}/${deploymentId}/tiles/{z}/{x}/{y}.pbf`],
        minzoom: region.minzoom,
        maxzoom: region.maxzoom,
        bounds: region.bounds,
        attribution,
        attributionText,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(stagingRoot, 'ATTRIBUTION.txt'),
    [
      'Background map tiles built by Workout Manager from an OpenStreetMap extract.',
      'Map data © OpenStreetMap contributors, licensed ODbL 1.0 (https://www.openstreetmap.org/copyright).',
      'Produced tiles are a derived database; ODbL attribution and share-alike apply to redistribution.',
      'Label glyphs: Noto Sans, SIL Open Font License 1.1 (see glyphs/OFL.txt).',
      'Sprite icons generated by this repository; no third-party asset.',
      '',
    ].join('\n'),
  );

  // Verify the staged build before anything deployed is touched.
  await verifyStagedBuild(stagingRoot, pyramid.tileCount);
  const { prunedDeployments, ...publish } = await publishStagedBuild({
    distributionRoot,
    stagingRoot,
    deploymentId,
    buildId,
  });
  const published = await directoryBytes(publishRoot);
  const mbtilesInfo = await stat(mbtilesPath);
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope:
      'M2-01d preparation build on a developer machine. Not a production deployment and not an operations acceptance.',
    buildId,
    deploymentId,
    basePath: options.basePath,
    publish,
    prunedDeployments,
    region,
    source: download,
    toolVersions,
    steps,
    artifacts: {
      mbtilesBytes: mbtilesInfo.size,
      publishedBytes: published.bytes,
      publishedFiles: published.files,
      tileCount: pyramid.tileCount,
      tileBytes: pyramid.tileBytes,
      tileEncoding: 'gzip (MBTiles native); serving layer must send Content-Encoding: gzip',
      glyphs,
      glyphLicenseSha256: glyphLicense.sha256,
      mbtilesMetadataKeys: Object.keys(pyramid.metadata).sort(),
    },
    // ODbL 4.6: the method used to alter the source database, recorded per run so a
    // distribution can publish it instead of the derived database itself.
    alterationMethod: {
      description:
        'Layer-by-layer osmium tag filter and GeoJSONSeq export, then tippecanoe into MBTiles, then a static XYZ pyramid. Applied to the extract identified in `source`.',
      layerFilters,
      osmiumExportFormat: 'geojsonseq (--add-unique-id=type_id)',
      // The full invocation, with the machine-specific staging directory replaced by a
      // placeholder so the record is reproducible rather than local.
      tippecanoeArguments: tippecanoeArguments.map((argument) =>
        argument.split(stageDirectory).join('<stage>'),
      ),
      tippecanoeLayers: layerInputs.map(({ layer }) => layer),
      minzoom: region.minzoom,
      maxzoom: region.maxzoom,
      glyphRanges,
      scripts: await scriptHashes(),
    },
    licenses: {
      osmData: 'ODbL-1.0',
      glyphs: 'OFL-1.1',
      sprite: 'generated in-repository',
      tippecanoe: 'BSD-2-Clause',
      osmium: 'GPL-3.0-or-later (build-time tool only, not redistributed)',
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    interpretation:
      'Build feasibility, size and cost evidence only. Cartographic quality, Korean pedestrian coverage and production serving are not established here.',
  };

  await writeReport(report);
  console.log(
    JSON.stringify({
      buildId,
      deploymentId,
      publish,
      tiles: pyramid.tileCount,
      publishedBytes: published.bytes,
      totalDurationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
    }),
  );
}

/**
 * SHA-256 of the scripts that define the alteration, so a published method is pinned to
 * the code that produced it rather than to a description of it.
 */
async function scriptHashes() {
  const files = ['build-basemap.mjs', 'geo/style.mjs', 'geo/sources.mjs', 'geo/png.mjs'];
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const file of files) {
    hashes[`scripts/${file}`] = await sha256File(join(repositoryRoot, 'scripts', file));
  }
  return hashes;
}

/** @param {string} command @param {string[]} args */
async function commandVersion(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(0, 2048);
  });
  child.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(0, 2048);
  });
  await new Promise((done) => child.on('close', done));
  return output.split('\n')[0].trim() || null;
}

/** @param {Record<string, unknown>} report */
async function writeReport(report) {
  const previousRuns = [];
  try {
    const previous = JSON.parse(await readFile(reportPath, 'utf8'));
    const { previousRuns: history = [], ...lastRun } = previous;
    if (!Array.isArray(history) || typeof lastRun.executedAt !== 'string')
      throw new Error('INVALID_PREVIOUS_REPORT');
    previousRuns.push(...history, lastRun);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...report, previousRuns }, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, reportPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
