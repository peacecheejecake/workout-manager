/**
 * M2-01k-c2 — what the real routing engine writes to its own log.
 *
 * The adapter sends every waypoint in the request line (`GET /route?...&point=lat,lon`). This
 * probe starts the real GraphHopper jar with the **serving profile from the repository**
 * (`scripts/geo/graphhopper-foot-serving.yml`), on loopback ports that no harness uses, over
 * a scratch copy of the deployed graph. It sends requests with planted, distinctive
 * coordinates in the adapter's exact query shape, captures everything the engine writes to
 * stdout and stderr, and searches it for those coordinates.
 *
 * Nothing under `.geo-build` is written: the graph is copied to a temporary directory,
 * which is removed afterwards. The deployed `config-serving.yml` copy is not used, so the
 * probe judges the profile a rebuild would deploy.
 *
 * Usage: node --import tsx scripts/probe-routing-engine-logs.mts --execute
 *        [--config <path>] [--port <application port>] [--console-threshold <LEVEL>]
 * Exit 0 when the engine answered every request and logged no planted coordinate.
 *
 * `--console-threshold INFO` runs a scratch copy of the profile with every console appender
 * lowered to INFO, which is what any INFO-level appender would see. It then judges only
 * what the launch override guarantees on its own. Request lines must still carry no query
 * string and no `point=`. They do carry the path, and GraphHopper's own `RouteResource` INFO
 * line does carry the waypoints (reported, not judged). That second line is stopped only by
 * the WARN threshold.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditLogLines,
  coordinateProbes,
  formatLogFindings,
} from '../packages/server/courses/src/log-audit.ts';
import { graphhopperJavaArguments } from './geo/graphhopper-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const deployedGraph = join(workRoot, 'routing-graph', 'foot');

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const configPath = resolve(
  argument('--config') ?? join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml'),
);
const port = Number(argument('--port') ?? '8995');
const consoleThreshold = argument('--console-threshold');
if (consoleThreshold !== undefined && !/^(?:TRACE|DEBUG|INFO|WARN|ERROR)$/.test(consoleThreshold))
  throw new Error('--console-threshold takes a log level');

/** A request line in Jetty's classic/NCSA format: `"GET /route?... HTTP/1.1"`. */
const REQUEST_LINE = /"(?:GET|POST|HEAD|PUT|DELETE|OPTIONS) ([^" ]*) HTTP\/[\d.]+"/g;

/** Planted waypoints: distinctive decimals that appear nowhere else in the engine's output. */
const start: readonly [number, number] = [126.9765432, 37.5712345];
const inside: readonly (readonly [number, number])[] = [start, [126.9812345, 37.5654321]];
const outside: readonly [number, number] = [127.9876543, 36.1234567];

const wait = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

/** The adapter's query, exactly: graphhopper-adapter.ts builds the same parameters. */
function routeQuery(points: readonly (readonly [number, number])[], maxVisitedNodes = 1_000_000) {
  const query = new URLSearchParams({
    profile: 'foot',
    'ch.disable': 'true',
    points_encoded: 'false',
    instructions: 'false',
    calc_points: 'true',
    elevation: 'false',
    details: 'road_class',
    max_visited_nodes: String(maxVisitedNodes),
  });
  for (const [longitude, latitude] of points) query.append('point', `${latitude},${longitude}`);
  return query.toString();
}

