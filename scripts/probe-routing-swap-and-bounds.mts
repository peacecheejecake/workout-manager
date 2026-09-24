/**
 * M2-01k-e: blue/green graph replacement, tenant bounds, cancellation and distinct outcomes,
 * observed against the real self-hosted GraphHopper engine.
 *
 *   node --import tsx scripts/probe-routing-swap-and-bounds.mts --execute --work-dir <absolute dir>
 *
 * Opt-in only and refuses to run in CI. It binds the fixture identity provider on 4400, so
 * run it while holding the shared harness lock. Engines listen on loopback 8991-8997 only.
 * It never calls an external service: graph C is clipped locally from the extract graph A
 * was built from, and `--work-dir` (outside `.geo-build`) holds that clip and its graph.
 *
 * What this proves, and nothing more:
 *
 * 1. Graph replacement is one step. With blue (graph A) and green (graph C, built from a
 *    DIFFERENT extract: a bounding-box clip of the allowlisted Seoul extract) both running,
 *    the API's switch moves every later computation to C and a rollback moves it back to A,
 *    while requests keep arriving: none of them fails with `graph_mismatch` or
 *    `engine_unavailable`, and none is answered from the old graph after the switch
 *    returned. A computation already running on one engine finishes there. Stored
 *    revisions are never recomputed; saving across graphs still needs the acknowledgement.
 *    A switch to an engine that is down, serving another graph, or is the active engine
 *    itself is refused and changes nothing.
 * 2. The tenant bounds of the production configuration, observed through
 *    `createConfiguredApi`: waypoint count, leg and total straight-line distance,
 *    concurrency, and the deadline and response-point bounds as recorded; the latter two
 *    are also observed at tighter values through the same composition, because this region
 *    cannot reach their production values.
 * 3. Cancellation: the caller is answered at once, the engine's own `timeout_ms` bounds how
 *    long it keeps searching, and a tenant's permit stays held until the engine stops.
 * 4. `no_route`, `outside_coverage`, `snap_too_far` and `timeout`, each from the real engine.
 *
 * WHAT THIS IS NOT. Graph C is a clip of the same snapshot, not newer map data: the
 * allowlisted URL served the same bytes on 2026-09-24 (same length and Last-Modified as the
 * extract on disk), and no other extract is on the allowlist. A computed route is not
 * coverage. Timings are single-caller values on this machine only.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  courseImportResultSchema,
  courseReadResultSchema,
  courseRouteProposalResultSchema,
  type CourseWaypoint,
} from '../packages/contracts/src/courses.ts';
import {
  walkingRouteRequestSchema,
  walkingRouteResultSchema,
  type WalkingRouteResult,
} from '../packages/contracts/src/routing.ts';
import {
  GraphHopperRoutingAdapter,
  createRoutingEngineEndpoint,
  loadRoutingDeployment,
} from '../packages/server/integrations/src/routing/index.ts';
import { createConfiguredApi } from '../apps/api/src/configured.ts';
import {
  createConfiguredWalkingRoutes,
  switchRefusalCode,
  type RoutingDeploymentSwitch,
} from '../apps/api/src/routing-deployment.ts';
import {
  importRoutingGraph,
  routingGraphConfig,
  routingGraphDirectory,
  sha256File,
  startEngine,
  stopEngine,
  waitForEngine,
  type EngineHandle,
  type EnginePorts,
} from './build-routing-graph.mjs';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
import { verifyAllowedSourceFile } from './geo/sources.mjs';
import {
  PUBLIC_ORIGIN,
  Session,
  detectedBin,
  startDatabase,
  type Api,
} from './probe-routing-operational.mts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/routing-swap-and-bounds.json',
);

const BLUE: EnginePorts = { application: 8991, admin: 8992 };
const GREEN: EnginePorts = { application: 8993, admin: 8994 };
const IMPORT: EnginePorts = { application: 8995, admin: 8996 };
/**
 * The tighter deadline the timeout and cancellation observations use. It must leave each of
 * LONG's four legs less engine time than the leg needs (~60 ms warm, measured), or the
 * engine never runs out of budget and nothing is observed: 200 ms gives each leg ~37 ms.
 */
const TIGHT_DEADLINE = 200;
/** Nothing listens here: the "engine is down" candidate. */
const NOTHING = 8997;

/** Graph C's extract: central Seoul, clipped from graph A's extract. */
const CLIP_BBOX = '126.90,37.49,127.06,37.62';
const CLIP_REGION = 'Seoul clip bbox 126.90,37.49,127.06,37.62 of the BBBike Seoul extract';

type Position = [number, number];
/** Pre-stated, from M2-01g's KRC-01 case; inside both graphs. */
const KRC01: Position[] = [
  [126.9769, 37.5759],
  [126.9779, 37.5663],
];
const VIA: Position = [126.9786, 37.5712];
/** Gangdong: inside graph A, 7 km east of graph C's clip. */
const OUTSIDE_CLIP: Position[] = [KRC01[0] as Position, [127.14, 37.55]];
/**
 * Four legs of 18-25 km across Seoul (89 km straight-line in all, under the 100 km bound):
 * about half a second of engine search, and 2,338 vertices, on graph A.
 */
