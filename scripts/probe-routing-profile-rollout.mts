/**
 * M2-01af: roll the rebuilt graph out, from the served graph on the old serving profile to a
 * full re-import on the new one, through M2-01k-e's blue/green procedure.
 *
 *   ROUTING_GRAPH_ROOT=<absolute dir outside .geo-build> [ROUTING_EXTRACT_SOURCE=<allowlist id>] \
 *     node --import tsx scripts/probe-routing-profile-rollout.mts --execute [--report-name <file>.json]
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
 * 5. (M2-01ak) After the rollback it moves forward again and retires blue: the old engine is
 *    stopped and the API keeps answering from green, and a course saved on the old graph is
 *    still read back unchanged.
 *
 * Green may be a re-import of the same extract (M2-01af) or, from M2-01ak on, an import of a
 * different allowlisted extract (`ROUTING_EXTRACT_SOURCE`, the national one); the first check
 * then requires that green's extract hash is that allowlist entry's pin. The report goes to
 * `routing-profile-rollout.json` unless `--report-name` names another file.
 *
 * WHAT THIS IS NOT. Timings are single-caller values on this machine only. Nothing here
 * grades coverage.
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
  probeReportPath,
  relocatedDeploymentNote,
  routingExtract,
  routingExtractFrom,
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
import { allowedSource } from './geo/sources.mjs';
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
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const servingProfile = join(repositoryRoot, 'scripts/geo/graphhopper-foot-serving.yml');
/** Blue: the served deployment, always the default layout under `.geo-build`. */
const blueRoot = routingGraphRootFrom(undefined);
const blueGraph = join(blueRoot, 'foot');
const blueConfig = join(blueRoot, 'config-serving.yml');
/** Each engine gets its own deployment's extract (read only when a graph must be imported). */
const blueExtract = routingExtractFrom(undefined, blueRoot);
const greenExtract = routingExtract;

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
  const named = argv.indexOf('--report-name');
  if (
    !argv.includes('--execute') ||
    argv.length !== (named === -1 ? 1 : 3) ||
    !process.env.ROUTING_GRAPH_ROOT
  ) {
    console.log(
      'Opt-in only: ROUTING_GRAPH_ROOT=<green deployment, outside .geo-build> node --import tsx ' +
        'scripts/probe-routing-profile-rollout.mts --execute [--report-name <file>.json]. Runs two real engines on loopback ' +
        '8991-8994, the production API composition and the fixture OIDC provider on 4400 (hold the ' +
        'harness lock), and writes a report. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');
  const reportPath = probeReportPath(argv, 'routing-profile-rollout.json');
  // `routingGraphDirectory`/`routingGraphConfig` follow ROUTING_GRAPH_ROOT: that is green.
  const greenGraph = routingGraphDirectory;
  const greenConfig = routingGraphConfig;
  for (const required of [
    blueExtract.path,
    greenExtract.path,
    jarPath,
    blueGraph,
    blueConfig,
    greenGraph,
    greenConfig,
  ])
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
  // Same extract (M2-01af), or a different allowlisted one whose pin is green's extract hash
  // (M2-01ak): a graph from an extract nobody pinned is not a rollout candidate.
  const greenPin = allowedSource(greenExtract.sourceId).sha256 ?? null;
  const sameExtract = green.manifest.extractSha256 === blue.manifest.extractSha256;
  const pinnedNewExtract =
    !sameExtract &&
    greenExtract.sourceId !== blueExtract.sourceId &&
    greenPin === green.manifest.extractSha256 &&
    green.manifest.extractRegion === greenExtract.region;
  check(
    'green-is-a-full-reimport-on-the-new-profile',
    graphOld !== graphNew &&
      green.manifest.profileConfigSha256 === repositoryProfileSha256 &&
      blue.manifest.profileConfigSha256 !== green.manifest.profileConfigSha256 &&
      (sameExtract || pinnedNewExtract) &&
      green.manifest.graphImportedAt !== blue.manifest.graphImportedAt &&
      profileDisablesRequestLog(greenProfileText) &&
      !profileDisablesRequestLog(blueProfileText),
    `old ${graphOld} profile ${blue.manifest.profileConfigSha256.slice(0, 12)} / new ${graphNew} profile ${green.manifest.profileConfigSha256.slice(0, 12)} (repository ${repositoryProfileSha256.slice(0, 12)}); ${sameExtract ? `same extract ${green.manifest.extractSha256.slice(0, 12)}` : `extract ${blue.manifest.extractSha256.slice(0, 12)} (${blue.manifest.extractRegion}) -> ${green.manifest.extractSha256.slice(0, 12)} (${green.manifest.extractRegion}, allowlist ${greenExtract.sourceId} pin ${greenPin === green.manifest.extractSha256 ? 'matches' : 'DOES NOT MATCH'})`}; imported ${blue.manifest.graphImportedAt} / ${green.manifest.graphImportedAt}`,
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
      extractPath: blueExtract.path,
      graphPath: blueGraph,
      ports: BLUE,
    });
    engines.green = startEngine({
      jarPath,
      configPath: greenConfig,
      extractPath: greenExtract.path,
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
    const importCourse = async (filename: string) => {
      const imported = courseImportResultSchema.parse(
        (
          await serving.inject({
            method: 'POST',
            url: '/bff/v1/courses/imports',
            headers: alice.headers(true),
            payload: {
              name: null,
              originalFilename: filename,
              selection: null,
              fileBase64: Buffer.from(gpx).toString('base64'),
            },
          })
        ).json(),
      );
      if (imported.outcome !== 'imported' || imported.course.status !== 'available')
        throw new Error('IMPORT_FAILED');
      return imported.course.course.courseId;
    };
    const courseId = await importCourse('m2-01af.gpx');
    // M2-01ak: a second course saved on the old graph and never rerouted. It stands for the
    // courses users hold when the graph is replaced; it must read back unchanged afterwards.
    const untouchedCourseId = await importCourse('m2-01ak-untouched.gpx');
    const waypoints = (points: Position[]): CourseWaypoint[] =>
      points.map((position, index) => ({
        role: index === 0 ? 'start' : index === points.length - 1 ? 'finish' : 'via',
        position,
        name: null,
        sourceSampleId: null,
        locked: false,
      }));
    const draftRevisions = new Map<string, number>();
    const propose = async (course = courseId) => {
      const draftRevision = (draftRevisions.get(course) ?? 0) + 1;
      draftRevisions.set(course, draftRevision);
      const response = await serving.inject({
        method: 'POST',
        url: `/bff/v1/courses/${course}/route-proposals`,
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
      course = courseId,
    ) => {
      if (proposal.result.outcome !== 'route_computed') throw new Error('NO_PROPOSAL');
      const head = courseReadResultSchema.parse(
        (
          await serving.inject({
            method: 'GET',
            url: `/bff/v1/courses/${course}`,
            headers: alice.headers(false),
          })
        ).json(),
      );
      if (head.status !== 'available') throw new Error('COURSE_UNAVAILABLE');
      const response = await serving.inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${course}`,
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
    const revisions = async (course = courseId) =>
      (
        await database.admin.query<{
          course_revision: number;
          content_digest: string;
          graph: string | null;
        }>(
          `SELECT course_revision, content_digest,
                  COALESCE(generation #>> '{computation,graph,graphBuildId}', generation->>'sourceGraphBuildId') AS graph
             FROM course_revision WHERE course_id=$1 ORDER BY course_revision`,
          [course],
        )
      ).rows;
    const onOld = await propose();
    const savedOnOld = await save(onOld, null, graphOld);
    const storedOnOld = await revisions();
    const untouchedOnOld = await save(
      await propose(untouchedCourseId),
      null,
      graphOld,
      untouchedCourseId,
    );
    const untouchedStored = await revisions(untouchedCourseId);
    check(
      'course-saved-on-the-old-graph',
      savedOnOld.status === 200 &&
        storedOnOld.at(-1)?.graph === graphOld &&
        untouchedOnOld.status === 200 &&
        untouchedStored.at(-1)?.graph === graphOld,
      `${storedOnOld.map((row) => `${row.course_revision}:${row.graph}`).join(' ')}; untouched course ${untouchedStored.map((row) => `${row.course_revision}:${row.graph}`).join(' ')}`,
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

    // ---- M2-01ak: forward again and retire blue (runbook steps 4-5). With the old engine
    // stopped the API keeps answering from green, and a course saved on the old graph and never
    // rerouted reads back exactly as stored: existing revisions are accepted as they are.
    observations['admissionBeforeRetire'] = await clearAdmissionHistory(database.admin);
    const forward = await deployments.switchTo(envFor(greenGraph, greenConfig, GREEN.application));
    const retired = engines.blue;
    await stopEngine(retired);
    const blueStopped = retired.process.exitCode !== null || retired.process.signalCode !== null;
    const afterRetire = await computeOver(serving, alice, KRC01, 'rollout-after-retire');
    check(
      'blue-retired-green-keeps-serving',
      forward.from === graphOld &&
        forward.to === graphNew &&
        blueStopped &&
        deployments.activeGraphBuildId === graphNew &&
        afterRetire.status === 200 &&
        afterRetire.outcome === 'route_computed' &&
        afterRetire.graph === graphNew,
      `switch ${label(forward.from)} -> ${label(forward.to)}; blue stopped ${blueStopped}; active ${label(deployments.activeGraphBuildId)}; route after retire ${afterRetire.status}:${afterRetire.outcome}:${label(afterRetire.graph)}`,
    );
    const untouchedRead = await serving.inject({
      method: 'GET',
      url: `/bff/v1/courses/${untouchedCourseId}`,
      headers: alice.headers(false),
    });
    const untouchedHead = courseReadResultSchema.parse(untouchedRead.json());
    const untouchedAfter = await revisions(untouchedCourseId);
    check(
      'course-on-the-old-graph-accepted-unchanged',
      untouchedRead.statusCode === 200 &&
        untouchedHead.status === 'available' &&
        untouchedHead.course.headRevision === untouchedStored.at(-1)?.course_revision &&
        JSON.stringify(untouchedAfter) === JSON.stringify(untouchedStored) &&
        untouchedAfter.at(-1)?.graph === graphOld,
      `untouched course read ${untouchedRead.statusCode} ${untouchedHead.status}; head revision ${untouchedHead.status === 'available' ? untouchedHead.course.headRevision : '-'}; stored ${untouchedAfter.map((row) => `${row.course_revision}:${label(row.graph)}:${row.content_digest.slice(0, 8)}`).join(' ')} (before the switch ${untouchedStored.map((row) => `${row.course_revision}:${label(row.graph)}:${row.content_digest.slice(0, 8)}`).join(' ')})`,
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
    what: 'Blue/green rollout from the served graph on the pre-M2-01af serving profile to a full import on the new one (the same extract, or from M2-01ak a different allowlisted one), through the production API composition, fixture OIDC and an isolated PostgreSQL: switch, rollback, switch forward and retire blue. Not a coverage review.',
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
        extractRegion: green.manifest.extractRegion,
        extractSha256: green.manifest.extractSha256,
        extractSource: greenExtract.sourceId,
        note: sameExtract
          ? 'Full re-import of the same allowlisted extract with the M2-01af serving profile; not newer map data.'
          : 'Full import of a different allowlisted, pinned extract with the M2-01af serving profile.',
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
