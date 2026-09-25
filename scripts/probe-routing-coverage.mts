/**
 * M2-01g: measure the internal pedestrian routing adapter against a real self-hosted
 * GraphHopper engine, and collect Korean pedestrian coverage observations.
 *
 *   node --import tsx scripts/probe-routing-coverage.mts --execute
 *
 * Opt-in only, refuses to run in CI. It never calls an external routing service: the
 * engine is started here from the extract and graph already built under `.geo-build`,
 * binds to loopback, and every request goes through the production adapter
 * (`@workout/server-integrations/routing`) rather than a hand written HTTP call.
 *
 * WHAT THIS IS NOT. A computed route is evidence that a graph had edges, not that a
 * person can walk there. No case in this report is a coverage pass. Every coverage case
 * stays `coverageReview: "not_reviewed"` and the report names what an approval would
 * still need: an independent reviewer and a ground truth we do not have.
 *
 * Expectations are stated in this file BEFORE the run and are not adjusted to match what
 * came back. A case whose observed outcome differs from its pre-stated expectation is
 * reported as a mismatch and makes the whole run exit 1.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WalkingRouteRequest, WalkingRouteResult } from '../packages/contracts/src/routing.js';
import {
  GraphHopperRoutingAdapter,
  RoutingRequestError,
  TenantAdmissionControl,
  WalkingRouteService,
  createRoutingEngineEndpoint,
  hashGraphDirectory,
  ROUTING_GRAPH_MANIFEST_FILE,
  loadRoutingDeployment,
  type RoutingDeployment,
  type RoutingGraphManifest,
  type RoutingEngineTransport,
} from '../packages/server/integrations/src/routing/index.js';
import {
  routingGraphConfig,
  routingGraphDirectory,
  startEngine,
  stopEngine,
  waitForEngine,
  type EngineHandle,
} from './build-routing-graph.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const servingConfigSource = join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml');
const experimentRoot = join(workRoot, 'routing-graph', 'experiments');
const reportPath = join(repositoryRoot, 'docs/implementation/research/routing-coverage-korea.json');

type Position = [number, number];

/**
 * Pre-stated expectations. `expectedOutcome` is what a correct implementation must
 * answer; `expectedDistanceMeters` bounds a computed route so that "it answered" is not
 * mistaken for "it answered sensibly". `groundTruth` is what a reviewer would have to
 * check against, and we do not have it — which is why nothing here is a pass.
 */
interface CoverageCase {
  readonly id: string;
  readonly theme: 'urban-road' | 'crossing' | 'bridge' | 'stairs' | 'park' | 'access-time';
  readonly context: string;
  readonly waypoints: readonly Position[];
  readonly expectedOutcome: WalkingRouteResult['outcome'];
  readonly expectedDistanceMeters?: readonly [number, number];
  readonly reviewerMustCheck: string;
  /**
   * Set only when a pre-stated expectation was revised, and it records what the original
   * said and what was observed. An expectation is never edited to match an engine
   * behaviour; the only permitted reason is that the case did not set up the situation it
   * claimed to test.
   */
  readonly expectationRevision?: string;
}

