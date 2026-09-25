/**
 * M2-01af: roll the rebuilt graph out, from the served graph on the old serving profile to a
 * full re-import on the new one, through M2-01k-e's blue/green procedure.
 *
 *   ROUTING_GRAPH_ROOT=<absolute dir outside .geo-build> \
 *     node --import tsx scripts/probe-routing-profile-rollout.mts --execute
 *
 * `ROUTING_GRAPH_ROOT` names the green deployment `build-routing-graph.mts` imported there
 * (graph and profile copy). Blue is the served deployment under `.geo-build/routing-graph`,
 * whose profile copy predates M2-01af. Opt-in only, refuses to run in CI, binds the fixture
 * identity provider on 4400 (hold the harness lock). Engines listen on loopback 8991-8994.
 *
 * What this proves, and nothing more:
 *
 * 1. The profile is part of the graph's identity: green was imported with the repository's
 *    serving profile, its manifest pins that file's SHA-256, and the old profile copy cannot
 *    serve it (`PROFILE_CONFIG_MISMATCH`) — a refused switch that changes nothing.
 * 2. Blue (old profile, the launch helper adds the request-log override) and green (new
 *    profile, no override: the profile switches the request log off and pins
 *    `RouteResource` itself) run side by side, and the API moves from one to the other in
 *    one step while requests keep arriving, then rolls back the same way.
 * 3. A course saved on the old graph is not recomputed. Saving a route proposed on the new
 *    graph needs the two-sided acknowledgement `{previous: old, next: new}`; an
 *    acknowledgement that names the old graph as next is refused.
 * 4. Neither engine wrote any of the waypoints this run sent.
 *
 * WHAT THIS IS NOT. Green is a re-import of the same extract, not newer map data. Timings
 * are single-caller values on this machine only.
 */
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  courseImportResultSchema,
  courseReadResultSchema,
  courseRouteProposalResultSchema,
  type CourseWaypoint,
} from '../packages/contracts/src/courses.ts';
import { walkingRouteResultSchema } from '../packages/contracts/src/routing.ts';
import { auditLogLines, coordinateProbes } from '../packages/server/courses/src/log-audit.ts';
import {
  createRoutingEngineEndpoint,
  loadRoutingDeployment,
} from '../packages/server/integrations/src/routing/index.ts';
import { createConfiguredApi } from '../apps/api/src/configured.ts';
import {
  switchRefusalCode,
  type RoutingDeploymentSwitch,
} from '../apps/api/src/routing-deployment.ts';
import {
  relocatedDeploymentNote,
  routingGraphConfig,
  routingGraphDirectory,
  routingGraphRootFrom,
  sha256File,
  startEngine,
  stopEngine,
  waitForEngine,
  type EngineHandle,
  type EnginePorts,
} from './build-routing-graph.mjs';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
import { REQUEST_LOG_OVERRIDE, profileDisablesRequestLog } from './geo/graphhopper-launch.mjs';
import {
  PUBLIC_ORIGIN,
  Session,
  clearAdmissionHistory,
  detectedBin,
  startDatabase,
  type Api,
} from './probe-routing-operational.mts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const servingProfile = join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml');
/** Blue: the served deployment, always the default layout under `.geo-build`. */
const blueRoot = routingGraphRootFrom(undefined);
const blueGraph = join(blueRoot, 'foot');
const blueConfig = join(blueRoot, 'config-serving.yml');

const BLUE: EnginePorts = { application: 8991, admin: 8992 };
const GREEN: EnginePorts = { application: 8993, admin: 8994 };

type Position = [number, number];
/** Pre-stated, from M2-01g's KRC-01 case. */
const KRC01: Position[] = [
  [126.9769, 37.5759],
  [126.9779, 37.5663],
];
const VIA: Position = [126.9786, 37.5712];

