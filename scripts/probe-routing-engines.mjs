/**
 * M2-01d: build and measure self-hosted pedestrian routing engine candidates.
 *
 *   node scripts/probe-routing-engines.mjs --execute [--engine=osrm|graphhopper]
 *
 * Opt-in only, refuses to run in CI. It never calls a public routing service: every
 * request goes to a loopback server this script started from a graph it built from the
 * extract already downloaded by scripts/build-basemap.mjs. Valhalla is not built here
 * (no bottle and no container runtime on this machine) and is reported as not executed.
 *
 * A computed route is evidence that the engine answered, not evidence that the way is
 * walkable. Every case stays `coverageReview: "not_reviewed"`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  allowedSource,
  fetchAllowedSource,
  sha256File,
  verifyAllowedSourceFile,
} from './geo/sources.mjs';
import { graphhopperJavaArguments } from './geo/graphhopper-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/routing-engine-measurements.json',
);
const osrmProfile = '/opt/homebrew/share/osrm/profiles/foot.lua';

/** Fixed public synthetic pedestrian cases. No personal GPS, no user input path. */
const cases = [
  {
    id: 'KR-WALK-01',
    kind: 'route',
    context: 'Gwanghwamun to Seoul City Hall; dense urban footways and crossings',
    points: [
      [126.9769, 37.5759],
      [126.9779, 37.5663],
    ],
  },
  {
    id: 'KR-WALK-02',
    kind: 'route',
    context: 'Han river crossing near Yeouido; requires a bridge with a pedestrian way',
    points: [
      [126.93, 37.525],
      [126.932, 37.537],
    ],
  },
  {
    id: 'KR-WALK-03',
    kind: 'route',
    context: 'Namsan park slope; stair and park path handling',
    points: [
      [126.9883, 37.5512],
      [126.98, 37.556],
    ],
  },
  {
    id: 'NEG-WALK-01',
    kind: 'route',
    negativeControl: true,
    context: 'Yellow Sea coordinates far outside the extract; a computed route would be a defect',
    points: [
      [125.5, 36.5],
      [125.52, 36.52],
    ],
  },
  {
    id: 'ROUNDTRIP-01',
    kind: 'round-trip',
    context: 'Target-distance loop from Gwanghwamun, 5 km',
    points: [[126.9769, 37.5759]],
    targetDistanceMeters: 5000,
    seed: 1,
  },
];

/** @param {string[]} args */
export function parseArguments(args) {
  const engines = ['osrm', 'graphhopper'];
  let selected = engines;
  for (const argument of args) {
    if (argument === '--execute') continue;
    const match = /^--engine=(osrm|graphhopper)$/.exec(argument);
    if (!match) return null;
    selected = [match[1]];
  }
  if (!args.includes('--execute')) return null;
  return { engines: selected };
}

/** @param {string} label @param {string} command @param {string[]} args @param {string} [cwd] */
async function measured(label, command, args, cwd) {
  const wrapped = process.platform === 'darwin';
  const file = wrapped ? '/usr/bin/time' : command;
  const argv = wrapped ? ['-l', command, ...args] : args;
  const started = performance.now();
  const child = spawn(file, argv, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    tail = `${tail}${chunk}`.slice(-16384);
  });
  const code = await new Promise((done, failed) => {
    child.on('error', failed);
    child.on('close', done);
  });
  if (code !== 0) throw new Error(`${label} failed with exit ${code}: ${tail.slice(-2000)}`);
  const peak = /(\d+)\s+maximum resident set size/.exec(tail);
  return {
    step: label,
    durationMs: Math.round(performance.now() - started),
    peakRssBytes: peak ? Number(peak[1]) : null,
  };
}

/** @param {string} path */
async function directoryBytes(path) {
  let total = 0;
  const walk = async (/** @type {string} */ current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else total += (await stat(next)).size;
    }
  };
  await walk(path);
  return total;
}

