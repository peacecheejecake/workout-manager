/**
 * M2-01k-c2, M2-01af — what the real routing engine writes to its own log.
 *
 * This probe starts the real GraphHopper jar with a serving profile (by default the one in the
 * repository, `scripts/geo/graphhopper-foot-serving.yml`), on loopback ports that no harness
 * uses, over a scratch copy of the deployed graph. It sends requests carrying planted,
 * distinctive coordinates, captures everything the engine writes to stdout and stderr, and
 * searches it for those coordinates.
 *
 * Two kinds of request, each through every way a route request can end:
 *
 * - **adapter**: exactly what the adapter sends since M2-01af, a `POST /route` whose JSON body
 *   is built by the adapter's own `graphhopperRouteBody` and sent by its real fetch
 *   transport. Route computed, outside the graph, over the node budget, unknown profile.
 * - **query**: a `GET /route?...&point=lat,lon`, the pre-M2-01af shape, which any other
 *   client could still send. Route computed, and a malformed point. These show that the
 *   profile keeps waypoints out of the log even for a request line that carries them. It also
 *   sends `/spt`, `/isochrone` and `/navigate` with planted points: their resources log them
 *   at INFO too (M2-01af review rounds 1 and 2).
 *
 * Nothing under `.geo-build` is written: the graph is copied to a temporary directory,
 * which is removed afterwards. The deployed `config-serving.yml` copy is not used, so the
 * probe judges the profile a rebuild would deploy. The graph is the served one under
 * `.geo-build/routing-graph`, or, with `ROUTING_GRAPH_ROOT` (and `ROUTING_EXTRACT_SOURCE`), the
 * relocated deployment `build-routing-graph.mts` imported there (M2-01ak).
 *
 * Usage: node --import tsx scripts/probe-routing-engine-logs.mts --execute
 *        [--config <path>] [--port <application port>] [--console-threshold <LEVEL>]
 *        [--request-log-override profile|add|omit] [--requests all|adapter]
 *        [--root-level INFO|WARN|ERROR]
 *
 * - `--console-threshold INFO` runs a scratch copy of the profile with every console
 *   appender lowered to INFO, which is what any INFO-level appender would see. The profile's
 *   own settings (request log off, `RouteResource` pinned) must then still keep every
 *   planted coordinate out.
 * - `--root-level INFO` also lowers the profile's root logging level in that scratch copy: what
 *   an operator lowering it for a diagnosis would get. The package pins must still hold.
 *   DEBUG is not offered: nothing here claims DEBUG is safe.
 * - `--request-log-override` is passed to the launch helper. `profile` (the default, what
 *   every launcher does) adds the override exactly when the profile leaves the request log
 *   on; `add` and `omit` force it, to show what the profile does with and without it.
 * - `--requests adapter` sends only the adapter's requests, to judge the adapter's request
 *   shape on a profile that leaves the request log on.
 *
 * The verdict is the same in every mode: the engine answered every request, the adapter's
 * route and (when sent) the query route were computed, no request line carries a query
 * string or `point=`, and the whole log holds no planted coordinate. Exit 0 on PASS.
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
import {
  createFetchRoutingTransport,
  createRoutingEngineEndpoint,
  graphhopperRouteBody,
} from '../packages/server/integrations/src/routing/index.ts';
import { routingExtract, routingGraphDirectory } from './build-routing-graph.mts';
import { graphhopperJavaArguments } from './geo/graphhopper-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
// Follows ROUTING_GRAPH_ROOT / ROUTING_EXTRACT_SOURCE (M2-01ak); the served layout by default.
const extractPath = routingExtract.path;
const deployedGraph = routingGraphDirectory;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const configPath = resolve(
  argument('--config') ?? join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml'),
);
const port = Number(argument('--port') ?? '8995');
const consoleThreshold = argument('--console-threshold');
const rootLevel = argument('--root-level');
if (rootLevel !== undefined && !/^(?:INFO|WARN|ERROR)$/.test(rootLevel))
  throw new Error('--root-level takes INFO, WARN or ERROR (DEBUG is never claimed safe)');
if (consoleThreshold !== undefined && !/^(?:TRACE|DEBUG|INFO|WARN|ERROR)$/.test(consoleThreshold))
  throw new Error('--console-threshold takes a log level');
const overrideChoice = argument('--request-log-override') ?? 'profile';
if (overrideChoice !== 'profile' && overrideChoice !== 'add' && overrideChoice !== 'omit')
  throw new Error('--request-log-override takes profile, add or omit');
const requestSet = argument('--requests') ?? 'all';
if (requestSet !== 'all' && requestSet !== 'adapter')
  throw new Error('--requests takes all or adapter');

/** A request line in Jetty's classic/NCSA format: `"GET /route?... HTTP/1.1"`. */
const REQUEST_LINE = /"(?:GET|POST|HEAD|PUT|DELETE|OPTIONS) ([^" ]*) HTTP\/[\d.]+"/g;