async function main() {
  if (!process.argv.includes('--execute')) {
    process.stdout.write('Pass --execute to start the real engine.\n');
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'c2-engine-logs-'));
  const graphCopy = join(scratch, 'foot');
  await cp(deployedGraph, graphCopy, { recursive: true });
  let engineConfig = configPath;
  if (consoleThreshold !== undefined) {
    const text = await readFile(configPath, 'utf8');
    const lowered = text.replace(/^( {6}threshold: )\w+$/gm, `$1${consoleThreshold}`);
    if (lowered === text) throw new Error('NO_THRESHOLD_TO_LOWER');
    engineConfig = join(scratch, 'serving-lowered.yml');
    await writeFile(engineConfig, lowered);
  }
  let log = '';
  let engine: ChildProcess | undefined;
  try {
    // The same command line every launcher uses, so this proves what production runs.
    engine = spawn(
      'java',
      graphhopperJavaArguments({
        jarPath,
        configPath: engineConfig,
        extractPath,
        graphPath: graphCopy,
        heapMegabytes: 1024,
        initialHeapMegabytes: 256,
        ports: { application: port, admin: port + 1 },
      }),
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(jarPath) },
    );
    for (const stream of [engine.stdout, engine.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        log += chunk;
      });
    }
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 240 && !ready; attempt += 1) {
      // The startup log carries no request yet, so its tail is safe to show.
      if (engine.exitCode !== null) throw new Error(`ENGINE_EXITED: ${log.slice(0, 1500)}`);
      try {
        const response = await fetch(`${base}/health`);
        await response.text();
        ready = response.status === 200;
      } catch {
        // not listening yet
      }
      if (!ready) await wait(500);
    }
    if (!ready) throw new Error('ENGINE_NOT_READY');
    const startupBytes = log.length;

    // Every way a route request can end: computed, outside the graph, over the node budget,
    // a malformed point and an unknown profile. Each carries planted coordinates.
    const requests = [
      { name: 'route_computed', path: `/route?${routeQuery(inside)}` },
      { name: 'outside_coverage', path: `/route?${routeQuery([start, outside])}` },
      { name: 'node_budget', path: `/route?${routeQuery(inside, 10)}` },
      {
        name: 'malformed_point',
        path: `/route?profile=foot&point=${start[1]},x${start[0]}`,
      },
      {
        name: 'unknown_profile',
        path: `/route?${routeQuery(inside).replace('profile=foot', 'profile=nope')}`,
      },
      { name: 'info', path: '/info' },
    ];
    const answers: { name: string; status: number; paths: number | null }[] = [];
    for (const request of requests) {
      const response = await fetch(`${base}${request.path}`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as { paths?: unknown[] };
      answers.push({
        name: request.name,
        status: response.status,
        paths: Array.isArray(body.paths) ? body.paths.length : null,
      });
    }
    // Give asynchronous appenders time to flush before the engine is stopped.
    await wait(1500);

    const lines = log.split('\n').filter((line) => line.length > 0);
    const planted = [...coordinateProbes(inside, 'waypoint'), ...coordinateProbes([outside])];
    // The engine's log is not JSON; only the probe findings are the judgement here.
    const findings = auditLogLines(lines, {
      traceField: 'reqId',
      version: 'engine',
      probes: planted,
      minRecords: 0,
    }).filter((finding) => finding.rule.startsWith('probe-'));
    const routeComputed = answers[0]?.status === 200 && answers[0].paths === 1;
    const everyRequestAnswered = answers.every((answer) => answer.status > 0);
    const requestTargets = [...log.matchAll(REQUEST_LINE)].map((match) => match[1] ?? '');
    const requestTargetsWithQuery = requestTargets.filter(
      (target) => target.includes('?') || target.includes('point='),
    ).length;
    const routeResourceLines = lines.filter((line) => line.includes('RouteResource')).length;
    // The default run judges the whole log. The lowered-threshold run judges only what the
    // launch override guarantees by itself: request lines exist and none carries a query.
    const verdict =
      consoleThreshold === undefined
        ? routeComputed && everyRequestAnswered && findings.length === 0
        : routeComputed &&
          everyRequestAnswered &&
          requestTargets.length > 0 &&
          requestTargetsWithQuery === 0;
    const result = {
      config: configPath.replace(repositoryRoot, ''),
      consoleThreshold: consoleThreshold ?? 'as in profile',
      port,
      answers,
      routeComputed,
      logLines: lines.length,
      logLinesAfterStartup: log.slice(startupBytes).split('\n').filter(Boolean).length,
      requestLines: requestTargets.length,
      requestLinesWithQuery: requestTargetsWithQuery,
      requestLineShapes: (log.match(/GET \/route\?/g) ?? []).length,
      pointParameters: (log.match(/point=/g) ?? []).length,
      routeResourceLines,
      plantedCoordinateHits: findings.length,
      findings: formatLogFindings(findings).split('\n').filter(Boolean).slice(0, 10),
      verdict: verdict ? 'PASS' : 'FAIL',
    };
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    if (result.verdict !== 'PASS') process.exitCode = 1;
  } finally {
    if (engine && engine.exitCode === null) {
      engine.kill('SIGTERM');
      for (let attempt = 0; attempt < 60 && engine.exitCode === null; attempt += 1) await wait(250);
      if (engine.exitCode === null) engine.kill('SIGKILL');
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