/** @param {number} pid */
async function residentBytes(pid) {
  const child = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await new Promise((done) => child.on('close', done));
  const kilobytes = Number.parseInt(output.trim(), 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/** @param {number} milliseconds */
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Loopback-only request with a hard timeout and a response ceiling.
 * @param {string} url
 */
async function loopbackJson(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') throw new Error('NON_LOOPBACK_REQUEST');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = (await response.text()).slice(0, 4 * 1024 * 1024);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      httpStatus: response.status,
      body,
      latencyMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {() => Promise<boolean>} check */
async function waitForReady(check, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await wait(500);
  }
  return false;
}

/**
 * Real version string from the installed binary, not a constant in this file.
 * @param {string} command @param {string[]} args
 */
async function commandVersion(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const collect = (/** @type {NodeJS.ReadableStream} */ stream) =>
    stream.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(0, 2048);
    });
  collect(child.stdout);
  collect(child.stderr);
  await new Promise((done) => child.on('close', done));
  return output.split('\n')[0].trim() || null;
}

function geometryDigest(coordinates) {
  return createHash('sha256').update(JSON.stringify(coordinates)).digest('hex');
}

async function measureOsrm() {
  const directory = join(workRoot, 'osrm');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const local = join(directory, 'region.osm.pbf');
  await copyFile(extractPath, local);
  const base = join(directory, 'region.osrm');
  const identity = {
    // Every identity fact is measured in this run, not copied from another file.
    extractSha256: await sha256File(extractPath),
    profilePath: osrmProfile,
    profileSha256: await sha256File(osrmProfile),
    extractBinaryVersion: await commandVersion('osrm-extract', ['--version']),
    routedBinaryVersion: await commandVersion('osrm-routed', ['--version']),
  };
  const steps = [
    await measured('osrm-extract', 'osrm-extract', ['-p', osrmProfile, local], directory),
    await measured('osrm-partition', 'osrm-partition', [base], directory),
    await measured('osrm-customize', 'osrm-customize', [base], directory),
  ];
  await rm(local, { force: true });
  const graphBytes = await directoryBytes(directory);

  const port = 5011;
  const server = spawn(
    'osrm-routed',
    ['--algorithm', 'mld', '--ip', '127.0.0.1', '--port', String(port), base],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: directory },
  );
  let serverLog = '';
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      serverLog = `${serverLog}${chunk}`.slice(-8192);
    });
  }
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let residentAfterLoadBytes = null;
  try {
    const ready = await waitForReady(async () => {
      try {
        const probe = await loopbackJson(
          `http://127.0.0.1:${port}/route/v1/foot/126.9769,37.5759;126.9779,37.5663?overview=false`,
        );
        return probe.httpStatus > 0;
      } catch {
        return false;
      }
    });
    if (!ready) throw new Error(`OSRM_SERVER_NOT_READY: ${serverLog.slice(-1000)}`);
    residentAfterLoadBytes = await residentBytes(server.pid);
    for (const testCase of cases) {
      if (testCase.kind === 'round-trip') {
        results.push({
          caseId: testCase.id,
          engine: 'osrm',
          outcome: 'capability_absent',
          detail:
            'osrm-routed exposes route/table/trip/match/nearest. No target-distance round trip exists in the open-source engine; /trip solves a TSP over supplied waypoints instead.',
          coverageReview: 'not_reviewed',
        });
        continue;
      }
      const path = testCase.points
        .map(([longitude, latitude]) => `${longitude},${latitude}`)
        .join(';');
      const response = await loopbackJson(
        `http://127.0.0.1:${port}/route/v1/foot/${path}?overview=full&geometries=geojson&alternatives=false&steps=false`,
      );
      const route = response.body?.routes?.[0];
      results.push({
        caseId: testCase.id,
        engine: 'osrm',
        negativeControl: Boolean(testCase.negativeControl),
        context: testCase.context,
        httpStatus: response.httpStatus,
        engineCode: response.body?.code ?? null,
        latencyMs: response.latencyMs,
        distanceMeters: route?.distance ?? null,
        durationSeconds: route?.duration ?? null,
        geometryPoints: route?.geometry?.coordinates?.length ?? null,
        geometrySha256: route?.geometry?.coordinates
          ? geometryDigest(route.geometry.coordinates)
          : null,
        outcome:
          response.body?.code === 'Ok'
            ? 'route_computed'
            : response.body?.code
              ? `engine_${response.body.code}`
              : 'no_engine_code',
        coverageReview: 'not_reviewed',
      });
    }
  } finally {
    server.kill('SIGTERM');
    await wait(500);
    server.kill('SIGKILL');
  }
  return {
    engine: 'osrm',
    version: identity.extractBinaryVersion,
    identity,
    license: 'BSD-2-Clause',
    profile: 'share/osrm/profiles/foot.lua (stock)',
    algorithm: 'MLD',
    steps,
    graphBytes,
    residentAfterLoadBytes,
    results,
  };
}