/** Planted waypoints: distinctive decimals that appear nowhere else in the engine's output. */
const start: readonly [number, number] = [126.9765432, 37.5712345];
const inside: readonly [number, number][] = [[...start], [126.9812345, 37.5654321]];
// Open sea south-west of Jeju, outside both the Seoul and the national extract (M2-01ak: the
// earlier point, 127.98765,36.12346, is inland North Gyeongsang and inside the national graph).
const outside: readonly [number, number] = [124.9876543, 31.1234567];

const wait = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

/** The pre-M2-01af query shape: what a client putting waypoints in the URL sends. */
function routeQuery(points: readonly (readonly [number, number])[]) {
  const query = new URLSearchParams({
    profile: 'foot',
    'ch.disable': 'true',
    points_encoded: 'false',
    instructions: 'false',
    calc_points: 'true',
    elevation: 'false',
    details: 'road_class',
    max_visited_nodes: '1000000',
  });
  for (const [longitude, latitude] of points) query.append('point', `${latitude},${longitude}`);
  return query.toString();
}

interface Answer {
  readonly name: string;
  readonly kind: 'adapter' | 'query' | 'info';
  readonly status: number;
  readonly paths: number | null;
}

async function main() {
  if (!process.argv.includes('--execute')) {
    process.stdout.write('Pass --execute to start the real engine.\n');
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'af-engine-logs-'));
  const graphCopy = join(scratch, 'foot');
  await cp(deployedGraph, graphCopy, { recursive: true });
  let engineConfig = configPath;
  if (consoleThreshold !== undefined || rootLevel !== undefined) {
    const text = await readFile(configPath, 'utf8');
    let lowered = text;
    if (consoleThreshold !== undefined) {
      lowered = lowered.replace(/^( {6}threshold: )\w+$/gm, `$1${consoleThreshold}`);
      if (lowered === text) throw new Error('NO_THRESHOLD_TO_LOWER');
    }
    if (rootLevel !== undefined) {
      // The root level is the only two-space `level:` line in the profiles.
      const before = lowered;
      lowered = lowered.replace(/^( {2}level: )\w+$/m, `$1${rootLevel}`);
      if (lowered === before && !before.includes(`  level: ${rootLevel}\n`))
        throw new Error('NO_ROOT_LEVEL_TO_SET');
    }
    engineConfig = join(scratch, 'serving-lowered.yml');
    await writeFile(engineConfig, lowered);
  }
  let log = '';
  let engine: ChildProcess | undefined;
  try {
    const launch = {
      jarPath,
      configPath: engineConfig,
      extractPath,
      graphPath: graphCopy,
      heapMegabytes: 1024,
      initialHeapMegabytes: 256,
      ports: { application: port, admin: port + 1 },
      requestLogOverride: overrideChoice,
    };
    const javaArguments = graphhopperJavaArguments(launch);
    // The same command line every launcher uses, so this proves what production runs.
    engine = spawn('java', graphhopperJavaArguments(launch), {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: dirname(jarPath),
    });
    for (const stream of [engine.stdout, engine.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        log += chunk;
      });
    }
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 240 && !ready; attempt += 1) {
      // The startup log carries no request yet, so its head is safe to show.
      if (engine.exitCode !== null) {
        const reason = log
          .split('\n')
          .filter((line) => /error|exception|unrecognized|has an error/i.test(line))
          .slice(0, 4)
          .map((line) => line.slice(0, 200));
        process.stdout.write(
          `${JSON.stringify(
            {
              config: configPath.replace(repositoryRoot, ''),
              requestLogOverride: overrideChoice,
              overrideInArguments: javaArguments.includes('-Ddw.server.request_log.type=external'),
              engineStarted: false,
              exitCode: engine.exitCode,
              reason,
              verdict: 'ENGINE_REFUSED_CONFIGURATION',
            },
            null,
            1,
          )}\n`,
        );
        process.exitCode = 2;
        return;
      }
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

    // The adapter's own request builder and transport: what production sends.
    const transport = createFetchRoutingTransport(createRoutingEngineEndpoint(`${base}/`));
    const adapterRequests = [
      { name: 'route_computed', profileName: 'foot', waypoints: inside, maxVisitedNodes: 1e6 },
      {
        name: 'outside_coverage',
        profileName: 'foot',
        waypoints: [[...start], [...outside]] as [number, number][],
        maxVisitedNodes: 1e6,
      },
      { name: 'node_budget', profileName: 'foot', waypoints: inside, maxVisitedNodes: 10 },
      { name: 'unknown_profile', profileName: 'nope', waypoints: inside, maxVisitedNodes: 1e6 },
    ];
    const answers: Answer[] = [];
    for (const request of adapterRequests) {
      const response = await transport.send({
        method: 'POST',
        path: '/route',
        json: graphhopperRouteBody({ ...request, engineTimeoutMilliseconds: 5_000 }),
        signal: AbortSignal.timeout(30_000),
        maxBytes: 4 * 1024 * 1024,
      });
      const body = JSON.parse(response.bodyText) as { paths?: unknown[] };
      answers.push({
        name: request.name,
        kind: 'adapter',
        status: response.status,
        paths: Array.isArray(body.paths) ? body.paths.length : null,
      });
    }
    const queryRequests =
      requestSet === 'all'
        ? [
            { name: 'route_computed', path: `/route?${routeQuery(inside)}` },
            { name: 'malformed_point', path: `/route?profile=foot&point=${start[1]},x${start[0]}` },
            // M2-01af review F1: the other resources that log a request's point at INFO.
            {
              name: 'spt',
              path: `/spt?profile=foot&point=${start[1]},${start[0]}&time_limit=30`,
            },
            {
              name: 'isochrone',
              path: `/isochrone?profile=foot&point=${start[1]},${start[0]}&time_limit=30`,
            },
            // Review round 2: NavigateResource logs the points too. `roundabout_exits` and
            // `voice_units` are required for a 200.
            {
              name: 'navigate',
              path:
                `/navigate/directions/v5/gh/foot/${inside.map(([lon, lat]) => `${lon},${lat}`).join(';')}` +
                '?steps=true&geometries=polyline6&overview=full&voice_instructions=true' +
                '&banner_instructions=true&roundabout_exits=true&voice_units=metric',
            },
          ]
        : [];
    for (const request of [...queryRequests, { name: 'info', path: '/info' }]) {
      const response = await fetch(`${base}${request.path}`, {
        headers: { accept: 'application/json' },
      });
      // `/spt` answers CSV; only the JSON answers carry `paths`.
      const text = await response.text();
      let body: { paths?: unknown[] } = {};
      try {
        body = JSON.parse(text) as { paths?: unknown[] };
      } catch {
        // not JSON
      }
      answers.push({
        name: request.name,
        kind: request.name === 'info' ? 'info' : 'query',
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
    const computed = (kind: Answer['kind']) =>
      answers.some(
        (answer) =>
          answer.kind === kind &&
          answer.name === 'route_computed' &&
          answer.status === 200 &&
          answer.paths === 1,
      );
    const adapterRouteComputed = computed('adapter');
    const queryRouteComputed = requestSet === 'adapter' ? null : computed('query');
    const everyRequestAnswered = answers.every((answer) => answer.status > 0);
    const requestTargets = [...log.matchAll(REQUEST_LINE)].map((match) => match[1] ?? '');
    const requestTargetsWithQuery = requestTargets.filter(
      (target) => target.includes('?') || target.includes('point='),
    ).length;
    const routeResourceLines = lines.filter((line) => line.includes('RouteResource')).length;
    // The resources that log a point must actually have been reached, or their silence proves
    // nothing.
    const otherResourcesAnswered =
      requestSet === 'adapter' ||
      ['spt', 'isochrone', 'navigate'].every((name) =>
        answers.some((answer) => answer.name === name && answer.status === 200),
      );
    const verdict =
      adapterRouteComputed &&
      queryRouteComputed !== false &&
      otherResourcesAnswered &&
      everyRequestAnswered &&
      requestTargetsWithQuery === 0 &&
      findings.length === 0;
    const result = {
      config: configPath.replace(repositoryRoot, ''),
      consoleThreshold: consoleThreshold ?? 'as in profile',
      rootLevel: rootLevel ?? 'as in profile',
      otherResourcesAnswered,
      requestLogOverride: overrideChoice,
      overrideInArguments: javaArguments.includes('-Ddw.server.request_log.type=external'),
      requests: requestSet,
      port,
      answers,
      adapterRouteComputed,
      queryRouteComputed,
      logLines: lines.length,
      logLinesAfterStartup: log.slice(startupBytes).split('\n').filter(Boolean).length,
      requestLines: requestTargets.length,
      requestLinesWithQuery: requestTargetsWithQuery,
      requestLineShapes: (log.match(/GET \/route\?/g) ?? []).length,
      pointParameters: (log.match(/point=/g) ?? []).length,
      routeResourceLines,
      plantedCoordinateHits: findings.length,
      findings: formatLogFindings(findings).split('\n').filter(Boolean).slice(0, 10),
      // Which logger wrote each offending line: the logback name field, never the content.
      findingLoggers: [
        ...new Set(
          findings.map(
            (finding) =>
              /^[A-Z]+ +\[[^\]]*\] ([\w.$]+):/.exec(lines[finding.line - 1] ?? '')?.[1] ??
              'unattributed',
          ),
        ),
      ],
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