const checks: { id: string; passed: boolean; detail: string }[] = [];
function check(id: string, passed: boolean, detail: string) {
  checks.push({ id, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}
const observations: Record<string, unknown> = {};
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

async function computeOver(api: Api, session: Session, points: Position[], requestId: string) {
  const response = await api.inject({
    method: 'POST',
    url: '/bff/v1/routing/walking-routes',
    headers: session.headers(true),
    payload: {
      schemaVersion: 1,
      requestId,
      requestRevision: 1,
      profileId: 'foot-v1',
      waypoints: points,
    },
  });
  const parsed = walkingRouteResultSchema.safeParse(response.json());
  return {
    status: response.statusCode,
    outcome: parsed.success ? parsed.data.outcome : 'unparsed',
    graph: parsed.success ? parsed.data.computation.graph.graphBuildId : null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--execute') || argv.length !== 1 || !process.env.ROUTING_GRAPH_ROOT) {
    console.log(
      'Opt-in only: ROUTING_GRAPH_ROOT=<green deployment, outside .geo-build> node --import tsx ' +
        'scripts/probe-routing-profile-rollout.mts --execute. Runs two real engines on loopback ' +
        '8991-8994, the production API composition and the fixture OIDC provider on 4400 (hold the ' +
        'harness lock), and writes a report. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');
  // `routingGraphDirectory`/`routingGraphConfig` follow ROUTING_GRAPH_ROOT: that is green.
  const greenGraph = routingGraphDirectory;
  const greenConfig = routingGraphConfig;
  for (const required of [extractPath, jarPath, blueGraph, blueConfig, greenGraph, greenConfig])
    await stat(required);

  const envFor = (graphDirectory: string, configPath: string, port: number) => ({
    ROUTING_ENGINE_URL: `http://127.0.0.1:${port}/`,
    ROUTING_GRAPH_DIRECTORY: graphDirectory,
    ROUTING_ENGINE_ARTIFACT: jarPath,
    ROUTING_PROFILE_CONFIG: configPath,
  });
  const verify = (graphDirectory: string, configPath: string, port: number) =>
    loadRoutingDeployment({
      graphDirectory,
      engineArtifactPath: jarPath,
      profileConfigPath: configPath,
      endpoint: createRoutingEngineEndpoint(`http://127.0.0.1:${port}/`),
    });
  const blue = await verify(blueGraph, blueConfig, BLUE.application);
  const green = await verify(greenGraph, greenConfig, GREEN.application);
  const graphOld = blue.graphBuildId;
  const graphNew = green.graphBuildId;
  const repositoryProfileSha256 = await sha256File(servingProfile);
  const blueProfileText = await readFile(blueConfig, 'utf8');
  const greenProfileText = await readFile(greenConfig, 'utf8');
  check(
    'green-is-a-full-reimport-on-the-new-profile',
    graphOld !== graphNew &&
      green.manifest.profileConfigSha256 === repositoryProfileSha256 &&
      blue.manifest.profileConfigSha256 !== green.manifest.profileConfigSha256 &&
      green.manifest.extractSha256 === blue.manifest.extractSha256 &&
      green.manifest.graphImportedAt !== blue.manifest.graphImportedAt &&
      profileDisablesRequestLog(greenProfileText) &&
      !profileDisablesRequestLog(blueProfileText),
    `old ${graphOld} profile ${blue.manifest.profileConfigSha256.slice(0, 12)} / new ${graphNew} profile ${green.manifest.profileConfigSha256.slice(0, 12)} (repository ${repositoryProfileSha256.slice(0, 12)}); same extract ${green.manifest.extractSha256.slice(0, 12)}; imported ${blue.manifest.graphImportedAt} / ${green.manifest.graphImportedAt}`,
  );

  const directory = await mkdtemp(join(tmpdir(), 'workout-routing-rollout-'));
  const storageRoot = join(directory, 'objects');
  await mkdir(storageRoot, { recursive: true });
  const database = await startDatabase(directory, detectedBin);
  const oidc = await startFixtureOidc();
  const engines: { blue: EngineHandle | null; green: EngineHandle | null } = {
    blue: null,
    green: null,
  };
  let api: Api | null = null;
  const sent: Position[] = [...KRC01, VIA];

  try {
    for (const port of [BLUE.application, BLUE.admin, GREEN.application, GREEN.admin]) {
      const busy = await fetch(`http://127.0.0.1:${port}/`).then(
        () => true,
        () => false,
      );
      if (busy) throw new Error(`PORT_BUSY: ${port}`);
    }
    // Both through the launch helper, as every launcher does: it adds the request-log
    // override for blue's old profile and leaves it out for green's.
    engines.blue = startEngine({
      jarPath,
      configPath: blueConfig,
      extractPath,
      graphPath: blueGraph,
      ports: BLUE,
    });
    engines.green = startEngine({
      jarPath,
      configPath: greenConfig,
      extractPath,
      graphPath: greenGraph,
      ports: GREEN,
    });
    await Promise.all([
      waitForEngine(engines.blue, BLUE.application),
      waitForEngine(engines.green, GREEN.application),
    ]);
    const blueArguments = (engines.blue.process.spawnargs ?? []).join(' ');
    const greenArguments = (engines.green.process.spawnargs ?? []).join(' ');
    check(
      'override-only-where-the-profile-leaves-the-request-log-on',
      blueArguments.includes(REQUEST_LOG_OVERRIDE) &&
        !greenArguments.includes(REQUEST_LOG_OVERRIDE),
      `blue ${blueArguments.includes(REQUEST_LOG_OVERRIDE) ? 'with' : 'without'} override, green ${greenArguments.includes(REQUEST_LOG_OVERRIDE) ? 'with' : 'without'} override`,
    );

    let control: RoutingDeploymentSwitch | null = null;
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
    api = await createConfiguredApi(
      { ...baseEnv, ...envFor(blueGraph, blueConfig, BLUE.application) },
      {
        onRoutingDeployments: (received) => {
          control = received;
        },
      },
    );
    await api.ready();
    if (control === null) throw new Error('NO_ROUTING_CONTROL');
    const deployments = control as RoutingDeploymentSwitch;
    const serving = api;
    const alice = new Session();
    await alice.login(serving, 'alice');

    // ---- A course saved on the old graph.
    const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="m2-01af" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>M2-01af rollout</name>${[
      KRC01[0] as Position,
      VIA,
      KRC01[1] as Position,
    ]
      .map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`)
      .join('')}</rte></gpx>`;
    const imported = courseImportResultSchema.parse(
      (
        await serving.inject({
          method: 'POST',
          url: '/bff/v1/courses/imports',
          headers: alice.headers(true),
          payload: {
            name: null,
            originalFilename: 'm2-01af.gpx',
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
      const response = await serving.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-proposals`,
        headers: alice.headers(true),
        payload: {
          requestId: `rollout-${randomUUID()}`,
          draftRevision,
          waypoints: waypoints([KRC01[0] as Position, VIA, KRC01[1] as Position]),
        },
      });
      return { result: courseRouteProposalResultSchema.parse(response.json()), draftRevision };
    };
    const save = async (
      proposal: Awaited<ReturnType<typeof propose>>,
      previous: string | null,
      next: string,
    ) => {
      if (proposal.result.outcome !== 'route_computed') throw new Error('NO_PROPOSAL');
      const head = courseReadResultSchema.parse(
        (
          await serving.inject({
            method: 'GET',
            url: `/bff/v1/courses/${courseId}`,
            headers: alice.headers(false),
          })
        ).json(),
      );
      if (head.status !== 'available') throw new Error('COURSE_UNAVAILABLE');
      const response = await serving.inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${courseId}`,
        headers: alice.headers(true),
        payload: {
          expectedRevision: head.course.headRevision,
          change: {
            kind: 'reroute',
            proposalId: proposal.result.proposal.proposalId,
            draftRevision: proposal.draftRevision,
            acknowledgedGraph: { previous, next },
          },
        },
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
    const onOld = await propose();
    const savedOnOld = await save(onOld, null, graphOld);
    const storedOnOld = await revisions();
    check(
      'course-saved-on-the-old-graph',
      savedOnOld.status === 200 && storedOnOld.at(-1)?.graph === graphOld,
      storedOnOld.map((row) => `${row.course_revision}:${row.graph}`).join(' '),
    );

    // ---- The old profile copy cannot serve the new graph: the profile is part of its identity.
    const wrongProfile = await deployments
      .switchTo(envFor(greenGraph, blueConfig, GREEN.application))
      .then(
        () => 'SWITCHED',
        (error: unknown) => switchRefusalCode(error),
      );
    const stillOld = await computeOver(serving, alice, KRC01, 'rollout-still-old');
    check(
      'new-graph-refused-with-the-old-profile',
      wrongProfile === 'PROFILE_CONFIG_MISMATCH' &&
        deployments.activeGraphBuildId === graphOld &&
        stillOld.graph === graphOld,
      `switch to the new graph with the old profile copy: ${wrongProfile}; active ${deployments.activeGraphBuildId}`,
    );

    // ---- The switch and the rollback, while requests keep arriving.
    const throughMove = async (
      label: string,
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
          const answer = await computeOver(serving, alice, KRC01, `${label}-${index}`).catch(
            () => null,
          );
          if (answer === null) break;
          seen.push({ index, startedAfterMove, ...answer });
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
    const label = (graph: string | null) =>
      graph === graphOld ? 'old' : graph === graphNew ? 'new' : String(graph);
    const oneStep = (moved: Awaited<ReturnType<typeof throughMove>>, from: string, to: string) =>
      moved.result.from === from &&
      moved.result.to === to &&
      moved.seen.every((entry) => entry.status === 200 && entry.outcome === 'route_computed') &&
      moved.seen.some((entry) => !entry.startedAfterMove && entry.graph === from) &&
      moved.seen.filter((entry) => entry.startedAfterMove).length >= 3 &&
      moved.seen.filter((entry) => entry.startedAfterMove).every((entry) => entry.graph === to);
    const describe = (moved: Awaited<ReturnType<typeof throughMove>>) =>
      `${moved.seen.map((entry) => `${entry.index}${entry.startedAfterMove ? '*' : ''}:${entry.status}:${entry.outcome}:${label(entry.graph)}`).join(' ')} (${moved.moveMilliseconds} ms, * = started after it returned)`;

    const switched = await throughMove('rollout-switch', () =>
      deployments.switchTo(envFor(greenGraph, greenConfig, GREEN.application)),
    );
    observations['switchUnderLoad'] = switched;
    check(
      'switch-to-the-new-profile-is-one-step-under-load',
      oneStep(switched, graphOld, graphNew),
      describe(switched),
    );

    // ---- Stored courses are not recomputed; saving across graphs needs the acknowledgement.
    const afterSwitch = await revisions();
    const onNew = await propose();
    const staleAcknowledgement = await save(onNew, graphOld, graphOld);
    const acknowledged = await save(onNew, graphOld, graphNew);
    const storedAfter = await revisions();
    check(
      'course-graph-acknowledgement-rechecked',
      JSON.stringify(afterSwitch) === JSON.stringify(storedOnOld) &&
        onNew.result.outcome === 'route_computed' &&
        onNew.result.proposal.computation.graph.graphBuildId === graphNew &&
        staleAcknowledgement.status === 409 &&
        staleAcknowledgement.body.includes('COURSE_GRAPH_ACKNOWLEDGEMENT_STALE') &&
        acknowledged.status === 200 &&
        storedAfter.length === storedOnOld.length + 1 &&
        storedAfter.at(-1)?.graph === graphNew &&
        JSON.stringify(storedAfter.slice(0, -1)) === JSON.stringify(storedOnOld),
      `stored after the switch ${afterSwitch.map((row) => `${row.course_revision}:${label(row.graph)}:${row.content_digest.slice(0, 8)}`).join(' ')}; proposal on ${onNew.result.outcome === 'route_computed' ? label(onNew.result.proposal.computation.graph.graphBuildId) : onNew.result.outcome}; save acknowledging old->old ${staleAcknowledgement.status}; old->new ${acknowledged.status}; stored now ${storedAfter.map((row) => `${row.course_revision}:${label(row.graph)}`).join(' ')}`,
    );

    // The shared PostgreSQL limiter (M2-01ah) keeps alice's rate window across the run; start
    // the rollback from an empty window so the rate bound cannot pass for a failed move.
    observations['admissionBeforeRollback'] = await clearAdmissionHistory(database.admin);
    const rolledBack = await throughMove('rollout-rollback', () => deployments.rollback());
    observations['rollbackUnderLoad'] = rolledBack;
    check(
      'rollback-to-the-old-profile-is-one-step-under-load',
      oneStep(rolledBack, graphNew, graphOld),
      describe(rolledBack),
    );

    // ---- Neither engine wrote a waypoint this run sent.
    await sleep(1500);
    const probes = coordinateProbes(sent, 'waypoint');
    const hits = (engine: EngineHandle) =>
      auditLogLines(engine.log().split('\n').filter(Boolean), {
        traceField: 'reqId',
        version: 'engine',
        probes,
        minRecords: 0,
      }).filter((finding) => finding.rule.startsWith('probe-')).length;
    const blueHits = hits(engines.blue);
    const greenHits = hits(engines.green);
    const requestLines = (engine: EngineHandle) =>
      (engine.log().match(/"(?:GET|POST) [^"]* HTTP\/[\d.]+"/g) ?? []).length;
    check(
      'no-engine-logged-a-waypoint',
      blueHits === 0 && greenHits === 0,
      `waypoint hits: blue ${blueHits}, green ${greenHits}; request lines: blue ${requestLines(engines.blue)}, green ${requestLines(engines.green)}`,
    );
  } finally {
    if (api !== null) await api.close().catch(() => undefined);
    if (engines.blue !== null) await stopEngine(engines.blue);
    if (engines.green !== null) await stopEngine(engines.green);
    await oidc.close().catch(() => undefined);
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  const report = {
    schemaVersion: 1,
    node: 'M2-01af',
    measuredAt: new Date().toISOString(),
    what: 'Blue/green rollout from the served graph on the pre-M2-01af serving profile to a full re-import on the new one, through the production API composition, fixture OIDC and an isolated PostgreSQL. Not a coverage review.',
    machine: {
      label: 'this machine (desktop), single caller',
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
    },
    deployment: await relocatedDeploymentNote(),
    graphs: {
      old: {
        root: '.geo-build/routing-graph',
        graphBuildId: blue.graphBuildId,
        profileConfigSha256: blue.manifest.profileConfigSha256,
        graphImportedAt: blue.manifest.graphImportedAt,
        graphContentSha256: blue.manifest.graphContentSha256,
      },
      new: {
        root: 'relocated (ROUTING_GRAPH_ROOT)',
        graphBuildId: green.graphBuildId,
        profileConfigSha256: green.manifest.profileConfigSha256,
        graphImportedAt: green.manifest.graphImportedAt,
        graphContentSha256: green.manifest.graphContentSha256,
        note: 'Full re-import of the same allowlisted extract with the M2-01af serving profile; not newer map data.',
      },
    },
    observations,
    checks,
    result: failed.length === 0 ? 'all_checks_passed' : 'checks_failed',
  };
  const reportPath = join(
    repositoryRoot,
    'docs/implementation/research/routing-profile-rollout.json',
  );
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, reportPath);
  console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.id) }));
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