const coverageCases: readonly CoverageCase[] = [
  {
    id: 'KRC-01',
    theme: 'urban-road',
    context: 'Gwanghwamun to Seoul City Hall along Sejong-daero footways',
    waypoints: [
      [126.9769, 37.5759],
      [126.9779, 37.5663],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [1000, 2000],
    reviewerMustCheck:
      'That the drawn line follows footways that exist on the ground today and are open to the public.',
  },
  {
    id: 'KRC-02',
    theme: 'crossing',
    context:
      'Opposite sides of Sejong-daero; a correct answer must use a crossing, not cross the roadway',
    waypoints: [
      [126.9765, 37.5705],
      [126.9785, 37.5705],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [180, 1500],
    reviewerMustCheck:
      'That the route uses a marked crossing or underpass, and that the crossing is not closed or under construction.',
  },
  {
    id: 'KRC-03',
    theme: 'bridge',
    context: 'Han river crossing at Dongjak; requires a bridge carrying a pedestrian way',
    waypoints: [
      [126.98, 37.506],
      [126.98, 37.518],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [1500, 5000],
    reviewerMustCheck:
      'That the bridge actually carries a walkway and that access ramps or stairs at both ends are usable.',
    expectationRevision:
      'The first run of this case used [126.93, 37.525] to [126.932, 37.537] near Yeouido and expected route_computed within 1000-4000 m. It observed snap_too_far, because the northern waypoint lies more than 120 m from any pedestrian way: the case had not placed itself on the network it claimed to test. The waypoints were moved to a pair whose snap distances were checked to be 14.6 m and 2.0 m before the outcome expectation was restated. The engine behaviour itself was not the reason for the change, and the original expectation was not weakened.',
  },
  {
    id: 'KRC-04',
    theme: 'stairs',
    context: 'Namsan slope; stair and steep-path handling',
    waypoints: [
      [126.9883, 37.5512],
      [126.98, 37.556],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [400, 4000],
    reviewerMustCheck:
      'That steps on the route are tagged, and whether a step-free alternative exists. The result carries no step count and no accessibility grade.',
  },
  {
    id: 'KRC-05',
    theme: 'park',
    context: 'Seoul Forest internal park paths',
    waypoints: [
      [127.038, 37.5445],
      [127.043, 37.547],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [300, 3000],
    reviewerMustCheck:
      'That the park paths are public and that the park is open at the time the route would be walked.',
  },
  {
    id: 'KRC-06',
    theme: 'access-time',
    context:
      'Cheonggyecheon streamside path, which has access restrictions this profile cannot model',
    waypoints: [
      [126.979, 37.569],
      [126.993, 37.569],
    ],
    expectedOutcome: 'route_computed',
    expectedDistanceMeters: [800, 4000],
    reviewerMustCheck:
      'Opening hours, flood closure and night access. The profile has no time-of-day model at all, so a computed route says nothing about when it is walkable.',
  },
];

/** Controls. These do not measure Korea; they measure whether the probe measures anything. */
interface ControlCase {
  readonly id: string;
  readonly kind:
    | 'negative-offshore'
    | 'straight-line-echo'
    | 'graph-mismatch'
    | 'snap-limit'
    | 'engine-budget'
    | 'deadline'
    | 'cancellation'
    | 'overload'
    | 'request-bound';
  readonly context: string;
  readonly expectedOutcome: WalkingRouteResult['outcome'] | 'rejected_before_engine';
}

const controlCases: readonly ControlCase[] = [
  {
    id: 'CTL-OFFSHORE',
    kind: 'negative-offshore',
    context:
      'Yellow Sea coordinates with no pedestrian network. A computed route would be a defect.',
    expectedOutcome: 'outside_coverage',
  },
  {
    id: 'CTL-ECHO',
    kind: 'straight-line-echo',
    context:
      'A stubbed engine that answers with the requested points and 0 m, the OSRM fail-open shape. Must be refused, never reported as a route.',
    expectedOutcome: 'engine_contract_violation',
  },
  {
    id: 'CTL-GRAPH',
    kind: 'graph-mismatch',
    context:
      'The same live engine, pinned to a different engine version. Its answer is not comparable.',
    expectedOutcome: 'graph_mismatch',
  },
  {
    id: 'CTL-SNAP',
    kind: 'snap-limit',
    context:
      'A live waypoint about 90 m from the network, with the snap limit lowered to 5 m for this case only.',
    expectedOutcome: 'snap_too_far',
  },
  {
    id: 'CTL-BUDGET',
    kind: 'engine-budget',
    context: 'The live engine with the search budget lowered to 10 nodes.',
    expectedOutcome: 'compute_budget_exceeded',
  },
  {
    id: 'CTL-DEADLINE',
    kind: 'deadline',
    context: 'The live engine with the caller deadline lowered to 1 ms.',
    expectedOutcome: 'timeout',
  },
  {
    id: 'CTL-CANCEL',
    kind: 'cancellation',
    context: 'The caller aborts before the engine answers.',
    expectedOutcome: 'cancelled',
  },
  {
    id: 'CTL-OVERLOAD',
    kind: 'overload',
    context:
      'One tenant past its rate window. The engine must not be called for the refused request.',
    expectedOutcome: 'overloaded',
  },
  {
    id: 'CTL-REQUEST-BOUND',
    kind: 'request-bound',
    context: 'A leg longer than the straight-line bound. Refused before the engine is called.',
    expectedOutcome: 'rejected_before_engine',
  },
];

/** The engine's listener port lives in the pinned serving profile, not in a flag. */
const enginePort = 8991;

function parseArguments(argv: readonly string[]): { execute: true } | null {
  if (argv.some((argument) => argument !== '--execute')) return null;
  return argv.includes('--execute') ? { execute: true } : null;
}

/**
 * Engine behaviour this run observes for itself, instead of citing a note from a terminal.
 * Each experiment starts the engine with a stated configuration change, sends one stated
 * request, and keeps the raw answer.
 */
interface EngineExperiment {
  readonly id: string;
  readonly question: string;
  readonly configurationChange: string;
  readonly requestPath: string;
}

const engineExperiments: readonly EngineExperiment[] = [
  {
    id: 'EXP-TIMEOUT-AS-NOROUTE',
    question:
      'When the engine exhausts its own routing.timeout_ms, can the answer be told apart from a genuinely disconnected pair?',
    configurationChange: 'routing.timeout_ms: 30000 -> 1',
    requestPath:
      '/route?profile=foot&ch.disable=true&points_encoded=false&instructions=false&point=37.5759,126.9769&point=37.5663,126.9779',
  },
  {
    id: 'EXP-CONFIG-KEY-IGNORED',
    question:
      'Does the configuration key routing.non_ch.max_visited_nodes bound the search the way the request parameter does?',
    configurationChange: 'add routing.non_ch.max_visited_nodes: 10',
    requestPath:
      '/route?profile=foot&ch.disable=true&points_encoded=false&instructions=false&point=37.5759,126.9769&point=37.5663,126.9779',
  },
  {
    id: 'EXP-REQUEST-PARAM-ENFORCED',
    question: 'Does the request parameter max_visited_nodes bound the search?',
    configurationChange: 'none (pinned serving profile)',
    requestPath:
      '/route?profile=foot&ch.disable=true&points_encoded=false&instructions=false&max_visited_nodes=10&point=37.5759,126.9769&point=37.5663,126.9779',
  },
];

function systemClock() {
  return { now: () => new Date() };
}

/** A stubbed transport used only for the straight-line control. No engine is involved. */
function echoTransport(info: string, waypoints: readonly Position[]): RoutingEngineTransport {
  return {
    async send(input) {
      if (input.path === '/info')
        return { status: 200, bodyText: info, truncated: false, byteLength: info.length };
      const body = JSON.stringify({
        paths: [
          {
            distance: 0,
            time: 0,
            points: { type: 'LineString', coordinates: waypoints },
            snapped_waypoints: { type: 'LineString', coordinates: waypoints },
          },
        ],
      });
      return { status: 200, bodyText: body, truncated: false, byteLength: body.length };
    },
  };
}

/**
 * A deployment for a graph whose manifest records a different engine version. It is built
 * by copying the real manifest into a throwaway directory of its own, so it still has to
 * pass the same on-disk verification any deployment passes — there is no back door that
 * skips it.
 */
async function mismatchedDeploymentFactory(options: {
  readonly sourceManifest: RoutingGraphManifest;
  readonly directory: string;
  readonly endpoint: Parameters<typeof loadRoutingDeployment>[0]['endpoint'];
  readonly enginePath: string;
  readonly configPath: string;
}) {
  await mkdir(options.directory, { recursive: true });
  await writeFile(join(options.directory, 'edges'), 'synthetic-graph-for-mismatch-control');
  await writeFile(
    join(options.directory, 'properties.txt'),
    `datareader.import.date=${options.sourceManifest.graphImportedAt}\ndatareader.data.date=${options.sourceManifest.roadDataAt}\n`,
  );
  const manifest: RoutingGraphManifest = {
    ...options.sourceManifest,
    engineVersion: '9.9',
    graphContentSha256: await hashGraphDirectory(options.directory),
  };
  await writeFile(
    join(options.directory, ROUTING_GRAPH_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return loadRoutingDeployment({
    graphDirectory: options.directory,
    engineArtifactPath: options.enginePath,
    profileConfigPath: options.configPath,
    endpoint: options.endpoint,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-routing-coverage.mts --execute. ' +
        'Starts the self-hosted GraphHopper engine on loopback from the graph already built under .geo-build ' +
        'and drives the production routing adapter. Never use as CI, and never read its output as a coverage pass.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  for (const required of [extractPath, jarPath, servingConfigSource]) {
    try {
      await stat(required);
    } catch {
      throw new Error(`MISSING_PREREQUISITE: ${required}`);
    }
  }

  // The identity comes from the manifest the graph build wrote, re-verified here against
  // the graph files, the engine jar and the profile configuration this run will actually
  // start. There is no way to hand the adapter an identity that was not checked.
  const endpoint = createRoutingEngineEndpoint(`http://127.0.0.1:${enginePort}/`);
  let deployment: RoutingDeployment;
  try {
    deployment = await loadRoutingDeployment({
      graphDirectory: routingGraphDirectory,
      engineArtifactPath: jarPath,
      profileConfigPath: routingGraphConfig,
      endpoint,
    });
  } catch (error) {
    throw new Error(
      `DEPLOYMENT_NOT_VERIFIED: ${error instanceof Error ? `${error.message} ${'detail' in error ? String(error.detail) : ''}` : 'unknown'}. ` +
        'Run: node --import tsx scripts/build-routing-graph.mts --execute',
    );
  }
  const verified = { manifest: deployment.manifest, graphBuildId: deployment.graphBuildId };

  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    extractPath,
    graphPath: routingGraphDirectory,
  });

  await mkdir(experimentRoot, { recursive: true });
  const coverageResults: Record<string, unknown>[] = [];
  const engineObservations: Record<string, unknown>[] = [];
  const controlResults: Record<string, unknown>[] = [];
  const mismatches: string[] = [];

  try {
    await waitForEngine(engine, enginePort);
    const clock = systemClock();
    const adapter = new GraphHopperRoutingAdapter({ deployment, clock });
    const service = new WalkingRouteService({
      adapter,
      admission: new TenantAdmissionControl({ now: () => Date.now() }),
      clock,
    });

    let revision = 0;
    const request = (waypoints: readonly Position[]): WalkingRouteRequest => ({
      schemaVersion: 1,
      requestId: `probe-${(revision += 1)}`,
      requestRevision: revision,
      profileId: 'foot-v1',
      waypoints: waypoints.map(([longitude, latitude]): Position => [longitude, latitude]),
    });

    for (const testCase of coverageCases) {
      const started = Date.now();
      const { result } = await service.compute('probe-tenant', request(testCase.waypoints), {});
      const latencyMs = Date.now() - started;
      const distanceMeters = result.outcome === 'route_computed' ? result.distanceMeters : null;
      const withinExpected =
        result.outcome === testCase.expectedOutcome &&
        (testCase.expectedDistanceMeters === undefined ||
          (distanceMeters !== null &&
            distanceMeters >= testCase.expectedDistanceMeters[0] &&
            distanceMeters <= testCase.expectedDistanceMeters[1]));
      if (!withinExpected)
        mismatches.push(
          `${testCase.id}: expected ${testCase.expectedOutcome}${
            testCase.expectedDistanceMeters
              ? ` within ${testCase.expectedDistanceMeters.join('-')} m`
              : ''
          }, observed ${result.outcome}${distanceMeters === null ? '' : ` at ${distanceMeters.toFixed(1)} m`}`,
        );
      coverageResults.push({
        caseId: testCase.id,
        theme: testCase.theme,
        context: testCase.context,
        waypoints: testCase.waypoints,
        expectedOutcome: testCase.expectedOutcome,
        expectedDistanceMeters: testCase.expectedDistanceMeters ?? null,
        expectationRevision: testCase.expectationRevision ?? null,
        observedOutcome: result.outcome,
        distanceMeters,
        durationSeconds: result.outcome === 'route_computed' ? result.durationSeconds : null,
        geometryPoints:
          result.outcome === 'route_computed' ? result.geometry.coordinates.length : null,
        geometrySha256:
          result.outcome === 'route_computed'
            ? createHash('sha256').update(JSON.stringify(result.geometry.coordinates)).digest('hex')
            : null,
        // The coordinates themselves, so a reviewer can plot the route and check it
        // against a map instead of taking a hash and a point count on trust.
        geometry: result.outcome === 'route_computed' ? result.geometry.coordinates : null,
        snappedWaypoints:
          result.outcome === 'route_computed'
            ? result.snappedWaypoints.map((entry) => ({
                requested: entry.requested,
                snapped: entry.snapped,
                snapDistanceMeters: Number(entry.snapDistanceMeters.toFixed(3)),
              }))
            : null,
        maxSnapMeters:
          result.outcome === 'route_computed'
            ? Number(
                Math.max(
                  ...result.snappedWaypoints.map((entry) => entry.snapDistanceMeters),
                ).toFixed(2),
              )
            : null,
        warnings: result.computation.warnings,
        latencyMs,
        graph: result.computation.graph,
        matchesPreStatedExpectation: withinExpected,
        // The engine answering is not walkability. This never becomes a pass in this file.
        coverageReview: 'not_reviewed',
        reviewerMustCheck: testCase.reviewerMustCheck,
      });
    }

    /** Runs one control and records the outcome against its pre-stated expectation. */
    const recordControl = (
      id: string,
      observedOutcome: string,
      extra: Record<string, unknown> = {},
    ) => {
      const testCase = controlCases.find((entry) => entry.id === id);
      if (testCase === undefined) throw new Error(`UNKNOWN_CONTROL: ${id}`);
      const matches = observedOutcome === testCase.expectedOutcome;
      if (!matches)
        mismatches.push(`${id}: expected ${testCase.expectedOutcome}, observed ${observedOutcome}`);
      controlResults.push({
        caseId: id,
        kind: testCase.kind,
        context: testCase.context,
        expectedOutcome: testCase.expectedOutcome,
        observedOutcome,
        matchesPreStatedExpectation: matches,
        ...extra,
      });
    };

    const offshore = await service.compute(
      'probe-tenant',
      request([
        [125.5, 36.5],
        [125.52, 36.52],
      ]),
      {},
    );
    recordControl('CTL-OFFSHORE', offshore.result.outcome);

    const infoResponse = await fetch(`http://127.0.0.1:${enginePort}/info`);
    const infoBody = await infoResponse.text();
    const echoAdapter = new GraphHopperRoutingAdapter({
      deployment: await loadRoutingDeployment({
        graphDirectory: routingGraphDirectory,
        engineArtifactPath: jarPath,
        profileConfigPath: routingGraphConfig,
        endpoint,
        transportFactory: () =>
          echoTransport(infoBody, [
            [126.9769, 37.5759],
            [126.9779, 37.5663],
          ]),
      }),
      clock,
    });
    const echo = await echoAdapter.computeWalkingRoute(
      request([
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ]),
    );
    recordControl('CTL-ECHO', echo.outcome);

    // A deployment whose manifest says a different engine version. It is produced the
    // only way any deployment can be: by verifying a graph directory on disk.
    const mismatchAdapter = new GraphHopperRoutingAdapter({
      deployment: await mismatchedDeploymentFactory({
        sourceManifest: deployment.manifest,
        directory: join(experimentRoot, 'mismatch-graph'),
        endpoint,
        enginePath: jarPath,
        configPath: routingGraphConfig,
      }),
      clock,
    });
    const mismatched = await mismatchAdapter.computeWalkingRoute(
      request([
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ]),
    );
    recordControl('CTL-GRAPH', mismatched.outcome);

    const snapAdapter = new GraphHopperRoutingAdapter({
      deployment,
      clock,
      snapLimitMeters: 5,
    });
    const snapped = await snapAdapter.computeWalkingRoute(
      request([
        [126.98, 37.66],
        [126.9779, 37.5663],
      ]),
    );
    recordControl('CTL-SNAP', snapped.outcome);

    const budgetAdapter = new GraphHopperRoutingAdapter({
      deployment,
      clock,
      maxVisitedNodes: 10,
    });
    const budget = await budgetAdapter.computeWalkingRoute(
      request([
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ]),
    );
    recordControl('CTL-BUDGET', budget.outcome);

    const deadlineAdapter = new GraphHopperRoutingAdapter({
      deployment,
      clock,
      deadlineMilliseconds: 1,
    });
    const deadline = await deadlineAdapter.computeWalkingRoute(
      request([
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ]),
    );
    recordControl('CTL-DEADLINE', deadline.outcome);

    const cancellation = new AbortController();
    const cancelled = adapter.computeWalkingRoute(
      request([
        [126.9769, 37.5759],
        [126.9779, 37.5663],
      ]),
      { signal: cancellation.signal },
    );
    cancellation.abort();
    recordControl('CTL-CANCEL', (await cancelled).outcome);

    const burstService = new WalkingRouteService({
      adapter,
      admission: new TenantAdmissionControl(
        { now: () => Date.now() },
        {
          concurrency: 2,
          requestsPerWindow: 2,
          windowMilliseconds: 60_000,
          maxTrackedTenants: 16,
        },
      ),
      clock,
    });
    const burst: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { result, retryAfterSeconds } = await burstService.compute(
        'burst-tenant',
        request([
          [126.9769, 37.5759],
          [126.9779, 37.5663],
        ]),
        {},
      );
      burst.push(
        `${result.outcome}${retryAfterSeconds === null ? '' : `(retry-after ${retryAfterSeconds}s)`}`,
      );
    }
    recordControl(
      'CTL-OVERLOAD',
      burst.at(-1)?.startsWith('overloaded') ? 'overloaded' : (burst.at(-1) ?? 'none'),
      {
        sequence: burst,
      },
    );

    let boundOutcome = 'not_rejected';
    try {
      await service.compute(
        'probe-tenant',
        request([
          [126.9769, 37.5759],
          [127.9769, 37.5759],
        ]),
        {},
      );
    } catch (error) {
      boundOutcome =
        error instanceof RoutingRequestError ? 'rejected_before_engine' : 'unexpected_error';
    }
    recordControl('CTL-REQUEST-BOUND', boundOutcome);
  } finally {
    await stopEngine(engine);
  }

  // Engine behaviour claims are measured here rather than cited from a terminal session.
  // Each one restarts the engine with a stated configuration change and keeps the raw
  // answer, so the claim can be re-derived from this file and the JSON alone.
  const baseConfig = await readFile(servingConfigSource, 'utf8');
  await mkdir(experimentRoot, { recursive: true });
  for (const experiment of engineExperiments) {
    const configText =
      experiment.id === 'EXP-TIMEOUT-AS-NOROUTE'
        ? baseConfig.replace('routing.timeout_ms: 30000', 'routing.timeout_ms: 1')
        : experiment.id === 'EXP-CONFIG-KEY-IGNORED'
          ? baseConfig.replace(
              'routing.non_ch.max_waypoint_distance: 1000000',
              'routing.non_ch.max_waypoint_distance: 1000000\n  routing.non_ch.max_visited_nodes: 10',
            )
          : baseConfig;
    if (
      experiment.configurationChange !== 'none (pinned serving profile)' &&
      configText === baseConfig
    )
      throw new Error(`EXPERIMENT_CONFIG_UNCHANGED: ${experiment.id}`);
    const configPath = join(experimentRoot, `${experiment.id}.yml`);
    await writeFile(configPath, configText);
    const experimentEngine: EngineHandle = startEngine({
      jarPath,
      configPath,
      extractPath,
      graphPath: routingGraphDirectory,
    });
    let observation: Record<string, unknown>;
    try {
      await waitForEngine(experimentEngine, enginePort);
      const response = await fetch(`http://127.0.0.1:${enginePort}${experiment.requestPath}`);
      const rawBody = (await response.text()).slice(0, 2000);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = null;
      }
      const asRecord = (parsed ?? {}) as {
        message?: unknown;
        hints?: { details?: unknown; 'visited_nodes.sum'?: unknown }[] | Record<string, unknown>;
        paths?: { distance?: unknown }[];
      };
      const visitedNodes =
        !Array.isArray(asRecord.hints) && typeof asRecord.hints === 'object'
          ? (asRecord.hints as Record<string, unknown>)['visited_nodes.sum']
          : null;
      observation = {
        httpStatus: response.status,
        engineMessage: typeof asRecord.message === 'string' ? asRecord.message : null,
        exceptionDetail:
          Array.isArray(asRecord.hints) && typeof asRecord.hints[0]?.details === 'string'
            ? asRecord.hints[0].details
            : null,
        routeReturned: Array.isArray(asRecord.paths) && asRecord.paths.length > 0,
        distanceMeters:
          Array.isArray(asRecord.paths) && typeof asRecord.paths[0]?.distance === 'number'
            ? asRecord.paths[0].distance
            : null,
        visitedNodesSum: typeof visitedNodes === 'number' ? visitedNodes : null,
        rawResponseFirst2000Bytes: rawBody,
      };
    } finally {
      await stopEngine(experimentEngine);
    }
    engineObservations.push({
      id: experiment.id,
      question: experiment.question,
      configurationChange: experiment.configurationChange,
      requestUrl: `http://127.0.0.1:${enginePort}${experiment.requestPath}`,
      configPath: `.geo-build/routing-graph/experiments/${experiment.id}.yml`,
      ...observation,
    });
  }
  await rm(experimentRoot, { recursive: true, force: true });

  // The experiments ran against the same graph directory; prove it is still the graph the
  // manifest describes, so the coverage results above are not attributed to a changed one.
  const graphContentAfterRun = await hashGraphDirectory(routingGraphDirectory);

  // A probe that measures nothing must not pass. These assertions fail the run when the
  // report would otherwise be empty or when a control did not actually exercise anything.
  const emptiness: string[] = [];
  if (coverageResults.length !== coverageCases.length)
    emptiness.push(`coverage cases ran ${coverageResults.length}/${coverageCases.length}`);
  if (controlResults.length !== controlCases.length)
    emptiness.push(`controls ran ${controlResults.length}/${controlCases.length}`);
  if (!coverageResults.some((entry) => entry.observedOutcome === 'route_computed'))
    emptiness.push('no coverage case produced a route at all');
  if (!coverageResults.every((entry) => typeof entry.graph === 'object' && entry.graph !== null))
    emptiness.push('a coverage case carries no graph identity');
  if (
    !coverageResults
      .filter((entry) => entry.observedOutcome === 'route_computed')
      .every((entry) => Array.isArray(entry.geometry) && entry.geometry.length >= 2)
  )
    emptiness.push('a computed coverage case carries no route geometry');
  if (engineObservations.length !== engineExperiments.length)
    emptiness.push(
      `engine experiments ran ${engineObservations.length}/${engineExperiments.length}`,
    );
  if (graphContentAfterRun !== verified.manifest.graphContentSha256)
    emptiness.push('the graph files changed during the run, so the results are not attributable');

  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope:
      'M2-01g internal routing adapter measured against a self-hosted GraphHopper engine on a developer machine. Not a production deployment.',
    coverageStatus: 'not_reviewed',
    coverageStatusReason:
      'HTTP 200 and a computed geometry are not walkability, accessibility or safety. No independent reviewer checked these routes against ground truth, no field or official source comparison was made, and the pedestrian profile models no opening hours, temporary closures, night access or step-free alternatives. The status stays not_reviewed.',
    missingForCoverageApproval: [
      'An independent reviewer who is not the implementer, comparing each route against an authoritative source or a field check.',
      'A ground truth for crossings, bridge walkways, stairs, park paths and access times in the sampled areas.',
      'Samples outside Seoul: the pinned extract is a Seoul city extract and says nothing about the rest of Korea.',
      'A step-free and accessibility judgement; the profile carries no such model and the result carries no such field.',
      'A time-of-day model; every case here is time independent.',
    ],
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    graphManifest: verified.manifest,
    graphBuildId: verified.graphBuildId,
    graphContentVerifiedBeforeRun: verified.manifest.graphContentSha256,
    graphContentVerifiedAfterRun: graphContentAfterRun,
    deploymentVerification: {
      graphDirectory: '.geo-build/routing-graph/foot',
      engineArtifactPath: '.geo-build/graphhopper/graphhopper-web.jar',
      profileConfigPath: '.geo-build/routing-graph/config-serving.yml',
      checked:
        'graph files, engine artifact and profile configuration all hashed and compared to the manifest before any request',
    },
    coverageResults,
    controlResults,
    engineObservations,
    mismatches,
    emptiness,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, reportPath);
  console.log(
    JSON.stringify({
      coverage: coverageResults.map((entry) => `${entry.caseId}:${entry.observedOutcome}`),
      controls: controlResults.map((entry) => `${entry.caseId}:${entry.observedOutcome}`),
      mismatches,
      emptiness,
    }),
  );
  if (mismatches.length > 0 || emptiness.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