async function measureGraphHopper() {
  const directory = join(workRoot, 'graphhopper');
  await mkdir(directory, { recursive: true });
  const jar = join(directory, 'graphhopper-web.jar');
  let jarIdentity;
  try {
    await stat(jar);
    // A cached jar is verified against the allowlist pin before it is measured.
    jarIdentity = await verifyAllowedSourceFile('graphhopper-web-jar', jar);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SOURCE_HASH_MISMATCH')) throw error;
    jarIdentity = await fetchAllowedSource({ id: 'graphhopper-web-jar', destination: jar });
  }
  const graphLocation = join(directory, 'graph-foot');
  await rm(graphLocation, { recursive: true, force: true });
  const sourceConfigPath = join(repositoryRoot, 'scripts/geo/graphhopper-foot.yml');
  const configPath = join(directory, 'config-foot.yml');
  await copyFile(sourceConfigPath, configPath);
  const identity = {
    extractSha256: await sha256File(extractPath),
    // The artifact URL pins the released version and the hash pins the bytes; together
    // they identify the engine even when the startup log does not print a version.
    artifactUrl: allowedSource('graphhopper-web-jar').url,
    jarSha256: jarIdentity.sha256,
    jarSha256Pinned: jarIdentity.sha256Pinned ?? null,
    profilePath: 'scripts/geo/graphhopper-foot.yml',
    profileSha256: await sha256File(sourceConfigPath),
    javaVersion: await commandVersion('java', ['-version']),
  };

  const port = 8991;
  const steps = [];
  const importStarted = performance.now();
  // Only the data paths (and the request-log override every launch carries, M2-01k-c2) are
  // overridden. The loopback ports live in the YAML.
  const server = spawn(
    'java',
    graphhopperJavaArguments({
      jarPath: jar,
      configPath,
      extractPath,
      graphPath: graphLocation,
      heapMegabytes: 4096,
      initialHeapMegabytes: 1024,
    }),
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: directory },
  );
  let log = '';
  const collect = (/** @type {NodeJS.ReadableStream} */ stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      log = `${log}${chunk}`.slice(-32768);
    });
  };
  collect(server.stdout);
  collect(server.stderr);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let residentAfterLoadBytes = null;
  let graphBytes = null;
  try {
    const ready = await waitForReady(async () => {
      try {
        const probe = await loopbackJson(`http://127.0.0.1:${port}/health`);
        return probe.httpStatus === 200;
      } catch {
        return false;
      }
    }, 900);
    steps.push({
      step: 'graphhopper-import-and-start',
      durationMs: Math.round(performance.now() - importStarted),
      peakRssBytes: null,
    });
    if (!ready) throw new Error(`GRAPHHOPPER_NOT_READY: ${log.slice(-1500)}`);
    residentAfterLoadBytes = await residentBytes(server.pid);
    graphBytes = await directoryBytes(graphLocation);
    for (const testCase of cases) {
      const query = new URLSearchParams({ profile: 'foot', 'ch.disable': 'true' });
      for (const [longitude, latitude] of testCase.points)
        query.append('point', `${latitude},${longitude}`);
      if (testCase.kind === 'round-trip') {
        query.set('algorithm', 'round_trip');
        query.set('round_trip.distance', String(testCase.targetDistanceMeters));
        query.set('round_trip.seed', String(testCase.seed));
      }
      query.set('points_encoded', 'false');
      const response = await loopbackJson(`http://127.0.0.1:${port}/route?${query.toString()}`);
      const path = response.body?.paths?.[0];
      results.push({
        caseId: testCase.id,
        engine: 'graphhopper',
        negativeControl: Boolean(testCase.negativeControl),
        context: testCase.context,
        httpStatus: response.httpStatus,
        engineMessage:
          typeof response.body?.message === 'string' ? response.body.message.slice(0, 200) : null,
        latencyMs: response.latencyMs,
        distanceMeters: path?.distance ?? null,
        durationSeconds: typeof path?.time === 'number' ? path.time / 1000 : null,
        geometryPoints: path?.points?.coordinates?.length ?? null,
        geometrySha256: path?.points?.coordinates ? geometryDigest(path.points.coordinates) : null,
        outcome: path ? 'route_computed' : `http_${response.httpStatus}`,
        coverageReview: 'not_reviewed',
      });
    }
  } finally {
    server.kill('SIGTERM');
    await wait(2000);
    server.kill('SIGKILL');
  }
  return {
    engine: 'graphhopper',
    // Parsed from this run's own startup log where the engine prints it.
    version: /GraphHopper version ([0-9][0-9A-Za-z.+-]{0,30})/.exec(log)?.[1] ?? null,
    versionSource: 'graphhopper startup log; jar pinned by SHA-256 in the operations allowlist',
    identity,
    license: 'Apache-2.0',
    profile: 'scripts/geo/graphhopper-foot.yml',
    algorithm: 'flexible (CH disabled) + round_trip',
    steps,
    graphBytes,
    residentAfterLoadBytes,
    results,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node scripts/probe-routing-engines.mjs --execute [--engine=osrm|graphhopper]. Builds a pedestrian graph from the already downloaded regional extract and queries a loopback server. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine builds are disabled in CI');
  try {
    await stat(extractPath);
  } catch {
    throw new Error('MISSING_EXTRACT: run node scripts/build-basemap.mjs --execute first');
  }

  const engines = [];
  const failures = [];
  for (const engine of options.engines) {
    try {
      engines.push(engine === 'osrm' ? await measureOsrm() : await measureGraphHopper());
    } catch (error) {
      failures.push({
        engine,
        error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
      });
    }
  }

  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope:
      'M2-01d self-hosted engine candidate measurement on a developer machine. Not a production deployment and not Korean pedestrian coverage approval.',
    extract: {
      path: '.geo-build/source/region.osm.pbf',
      region: 'Seoul (BBBike city extract)',
      // Hashed in this run. Each engine entry records the same hash it actually built from.
      sha256: await sha256File(extractPath),
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    notExecuted: [
      {
        engine: 'valhalla',
        reason:
          'No Homebrew formula on this machine and the Docker daemon was not running, so no Valhalla build or measurement was attempted.',
      },
    ],
    interpretation:
      'HTTP success and a computed geometry are not walkability, accessibility or safety. Every case stays not_reviewed and belongs to M2-01g / M0-06b.',
    engines,
    failures,
  };

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
  console.log(
    JSON.stringify({
      engines: engines.map((entry) => ({
        engine: entry.engine,
        graphBytes: entry.graphBytes,
        outcomes: entry.results.map((result) => `${result.caseId}:${result.outcome}`),
      })),
      failures,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