const LONG: Position[] = [
  [127.07, 37.65],
  [126.87, 37.49],
  [127.14, 37.55],
  [126.92, 37.62],
  [127.05, 37.49],
];
/** Both ends snap within 5 m; the western one lies on a component cut off at the extract edge. */
const NO_ROUTE: Position[] = [
  [126.59, 37.3547],
  [126.65, 37.39],
];
/** Yellow Sea, M2-01g's CTL-OFFSHORE. */
const OFFSHORE: Position[] = [
  [125.5, 36.5],
  [125.52, 36.52],
];
/** M2-01g's first KRC-03 attempt: the northern point is ~200 m from any pedestrian way. */
const FAR_SNAP: Position[] = [
  [126.93, 37.525],
  [126.932, 37.537],
];

const checks: { id: string; passed: boolean; detail: string }[] = [];
function check(id: string, passed: boolean, detail: string) {
  checks.push({ id, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}
const observations: Record<string, unknown> = {};
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

function routeBody(points: Position[], requestId: string) {
  return {
    schemaVersion: 1,
    requestId,
    requestRevision: 1,
    profileId: 'foot-v1',
    waypoints: points,
  };
}

function summary(result: WalkingRouteResult) {
  return {
    outcome: result.outcome,
    graph: result.computation.graph.graphBuildId,
    identitySource: result.computation.graph.identitySource,
    computationMilliseconds: result.computation.computationMilliseconds,
    deadlineMilliseconds: result.computation.conditions.deadlineMilliseconds,
    waypointCount: result.computation.conditions.waypointCount,
    ...(result.outcome === 'route_computed'
      ? {
          distanceMeters: Math.round(result.distanceMeters),
          vertices: result.geometry.coordinates.length,
          worstSnapMeters: Number(
            Math.max(...result.snappedWaypoints.map((entry) => entry.snapDistanceMeters)).toFixed(
              1,
            ),
          ),
        }
      : {}),
  };
}

function rss(engine: EngineHandle): number | null {
  const pid = engine.process.pid;
  if (pid === undefined) return null;
  const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const kib = Number(out.stdout.trim());
  return Number.isFinite(kib) && kib > 0 ? Math.round(kib / 1024) : null;
}

// ---------------------------------------------------------------- graph C
async function ensureGraphC(workDir: string, deploymentOf: (dir: string) => Promise<unknown>) {
  const clipPath = join(workDir, 'extract-c.osm.pbf');
  const graphDirectory = join(workDir, 'graph-c', 'foot');
  const osmium = spawnSync('osmium', ['--version'], { encoding: 'utf8' });
  if (osmium.status !== 0) throw new Error('MISSING_PREREQUISITE: osmium');
  const osmiumVersion = osmium.stdout.split('\n')[0]?.trim() ?? 'unknown';
  const sourceSha256 = await sha256File(extractPath);
  // Always re-clip into a temporary file: the clip is deterministic, and comparing hashes
  // is how a reused graph C is known to come from these exact bytes.
  await mkdir(workDir, { recursive: true });
  const temporary = `${clipPath}.${process.pid}.tmp.osm.pbf`;
  const clipped = spawnSync(
    'osmium',
    [
      'extract',
      '--bbox',
      CLIP_BBOX,
      '--strategy',
      'complete_ways',
      '--set-bounds',
      // The source's own snapshot time, so the engine reports the real data date.
      '--output-header',
      'osmosis_replication_timestamp=2026-09-18T23:00:00Z',
      '--overwrite',
      '-o',
      temporary,
      extractPath,
    ],
    { encoding: 'utf8' },
  );
  if (clipped.status !== 0)
    throw new Error(`OSMIUM_EXTRACT_FAILED: ${clipped.stderr.slice(0, 300)}`);
  const clipSha256 = await sha256File(temporary);
  const previousClip = existsSync(clipPath) ? await sha256File(clipPath) : null;
  await rename(temporary, clipPath);
  let built = false;
  let importMilliseconds: number | null = null;
  const existing = (await deploymentOf(graphDirectory).catch(() => null)) as {
    manifest: { extractSha256: string; extractRegion: string };
  } | null;
  if (
    existing === null ||
    existing.manifest.extractSha256 !== clipSha256 ||
    existing.manifest.extractRegion !== CLIP_REGION
  ) {
    const jar = await verifyAllowedSourceFile('graphhopper-web-jar', jarPath);
    const started = performance.now();
    await importRoutingGraph({
      graphDirectory,
      engineArtifactSha256: jar.sha256,
      extractSha256: clipSha256,
      profileConfigSha256: await sha256File(routingGraphConfig),
      extractByteLength: (await stat(clipPath)).size,
      extract: { path: clipPath, region: CLIP_REGION },
      ports: IMPORT,
    });
    importMilliseconds = Math.round(performance.now() - started);
    built = true;
  }
  return {
    clipPath,
    graphDirectory,
    clipSha256,
    clipDeterministic: previousClip === null ? null : previousClip === clipSha256,
    sourceSha256,
    osmiumVersion,
    built,
    importMilliseconds,
  };
}

// ---------------------------------------------------------------- HTTP helpers
async function computeOver(api: Api, session: Session, points: Position[], requestId: string) {
  const response = await api.inject({
    method: 'POST',
    url: '/bff/v1/routing/walking-routes',
    headers: session.headers(true),
    payload: routeBody(points, requestId),
  });
  const parsed = walkingRouteResultSchema.safeParse(response.json());
  return {
    status: response.statusCode,
    retryAfter: response.headers['retry-after'] as string | undefined,
    result: parsed.success ? parsed.data : null,
    errorCode: parsed.success
      ? null
      : ((response.json() as { error?: { code?: string } }).error?.code ?? null),
  };
}

/** One POST over a real socket, destroyed after `abortAfter` ms: the client going away. */
function disconnectingRequest(
  port: number,
  session: Session,
  points: Position[],
  requestId: string,
  abortAfter: number,
) {
  return new Promise<'disconnected' | number>((done) => {
    const payload = JSON.stringify(routeBody(points, requestId));
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/bff/v1/routing/walking-routes',
        headers: { ...session.headers(true), 'content-length': Buffer.byteLength(payload) },
      },
      (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      },
    );
    request.on('error', () => done('disconnected'));
    request.end(payload);
    setTimeout(() => request.destroy(), abortAfter);
  });
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const workIndex = argv.indexOf('--work-dir');
  const workDir = workIndex >= 0 ? argv[workIndex + 1] : undefined;
  if (!argv.includes('--execute') || workDir === undefined || !isAbsolute(workDir)) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-routing-swap-and-bounds.mts --execute --work-dir <absolute dir>. ' +
        'Runs two real engines on loopback 8991-8996, the production API composition and the fixture OIDC ' +
        'provider on 4400 (hold the harness lock), and writes a report. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  if (resolve(workDir).startsWith(resolve(workRoot)))
    throw new Error('WORK_DIR_INSIDE_GEO_BUILD: keep graph C out of .geo-build');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');
  for (const required of [extractPath, jarPath, routingGraphConfig]) await stat(required);

  const verify = (graphDirectory: string, port: number) =>
    loadRoutingDeployment({
      graphDirectory,
      engineArtifactPath: jarPath,
      profileConfigPath: routingGraphConfig,
      endpoint: createRoutingEngineEndpoint(`http://127.0.0.1:${port}/`),
    });
  const graphC = await ensureGraphC(workDir, (directory) => verify(directory, GREEN.application));
  const deploymentA = await verify(routingGraphDirectory, BLUE.application);
  const deploymentC = await verify(graphC.graphDirectory, GREEN.application);
  const graphA = deploymentA.graphBuildId;
  const graphCId = deploymentC.graphBuildId;
  check(
    'graph-c-from-a-different-extract',
    graphA !== graphCId &&
      deploymentC.manifest.extractSha256 === graphC.clipSha256 &&
      deploymentC.manifest.extractSha256 !== deploymentA.manifest.extractSha256 &&
      deploymentA.manifest.extractSha256 === graphC.sourceSha256,
    `A ${graphA} extract ${deploymentA.manifest.extractSha256.slice(0, 12)} / C ${graphCId} extract ${graphC.clipSha256.slice(0, 12)} (clip of A's extract)`,
  );

  const env = (graphDirectory: string, port: number) => ({
    ROUTING_ENGINE_URL: `http://127.0.0.1:${port}/`,
    ROUTING_GRAPH_DIRECTORY: graphDirectory,
    ROUTING_ENGINE_ARTIFACT: jarPath,
    ROUTING_PROFILE_CONFIG: routingGraphConfig,
  });
  const envA = env(routingGraphDirectory, BLUE.application);
  const envC = env(graphC.graphDirectory, GREEN.application);

  const directory = await mkdtemp(join(tmpdir(), 'workout-routing-swap-'));
  const storageRoot = join(directory, 'objects');
  await mkdir(storageRoot, { recursive: true });
  const database = await startDatabase(directory, detectedBin);
  const oidc = await startFixtureOidc();
  const engines: { blue: EngineHandle | null; green: EngineHandle | null } = {
    blue: null,
    green: null,
  };
  const apis: Api[] = [];
  const baseEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: database.runtimeUrl,
    PUBLIC_ORIGIN,
    OIDC_ISSUER: fixtureOidc.issuer,
    OIDC_CLIENT_ID: fixtureOidc.clientId,
    OIDC_CLIENT_SECRET: fixtureOidc.clientSecret,
    ALLOW_INSECURE_LOCALHOST: 'true',
    PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot,
  };

  try {
    // ---- Two engines, two graphs, two ports. Neither is ever restarted in place.
    // A leftover engine on one of these ports would answer for the one started here, and
    // `waitForEngine` could not tell; refuse instead of measuring the wrong process.
    for (const port of [BLUE.application, BLUE.admin, GREEN.application, GREEN.admin, NOTHING]) {
      const busy = await fetch(`http://127.0.0.1:${port}/`).then(
        () => true,
        () => false,
      );
      if (busy) throw new Error(`PORT_BUSY: ${port}`);
    }
    engines.blue = startEngine({
      jarPath,
      configPath: routingGraphConfig,
      extractPath,
      graphPath: routingGraphDirectory,
      ports: BLUE,
    });
    engines.green = startEngine({
      jarPath,
      configPath: routingGraphConfig,
      extractPath: graphC.clipPath,
      graphPath: graphC.graphDirectory,
      ports: GREEN,
    });
    await Promise.all([
      waitForEngine(engines.blue, BLUE.application),
      waitForEngine(engines.green, GREEN.application),
    ]);
    observations['engineRssMiBAfterStart'] = { blue: rss(engines.blue), green: rss(engines.green) };

    // ================================================================ 1. blue/green
    let control: RoutingDeploymentSwitch | null = null;
    const api = await createConfiguredApi(
      { ...baseEnv, ...envA },
      {
        onRoutingDeployments: (received) => {
          control = received;
        },
      },
    );
    apis.push(api);
    await api.ready();
    if (control === null) throw new Error('NO_ROUTING_CONTROL');
    const deployments = control as RoutingDeploymentSwitch;
    const alice = new Session();
    await alice.login(api, 'alice');
    const bob = new Session();
    await bob.login(api, 'bob');

    const onA = await computeOver(api, alice, KRC01, 'swap-a');
    const outsideOnA = await computeOver(api, alice, OUTSIDE_CLIP, 'swap-outside-a');
    check(
      'blue-serves-graph-a',
      onA.result?.outcome === 'route_computed' &&
        onA.result.computation.graph.graphBuildId === graphA &&
        outsideOnA.result?.outcome === 'route_computed' &&
        outsideOnA.result.computation.graph.graphBuildId === graphA,
      `KRC-01 ${JSON.stringify(onA.result && summary(onA.result))}; Gangdong ${JSON.stringify(outsideOnA.result && summary(outsideOnA.result))}`,
    );

    // A saved course on A, to show that no switch recomputes what is stored.
    const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="m2-01k-e" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>M2-01k-e swap</name>${[
      KRC01[0] as Position,
      VIA,
      KRC01[1] as Position,
    ]
      .map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`)
      .join('')}</rte></gpx>`;
    const imported = courseImportResultSchema.parse(
      (
        await api.inject({
          method: 'POST',
          url: '/bff/v1/courses/imports',
          headers: alice.headers(true),
          payload: {
            name: null,
            originalFilename: 'm2-01k-e.gpx',
            selection: null,
            fileBase64: Buffer.from(gpx).toString('base64'),
          },
        })
      ).json(),
    );
    if (imported.outcome !== 'imported' || imported.course.status !== 'available')
      throw new Error('IMPORT_FAILED');
    const courseId = imported.course.course.courseId;
    const waypoints = (points: Position[]): CourseWaypoint[] =>
      points.map((position, index) => ({
        role: index === 0 ? 'start' : index === points.length - 1 ? 'finish' : 'via',
        position,
        name: null,
        sourceSampleId: null,
        locked: false,
      }));
    let draftRevision = 0;
    const propose = async () => {
      draftRevision += 1;
      const response = await api.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-proposals`,
        headers: alice.headers(true),
        payload: {
          requestId: `swap-${randomUUID()}`,
          draftRevision,
          waypoints: waypoints([KRC01[0] as Position, VIA, KRC01[1] as Position]),
        },
      });
      return {
        result: courseRouteProposalResultSchema.parse(response.json()),
        draftRevision,
      };
    };
    const save = async (change: Record<string, unknown>) => {
      const head = courseReadResultSchema.parse(
        (
          await api.inject({
            method: 'GET',
            url: `/bff/v1/courses/${courseId}`,
            headers: alice.headers(false),
          })
        ).json(),
      );
      if (head.status !== 'available') throw new Error('COURSE_UNAVAILABLE');
      const response = await api.inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${courseId}`,
        headers: alice.headers(true),
        payload: { expectedRevision: head.course.headRevision, change },
      });
      return { status: response.statusCode, body: JSON.stringify(response.json()) };
    };
    const revisions = async () =>
      (
        await database.admin.query<{
          course_revision: number;
          content_digest: string;
          graph: string | null;
        }>(
          `SELECT course_revision, content_digest,
                  COALESCE(generation #>> '{computation,graph,graphBuildId}', generation->>'sourceGraphBuildId') AS graph
             FROM course_revision WHERE course_id=$1 ORDER BY course_revision`,
          [courseId],
        )
      ).rows;
    const proposedA = await propose();
    if (proposedA.result.outcome !== 'route_computed') throw new Error('NO_PROPOSAL_ON_A');
    const savedA = await save({
      kind: 'reroute',
      proposalId: proposedA.result.proposal.proposalId,
      draftRevision: proposedA.draftRevision,
      acknowledgedGraph: { previous: null, next: graphA },
    });
    const storedOnA = await revisions();
    check(
      'course-saved-on-a',
      savedA.status === 200 && storedOnA.at(-1)?.graph === graphA,
      storedOnA.map((row) => `${row.course_revision}:${row.graph}`).join(' '),
    );

    // ---- Refused switches change nothing.
    const refusal = async (environment: Record<string, string>) =>
      deployments.switchTo(environment).then(
        () => ({ code: 'SWITCHED', outcome: null as string | null }),
        (error: unknown) => ({
          code: switchRefusalCode(error),
          outcome:
            typeof error === 'object' && error !== null
              ? ((Reflect.get(error, 'engineOutcome') as string | null | undefined) ?? null)
              : null,
        }),
      );
    const wrongGraph = await refusal(env(routingGraphDirectory, GREEN.application));
    const down = await refusal(env(graphC.graphDirectory, NOTHING));
    const inPlace = await refusal(env(graphC.graphDirectory, BLUE.application));
    const stillA = await computeOver(api, alice, KRC01, 'swap-still-a');
    check(
      'refused-switches-change-nothing',
      wrongGraph.code === 'ROUTING_SWITCH_ENGINE_NOT_SERVING' &&
        wrongGraph.outcome === 'graph_mismatch' &&
        down.code === 'ROUTING_SWITCH_ENGINE_NOT_SERVING' &&
        down.outcome === 'engine_unavailable' &&
        inPlace.code === 'ROUTING_SWITCH_SAME_ENGINE' &&
        deployments.activeGraphBuildId === graphA &&
        stillA.result?.computation.graph.graphBuildId === graphA,
      `green engine pinned to A: ${wrongGraph.code}/${wrongGraph.outcome}; no engine: ${down.code}/${down.outcome}; blue's own port: ${inPlace.code}; active ${deployments.activeGraphBuildId}`,
    );

    // ---- The switch, while requests keep arriving.
    const throughMove = async (
      label: string,
      session: Session,
      move: () => Promise<{ from: string; to: string }>,
    ) => {
      const seen: {
        index: number;
        startedAfterMove: boolean;
        status: number;
        outcome: string;
        graph: string | null;
      }[] = [];
      let moved = false;
      let after = 0;
      const loop = (async () => {
        for (let index = 0; index < 12; index += 1) {
          if (moved && after >= 3) break;
          const startedAfterMove = moved;
          // A failure elsewhere must not leave this loop calling a closed API.
          const answer = await computeOver(api, session, KRC01, `${label}-${index}`).catch(
            () => null,
          );
          if (answer === null) break;
          seen.push({
            index,
            startedAfterMove,
            status: answer.status,
            outcome: answer.result?.outcome ?? answer.errorCode ?? '?',
            graph: answer.result?.computation.graph.graphBuildId ?? null,
          });
          if (startedAfterMove) after += 1;
          await sleep(60);
        }
      })();
      await sleep(150);
      const startedAt = performance.now();
      const result = await move();
      const moveMilliseconds = Math.round(performance.now() - startedAt);
      moved = true;
      await loop;
      return { seen, result, moveMilliseconds };
    };
    const switched = await throughMove('switch', bob, () => deployments.switchTo(envC));
    observations['switchUnderLoad'] = switched;
    const graphsInOrder = switched.seen.map((entry) => entry.graph);
    const firstC = graphsInOrder.indexOf(graphCId);
    check(
      'switch-is-one-step-under-load',
      switched.result.from === graphA &&
        switched.result.to === graphCId &&
        switched.seen.every(
          (entry) => entry.status === 200 && entry.outcome === 'route_computed',
        ) &&
        switched.seen.some((entry) => !entry.startedAfterMove && entry.graph === graphA) &&
        switched.seen.filter((entry) => entry.startedAfterMove).length >= 3 &&
        switched.seen
          .filter((entry) => entry.startedAfterMove)
          .every((entry) => entry.graph === graphCId) &&
        firstC >= 0 &&
        graphsInOrder.slice(firstC).every((graph) => graph === graphCId),
      `${switched.seen.map((entry) => `${entry.index}${entry.startedAfterMove ? '*' : ''}:${entry.status}:${entry.outcome}:${entry.graph === graphA ? 'A' : entry.graph === graphCId ? 'C' : entry.graph}`).join(' ')} (switch ${switched.moveMilliseconds} ms, * = started after it returned)`,
    );

    // The new graph really is different data: Gangdong is outside C's clip.
    const outsideOnC = await computeOver(api, alice, OUTSIDE_CLIP, 'swap-outside-c');
    check(
      'green-serves-graph-c-with-its-own-coverage',
      outsideOnC.result?.outcome === 'outside_coverage' &&
        outsideOnC.result.computation.graph.graphBuildId === graphCId,
      `Gangdong on C: ${JSON.stringify(outsideOnC.result && summary(outsideOnC.result))} (on A it was route_computed)`,
    );
    const afterSwitch = await revisions();
    const proposedC = await propose();
    const unacknowledged =
      proposedC.result.outcome === 'route_computed'
        ? await save({
            kind: 'reroute',
            proposalId: proposedC.result.proposal.proposalId,
            draftRevision: proposedC.draftRevision,
            acknowledgedGraph: { previous: graphA, next: graphA },
          })
        : null;
    check(
      'switch-recomputes-nothing-and-needs-acknowledgement',
      JSON.stringify(afterSwitch) === JSON.stringify(storedOnA) &&
        proposedC.result.outcome === 'route_computed' &&
        proposedC.result.proposal.computation.graph.graphBuildId === graphCId &&
        unacknowledged?.status === 409 &&
        unacknowledged.body.includes('COURSE_GRAPH_ACKNOWLEDGEMENT_STALE'),
      `stored ${afterSwitch.map((row) => `${row.course_revision}:${row.graph}:${row.content_digest.slice(0, 8)}`).join(' ')}; proposal on ${proposedC.result.outcome === 'route_computed' ? proposedC.result.proposal.computation.graph.graphBuildId : proposedC.result.outcome}; save acknowledging A->A ${unacknowledged?.status}`,
    );

    // ---- Rollback, with a long computation running on green across it.
    const INSIDE_C_LONG: Position[] = [
      [126.91, 37.61],
      [127.05, 37.5],
      [126.91, 37.5],
      [127.05, 37.61],
    ];
    // The in-flight computation starts inside the move, 40 ms before the rollback itself.
    let inFlightStarted = 0;
    let rolledBackAt = 0;
    const held: {
      inFlight?: Promise<{ answer: Awaited<ReturnType<typeof computeOver>>; finishedAt: number }>;
    } = {};
    const rolledBack = await throughMove('rollback', alice, async () => {
      inFlightStarted = performance.now();
      held.inFlight = computeOver(api, alice, INSIDE_C_LONG, 'swap-in-flight').then((answer) => ({
        answer,
        finishedAt: performance.now() - inFlightStarted,
      }));
      await sleep(40);
      const moved = await deployments.rollback();
      rolledBackAt = performance.now() - inFlightStarted;
      return moved;
    });
    observations['rollbackUnderLoad'] = rolledBack;
    if (held.inFlight === undefined) throw new Error('NO_IN_FLIGHT');
    const { answer: straddled, finishedAt } = await held.inFlight;
    check(
      'rollback-is-one-step-under-load',
      rolledBack.result.from === graphCId &&
        rolledBack.result.to === graphA &&
        rolledBack.seen.every(
          (entry) => entry.status === 200 && entry.outcome === 'route_computed',
        ) &&
        rolledBack.seen.filter((entry) => entry.startedAfterMove).length >= 3 &&
        rolledBack.seen
          .filter((entry) => entry.startedAfterMove)
          .every((entry) => entry.graph === graphA),
      `${rolledBack.seen.map((entry) => `${entry.index}${entry.startedAfterMove ? '*' : ''}:${entry.status}:${entry.outcome}:${entry.graph === graphA ? 'A' : entry.graph === graphCId ? 'C' : entry.graph}`).join(' ')} (rollback ${rolledBack.moveMilliseconds} ms)`,
    );
    observations['inFlightAcrossRollback'] = {
      startedBeforeRollbackBy: 40,
      rollbackReturnedAtMilliseconds: Math.round(rolledBackAt),
      finishedAtMilliseconds: Math.round(finishedAt),
      result: straddled.result && summary(straddled.result),
    };
    check(
      'in-flight-computation-finishes-where-it-started',
      finishedAt > rolledBackAt &&
        straddled.result?.outcome === 'route_computed' &&
        straddled.result.computation.graph.graphBuildId === graphCId,
      `started on C, rollback returned at ${Math.round(rolledBackAt)} ms, finished at ${Math.round(finishedAt)} ms on ${straddled.result?.computation.graph.graphBuildId === graphCId ? 'C' : straddled.result?.computation.graph.graphBuildId} (${straddled.result?.outcome})`,
    );
    const afterRollback = await revisions();
    const outsideAgain = await computeOver(api, alice, OUTSIDE_CLIP, 'swap-outside-a-again');
    check(
      'rollback-returns-exactly-graph-a',
      JSON.stringify(afterRollback) === JSON.stringify(storedOnA) &&
        deployments.activeGraphBuildId === graphA &&
        outsideAgain.result?.outcome === 'route_computed' &&
        outsideAgain.result.computation.graph.graphBuildId === graphA,
      `active ${deployments.activeGraphBuildId}; Gangdong ${outsideAgain.result?.outcome} on ${outsideAgain.result?.computation.graph.graphBuildId}; stored unchanged ${JSON.stringify(afterRollback) === JSON.stringify(storedOnA)}`,
    );

    // ---- A rollback target that is gone is refused; the active deployment stays.
    await stopEngine(engines.green);
    engines.green = null;
    const gone = await deployments.rollback().then(
      () => 'ROLLED_BACK',
      (error: unknown) =>
        `${switchRefusalCode(error)}/${String(Reflect.get(error as object, 'engineOutcome'))}`,
    );
    const stillOnA = await computeOver(api, alice, KRC01, 'swap-after-green-gone');
    check(
      'rollback-to-a-stopped-engine-is-refused',
      gone === 'ROUTING_SWITCH_ENGINE_NOT_SERVING/engine_unavailable' &&
        stillOnA.result?.computation.graph.graphBuildId === graphA,
      `${gone}; next computation on ${stillOnA.result?.computation.graph.graphBuildId}`,
    );
    await api.close();
    apis.pop();

    // ================================================================ 2. production bounds
    const limitsApi = await createConfiguredApi({ ...baseEnv, ...envA });
    apis.push(limitsApi);
    await limitsApi.ready();
    const owner = new Session();
    await owner.login(limitsApi, 'alice');

    const twelve: Position[] = Array.from({ length: 12 }, (_value, index) => [
      Number((126.9769 + (index * 0.001) / 11).toFixed(6)),
      Number((37.5759 - (index * 0.0096) / 11).toFixed(6)),
    ]);
    const twelveAnswer = await computeOver(limitsApi, owner, twelve, 'limits-12');
    const thirteen = await computeOver(
      limitsApi,
      owner,
      [...twelve, [126.9785, 37.565]],
      'limits-13',
    );
    check(
      'waypoint-bound',
      twelveAnswer.status === 200 &&
        twelveAnswer.result?.outcome === 'route_computed' &&
        twelveAnswer.result.computation.conditions.waypointCount === 12 &&
        thirteen.status === 422 &&
        thirteen.errorCode === 'INVALID_ROUTING_REQUEST',
      `12 waypoints: ${twelveAnswer.status} ${twelveAnswer.result?.outcome}; 13: ${thirteen.status} ${thirteen.errorCode}`,
    );
    const longLeg = await computeOver(
      limitsApi,
      owner,
      [
        [126.6, 37.4],
        [126.9769, 37.5759],
      ],
      'limits-leg',
    );
    const longSpan = await computeOver(limitsApi, owner, [...LONG, [126.8, 37.6]], 'limits-span');
    check(
      'distance-bounds',
      longLeg.status === 422 &&
        longLeg.errorCode === 'ROUTING_LEG_TOO_LONG' &&
        longSpan.status === 422 &&
        longSpan.errorCode === 'ROUTING_SPAN_TOO_LARGE',
      `one 38 km leg: ${longLeg.status} ${longLeg.errorCode}; five legs of at most 25 km, 114 km in all: ${longSpan.status} ${longSpan.errorCode}`,
    );
    const concurrent = await Promise.all(
      [0, 1, 2].map((index) => computeOver(limitsApi, owner, LONG, `limits-concurrent-${index}`)),
    );
    const statuses = concurrent.map((answer) => answer.status).sort();
    const refused = concurrent.find((answer) => answer.status === 429);
    const computedLong = concurrent.find((answer) => answer.result?.outcome === 'route_computed');
    check(
      'concurrency-bound',
      JSON.stringify(statuses) === JSON.stringify([200, 200, 429]) &&
        refused?.result?.outcome === 'overloaded' &&
        refused.retryAfter === '1',
      `three at once: ${concurrent.map((answer) => `${answer.status}:${answer.result?.outcome}`).join(', ')}; refused retry-after ${refused?.retryAfter}`,
    );
    check(
      'deadline-and-response-points-as-configured',
      computedLong?.result?.outcome === 'route_computed' &&
        computedLong.result.computation.conditions.deadlineMilliseconds === 8000 &&
        computedLong.result.computation.computationMilliseconds < 8000 &&
        computedLong.result.geometry.coordinates.length <= 20000,
      `longest route ${JSON.stringify(computedLong?.result && summary(computedLong.result))}; bounds 8000 ms and 20,000 vertices are recorded, not reached, in this region`,
    );

    // ---- Distinct outcomes from the real engine, production configuration.
    const noRoute = await computeOver(limitsApi, owner, NO_ROUTE, 'outcome-no-route');
    const offshore = await computeOver(limitsApi, owner, OFFSHORE, 'outcome-offshore');
    const farSnap = await computeOver(limitsApi, owner, FAR_SNAP, 'outcome-snap');
    observations['outcomes'] = {
      noRoute: noRoute.result && summary(noRoute.result),
      offshore: offshore.result && summary(offshore.result),
      farSnap: farSnap.result && summary(farSnap.result),
    };
    check(
      'no-route-observed',
      noRoute.status === 200 && noRoute.result?.outcome === 'no_route',
      `${noRoute.status} ${JSON.stringify(noRoute.result && summary(noRoute.result))}`,
    );
    check(
      'outside-coverage-observed',
      offshore.status === 200 && offshore.result?.outcome === 'outside_coverage',
      `${offshore.status} ${JSON.stringify(offshore.result && summary(offshore.result))}`,
    );
    check(
      'snap-too-far-observed',
      farSnap.status === 200 && farSnap.result?.outcome === 'snap_too_far',
      `${farSnap.status} ${JSON.stringify(farSnap.result && summary(farSnap.result))} (production snap limit 120 m)`,
    );

    // ---- A client that goes away does not free its permit while the engine searches.
    await limitsApi.listen({ port: 0, host: '127.0.0.1' });
    const port = (limitsApi.server.address() as AddressInfo).port;
    const cancelledStartedAt = performance.now();
    const cancelled = await Promise.all([
      disconnectingRequest(port, owner, LONG, 'cancel-1', 80),
      disconnectingRequest(port, owner, LONG, 'cancel-2', 80),
    ]);
    const whileSearching = await computeOver(limitsApi, owner, KRC01, 'cancel-third');
    const refusedAt = Math.round(performance.now() - cancelledStartedAt);
    let admittedAt: number | null = null;
    let admitted: Awaited<ReturnType<typeof computeOver>> | null = null;
    for (let attempt = 0; attempt < 30 && admitted?.status !== 200; attempt += 1) {
      await sleep(100);
      admitted = await computeOver(limitsApi, owner, KRC01, `cancel-after-${attempt}`);
      admittedAt = Math.round(performance.now() - cancelledStartedAt);
    }
    observations['permitAfterDisconnect'] = {
      clients: cancelled,
      thirdStatusAt: refusedAt,
      thirdStatus: whileSearching.status,
      admittedAt,
    };
    check(
      'disconnected-client-keeps-permit-until-engine-stops',
      cancelled.every((entry) => entry === 'disconnected') &&
        whileSearching.status === 429 &&
        whileSearching.retryAfter === '1' &&
        admitted?.status === 200,
      `two clients disconnected at 80 ms; a third request at ${refusedAt} ms: ${whileSearching.status} retry-after ${whileSearching.retryAfter}; admitted again at ${admittedAt} ms`,
    );
    await limitsApi.close();
    apis.pop();

    // ================================================================ 3. tighter bounds, same composition
    const tight = await createConfiguredWalkingRoutes(envA, {
      adapterBounds: { deadlineMilliseconds: TIGHT_DEADLINE },
    });
    if (tight === null) throw new Error('NO_TIGHT_ROUTING');
    const timedOut = await tight.walkingRoutes.compute(
      'tenant-timeout',
      routeBody(LONG, 'tight-long'),
      {},
    );
    const quickNoRoute = await tight.walkingRoutes.compute(
      'tenant-timeout',
      routeBody(NO_ROUTE, 'tight-no-route'),
      {},
    );
    observations['timeout'] = {
      long: summary(timedOut.result),
      noRouteUnderSameBudget: summary(quickNoRoute.result),
    };
    check(
      'timeout-observed-and-kept-apart-from-no-route',
      timedOut.result.outcome === 'timeout' &&
        timedOut.result.computation.graph.identitySource === 'engine' &&
        quickNoRoute.result.outcome === 'no_route',
      `deadline ${TIGHT_DEADLINE} ms: four long legs -> ${timedOut.result.outcome} after ${timedOut.result.computation.computationMilliseconds} ms; the NoRoute pair under the same budget -> ${quickNoRoute.result.outcome} after ${quickNoRoute.result.computation.computationMilliseconds} ms`,
    );
    const fewPoints = await createConfiguredWalkingRoutes(envA, {
      adapterBounds: { maxResponsePoints: 1000 },
    });
    if (fewPoints === null) throw new Error('NO_TIGHT_ROUTING');
    const tooMany = await fewPoints.walkingRoutes.compute(
      'tenant-points',
      routeBody(LONG, 'points-long'),
      {},
    );
    const fewEnough = await fewPoints.walkingRoutes.compute(
      'tenant-points',
      routeBody(KRC01, 'points-short'),
      {},
    );
    check(
      'response-point-bound-enforced',
      tooMany.result.outcome === 'engine_contract_violation' &&
        fewEnough.result.outcome === 'route_computed',
      `bound 1,000: long route (2,338 vertices at the production bound) -> ${tooMany.result.outcome}; KRC-01 -> ${fewEnough.result.outcome} (${fewEnough.result.outcome === 'route_computed' ? fewEnough.result.geometry.coordinates.length : '?'} vertices)`,
    );

    // ================================================================ 4. what cancellation does to the engine
    const measureTracked = async (deadlineMilliseconds: number, cancelAfter: number | null) => {
      const adapter = new GraphHopperRoutingAdapter({
        deployment: deploymentA,
        clock: { now: () => new Date() },
        deadlineMilliseconds,
      });
      const controller = new AbortController();
      const started = performance.now();
      const tracked = adapter.computeWalkingRouteTracked(
        walkingRouteRequestSchema.parse(
          routeBody(LONG, `tracked-${deadlineMilliseconds}-${cancelAfter ?? 'none'}`),
        ),
        { signal: controller.signal },
      );
      if (cancelAfter !== null) setTimeout(() => controller.abort(), cancelAfter);
      const [result, answeredAt, releasedAt] = await Promise.all([
        tracked.result,
        tracked.result.then(() => Math.round(performance.now() - started)),
        tracked.engineReleased.then(() => Math.round(performance.now() - started)),
      ]);
      return {
        deadlineMilliseconds,
        cancelAfter,
        outcome: result.outcome,
        answeredAt,
        engineReleasedAt: releasedAt,
      };
    };
    const natural = await measureTracked(8000, null);
    const cancelledMidSearch = await measureTracked(8000, 60);
    const cancelledWithTightBudget = await measureTracked(TIGHT_DEADLINE, 60);
    observations['cancellation'] = { natural, cancelledMidSearch, cancelledWithTightBudget };
    check(
      'cancellation-answers-at-once-and-engine-stops-by-its-budget',
      natural.outcome === 'route_computed' &&
        cancelledMidSearch.outcome === 'cancelled' &&
        cancelledMidSearch.answeredAt < 150 &&
        cancelledMidSearch.engineReleasedAt > cancelledMidSearch.answeredAt &&
        cancelledWithTightBudget.outcome === 'cancelled' &&
        cancelledWithTightBudget.answeredAt < 150 &&
        cancelledWithTightBudget.engineReleasedAt <= TIGHT_DEADLINE + 150 &&
        cancelledWithTightBudget.engineReleasedAt < natural.engineReleasedAt,
      `uncancelled search ${natural.engineReleasedAt} ms; cancelled at 60 ms with the 8 s budget: answered ${cancelledMidSearch.answeredAt} ms, engine stopped ${cancelledMidSearch.engineReleasedAt} ms; with a ${TIGHT_DEADLINE} ms budget: answered ${cancelledWithTightBudget.answeredAt} ms, engine stopped ${cancelledWithTightBudget.engineReleasedAt} ms`,
    );
    observations['engineRssMiBAtEnd'] = { blue: engines.blue ? rss(engines.blue) : null };
  } finally {
    for (const api of apis) await api.close().catch(() => undefined);
    if (engines.blue !== null) await stopEngine(engines.blue);
    if (engines.green !== null) await stopEngine(engines.green);
    await oidc.close().catch(() => undefined);
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  const report = {
    schemaVersion: 1,
    node: 'M2-01k-e',
    measuredAt: new Date().toISOString(),
    what: 'Blue/green graph replacement, production tenant bounds, cancellation and distinct outcomes against two self-hosted GraphHopper engines on loopback, the production API composition, fixture OIDC and an isolated PostgreSQL. Not a coverage review.',
    machine: {
      label: 'this machine (desktop), single caller',
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
    },
    graphs: {
      A: {
        graphBuildId: deploymentA.graphBuildId,
        extractRegion: deploymentA.manifest.extractRegion,
        extractSha256: deploymentA.manifest.extractSha256,
        graphImportedAt: deploymentA.manifest.graphImportedAt,
        roadDataAt: deploymentA.manifest.roadDataAt,
        graphContentSha256: deploymentA.manifest.graphContentSha256,
      },
      C: {
        graphBuildId: deploymentC.graphBuildId,
        extractRegion: deploymentC.manifest.extractRegion,
        extractSha256: deploymentC.manifest.extractSha256,
        graphImportedAt: deploymentC.manifest.graphImportedAt,
        roadDataAt: deploymentC.manifest.roadDataAt,
        graphContentSha256: deploymentC.manifest.graphContentSha256,
        derivedFrom: {
          extractSha256: graphC.sourceSha256,
          tool: graphC.osmiumVersion,
          bbox: CLIP_BBOX,
          strategy: 'complete_ways',
          clipDeterministic: graphC.clipDeterministic,
        },
        builtThisRun: graphC.built,
        importMilliseconds: graphC.importMilliseconds,
        note: 'A different extract (a clip of the allowlisted Seoul extract), not newer map data. The allowlisted URL offered no newer extract.',
      },
    },
    observations,
    checks,
    result: failed.length === 0 ? 'all_checks_passed' : 'checks_failed',
  };
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, reportPath);
  console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.id) }));
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
