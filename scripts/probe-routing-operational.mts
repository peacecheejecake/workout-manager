/**
 * M2-01k: operate the self-hosted pedestrian engine through the PRODUCTION composition.
 *
 *   node --import tsx scripts/probe-routing-operational.mts --execute
 *
 * Opt-in only, refuses to run in CI, and binds the fixture identity provider on 4400, so
 * run it while holding the shared harness lock. It never calls an external service.
 *
 * What this proves, and nothing more:
 *
 * 1. `createConfiguredApi` — the function `start.ts` runs — registers the route-proposal,
 *    candidate and routing routes only when the routing deployment is configured, and a
 *    half-set or unverifiable configuration refuses to start.
 * 2. Through that composition, an OIDC-authenticated user on a real PostgreSQL gets routes
 *    computed by the real GraphHopper engine over the real Seoul graph, stored as
 *    proposals and saved only by an explicit reviewed save.
 * 3. Replacing the graph (a second, independently imported build) and rolling back:
 *    - an API still pinned to the old graph refuses the new engine (`graph_mismatch`);
 *    - no stored revision is recomputed or rewritten by either move;
 *    - saving across graphs requires the two-sided acknowledgement, and the rollback
 *      returns exactly the earlier graph identity.
 * 4. Engine down, bounded admission and a startup refusal, each observed rather than
 *    assumed.
 *
 * WHAT THIS IS NOT. A computed route is not pedestrian coverage and nothing here reviews
 * one; Korean coverage review remains M0-06b's external gate. Graph B is a re-import of
 * the same extract (a distinct build the system must treat as a different graph), not a
 * newer map. Timings are single-caller values on this machine only.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import {
  courseImportResultSchema,
  courseReadResultSchema,
  courseRouteCandidateResultSchema,
  courseRouteProposalResultSchema,
  type CourseWaypoint,
} from '../packages/contracts/src/courses.ts';
import { walkingRouteResultSchema } from '../packages/contracts/src/routing.ts';
import {
  loadRoutingDeployment,
  createRoutingEngineEndpoint,
} from '../packages/server/integrations/src/routing/index.ts';
import {
  grantActivityTracks,
  grantCourses,
  grantIdentityFunctions,
  grantOperations,
  migrate,
} from '../packages/server/persistence/src/migrate.ts';
import { createConfiguredApi } from '../apps/api/src/configured.ts';
import {
  importRoutingGraph,
  routingGraphConfig,
  routingGraphDirectory,
  sha256File,
  startEngine,
  stopEngine,
  waitForEngine,
  type EngineHandle,
} from './build-routing-graph.mjs';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
import { verifyAllowedSourceFile } from './geo/sources.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
/** Graph B: a second import of the same extract, kept beside graph A and never over it. */
const graphBDirectory = join(workRoot, 'routing-graph', 'swap-b', 'foot');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/routing-operational-acceptance.json',
);
const ENGINE_PORT = 8991;
export const PUBLIC_ORIGIN = 'http://127.0.0.1:3100';

type Position = [number, number];

/** Pre-stated, from the M2-01g coverage probe's KRC-01 case; not adjusted after a run. */
const KRC01: { waypoints: [Position, Position]; distance: [number, number] } = {
  waypoints: [
    [126.9769, 37.5759],
    [126.9779, 37.5663],
  ],
  distance: [1000, 2000],
};
const VIA: Position = [126.9786, 37.5712];

const checks: { id: string; passed: boolean; detail: string }[] = [];
/**
 * Product behaviour observed against a requirement it does not meet. Recorded, not
 * asserted: the probe checks operations, and a finding is reported as a finding.
 */
const findings: { id: string; requirement: string; expected: string; observed: string }[] = [];
function check(id: string, passed: boolean, detail: string) {
  checks.push({ id, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

// ---------------------------------------------------------------- isolated PostgreSQL
export const detectedBin = [
  process.env['PG_BIN'],
  '/opt/homebrew/opt/postgresql@14/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
].find((value) => value !== undefined && existsSync(join(value, 'initdb')));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error(`COMMAND_FAILED: ${command}`);
}

/**
 * M2-01ah: every API instance now takes its permits from one PostgreSQL table, so a tenant's
 * rate window outlives the API instance that spent it — which is the point of the shared
 * limiter. The probes build fresh API instances section by section and used to start each
 * from a fresh in-process window; this starts a section from an empty WINDOW instead.
 *
 * It deletes only history: rows that hold nothing (released, or past their lease). A permit
 * still held is left in place and still counts, so a permit that outlived its instance would
 * still show up as a refusal. It reports what it found, for the probe's record.
 */
export async function clearAdmissionHistory(admin: Pool) {
  const held = await admin.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM routing_admission
     WHERE released_at IS NULL AND lease_until>clock_timestamp()`,
  );
  const cleared = await admin.query(
    `DELETE FROM routing_admission
     WHERE released_at IS NOT NULL OR lease_until<=clock_timestamp()`,
  );
  return { historyCleared: cleared.rowCount ?? 0, permitsHeld: held.rows[0]?.total ?? -1 };
}

/**
 * M2-01ah review F1: wait until no permit is held anywhere, so a check that follows starts
 * from an idle limiter. Permits are released a few ms after the engine stops, asynchronously,
 * so a section that follows another can otherwise start while the previous section's last
 * permits are still held — and a tenant's own `concurrency` refusal would then pass for the
 * refusal under test. Throws after `timeoutMilliseconds` rather than proceeding.
 */
export async function waitForNoHeldPermits(admin: Pool, timeoutMilliseconds = 15_000) {
  const startedAt = performance.now();
  for (;;) {
    const held = await admin.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM routing_admission
       WHERE released_at IS NULL AND lease_until>clock_timestamp()`,
    );
    const total = held.rows[0]?.total ?? -1;
    const waitedMilliseconds = Math.round(performance.now() - startedAt);
    if (total === 0) return { waitedMilliseconds };
    if (waitedMilliseconds > timeoutMilliseconds)
      throw new Error(`PERMITS_STILL_HELD: ${total} after ${waitedMilliseconds} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function startDatabase(directory: string, bin: string) {
  const data = join(directory, 'data');
  run(join(bin, 'initdb'), [
    '-D',
    data,
    '-U',
    'workout_admin',
    '-A',
    'trust',
    '--no-locale',
    '--encoding=UTF8',
  ]);
  // Unix socket only: no TCP port is bound.
  run(join(bin, 'pg_ctl'), [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-k ${directory} -h ''`,
    '-w',
    'start',
  ]);
  const endpoint = `localhost/postgres?host=${encodeURIComponent(directory)}`;
  const adminUrl = `postgresql://workout_admin@${endpoint}`;
  const runtimeUrl = `postgresql://workout_runtime@${endpoint}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(
    'CREATE ROLE workout_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
  );
  await migrate(adminUrl);
  await grantIdentityFunctions(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt, activity_canonical, activity_source_head, activity_source_revision, activity_overlay, activity_overlay_revision, activity_suppression, activity_import_receipt TO workout_runtime',
  );
  return {
    admin,
    runtimeUrl,
    stop: async () => {
      await admin.end();
      run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    },
  };
}

// ---------------------------------------------------------------- HTTP session via inject
export type Api = Awaited<ReturnType<typeof createConfiguredApi>>;

export class Session {
  readonly cookies = new Map<string, string>();
  sessionId = '';
  csrfToken = '';

  absorb(header: string | string[] | number | undefined) {
    const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
    for (const value of values) {
      const pair = value.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const content = pair.slice(index + 1).trim();
      if (content === '' || /max-age=0/i.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, content);
    }
  }

  cookie() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  headers(write: boolean): Record<string, string> {
    return {
      cookie: this.cookie(),
      ...(this.sessionId === '' ? {} : { 'x-workout-session-id': this.sessionId }),
      ...(write
        ? {
            origin: PUBLIC_ORIGIN,
            'x-workout-session-id': this.sessionId,
            'x-csrf-token': this.csrfToken,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          }
        : {}),
    };
  }

  async login(api: Api, subject: 'alice' | 'bob') {
    const begin = await api.inject({ method: 'GET', url: '/bff/v1/auth/login' });
    this.absorb(begin.headers['set-cookie']);
    const authorize = String(begin.headers.location);
    const page = (await (await fetch(authorize)).text()).replaceAll('&amp;', '&');
    const choose = new RegExp(`href="(/choose\\?id=[^"]+subject=${subject})"`).exec(page)?.[1];
    if (!choose) throw new Error('OIDC_FIXTURE_CHOICE_MISSING');
    const chosen = await fetch(new URL(choose, fixtureOidc.issuer), { redirect: 'manual' });
    const callback = new URL(chosen.headers.get('location') ?? '');
    const done = await api.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: this.cookie() },
    });
    this.absorb(done.headers['set-cookie']);
    const session = await api.inject({
      method: 'GET',
      url: '/bff/v1/session',
      headers: this.headers(false),
    });
    const body = session.json() as { sessionId: string; csrfToken: string; athleteId: string };
    if (session.statusCode !== 200) throw new Error(`SESSION_${session.statusCode}`);
    this.sessionId = body.sessionId;
    this.csrfToken = body.csrfToken;
    return body.athleteId;
  }
}

// ---------------------------------------------------------------- engine and API lifecycle
interface Deployment {
  readonly label: 'A' | 'B';
  readonly graphDirectory: string;
}
const routingEnv = (deployment: Deployment) => ({
  ROUTING_ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}/`,
  ROUTING_GRAPH_DIRECTORY: deployment.graphDirectory,
  ROUTING_ENGINE_ARTIFACT: jarPath,
  ROUTING_PROFILE_CONFIG: routingGraphConfig,
});

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--execute') || argv.some((a) => a !== '--execute' && a !== '--rebuild-b')) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-routing-operational.mts --execute [--rebuild-b]. ' +
        'Runs the production API composition against the self-hosted engine on loopback, binds the ' +
        'fixture OIDC provider on 4400 (hold the harness lock), and writes a report. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');
  for (const required of [extractPath, jarPath, routingGraphConfig]) await stat(required);

  const A: Deployment = { label: 'A', graphDirectory: routingGraphDirectory };
  const B: Deployment = { label: 'B', graphDirectory: graphBDirectory };
  const endpoint = createRoutingEngineEndpoint(`http://127.0.0.1:${ENGINE_PORT}/`);
  const verify = (deployment: Deployment) =>
    loadRoutingDeployment({
      graphDirectory: deployment.graphDirectory,
      engineArtifactPath: jarPath,
      profileConfigPath: routingGraphConfig,
      endpoint,
    });

  // Graph B, built through the same manifest writer as graph A.
  let graphBBuilt = false;
  let graphBImportMilliseconds: number | null = null;
  const existingB = await verify(B).catch(() => null);
  if (existingB === null || argv.includes('--rebuild-b')) {
    const jar = await verifyAllowedSourceFile('graphhopper-web-jar', jarPath);
    const started = performance.now();
    await importRoutingGraph({
      graphDirectory: graphBDirectory,
      engineArtifactSha256: jar.sha256,
      extractSha256: await sha256File(extractPath),
      profileConfigSha256: await sha256File(routingGraphConfig),
      extractByteLength: (await stat(extractPath)).size,
    });
    graphBImportMilliseconds = Math.round(performance.now() - started);
    graphBBuilt = true;
  }
  const deploymentA = await verify(A);
  const deploymentB = await verify(B);
  const graphA = deploymentA.graphBuildId;
  const graphB = deploymentB.graphBuildId;
  check('graph-identities-distinct', graphA !== graphB, `A ${graphA} / B ${graphB}`);
  check(
    'graph-b-same-inputs-different-import',
    deploymentA.manifest.extractSha256 === deploymentB.manifest.extractSha256 &&
      deploymentA.manifest.graphImportedAt !== deploymentB.manifest.graphImportedAt,
    `import A ${deploymentA.manifest.graphImportedAt} / B ${deploymentB.manifest.graphImportedAt}`,
  );

  const directory = await mkdtemp(join(tmpdir(), 'workout-routing-operational-'));
  const storageRoot = join(directory, 'objects');
  await mkdir(storageRoot, { recursive: true });
  const database = await startDatabase(directory, detectedBin);
  const oidc = await startFixtureOidc();
  let engine: EngineHandle | null = null;
  let api: Api | null = null;
  const timings: Record<string, number[]> = {};
  const time = async <T,>(name: string, work: () => Promise<T>) => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      (timings[name] ??= []).push(Math.round(performance.now() - started));
    }
  };
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
  const startApi = async (deployment: Deployment | null) => {
    if (api !== null) await api.close();
    api = null;
    api = await createConfiguredApi({ ...baseEnv, ...(deployment ? routingEnv(deployment) : {}) });
    await api.ready();
    return api;
  };
  const switchEngine = async (deployment: Deployment | null) => {
    if (engine !== null) await stopEngine(engine);
    engine = null;
    if (deployment === null) return;
    engine = startEngine({
      jarPath,
      configPath: routingGraphConfig,
      extractPath,
      graphPath: deployment.graphDirectory,
    });
    await time(`engine-start-${deployment.label}`, () =>
      waitForEngine(engine as EngineHandle, ENGINE_PORT),
    );
    const pid = engine.process.pid;
    if (pid !== undefined) {
      const rss = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
      const kib = Number(rss.stdout.trim());
      if (Number.isFinite(kib) && kib > 0)
        (timings[`engine-rss-mib-after-start-${deployment.label}`] ??= []).push(
          Math.round(kib / 1024),
        );
    }
  };
  const revisions = async (courseId: string) =>
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

  try {
    // ---- 1. Composition: routes exist only when routing is configured.
    const session = new Session();
    let current = await startApi(null);
    await session.login(current, 'alice');
    const probeBody = {
      schemaVersion: 1,
      requestId: 'op-unconfigured',
      requestRevision: 1,
      profileId: 'foot-v1',
      waypoints: KRC01.waypoints,
    };
    const unconfigured = await current.inject({
      method: 'POST',
      url: '/bff/v1/routing/walking-routes',
      headers: session.headers(true),
      payload: probeBody,
    });
    check(
      'unconfigured-routes-absent',
      unconfigured.statusCode === 404,
      `status ${unconfigured.statusCode}`,
    );

    const halfSet = await createConfiguredApi({
      ...baseEnv,
      ROUTING_ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}/`,
    }).then(
      async (unexpected) => {
        await unexpected.close();
        return 'started';
      },
      (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
    );
    check(
      'half-configured-refuses-start',
      halfSet.startsWith('ROUTING_CONFIGURATION_INCOMPLETE'),
      halfSet,
    );
    const wrongProfile = await createConfiguredApi({
      ...baseEnv,
      ...routingEnv(A),
      ROUTING_PROFILE_CONFIG: join(repositoryRoot, 'scripts/geo/graphhopper-foot.yml'),
    }).then(
      async (unexpected) => {
        await unexpected.close();
        return 'started';
      },
      (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
    );
    check(
      'unverifiable-deployment-refuses-start',
      wrongProfile === 'PROFILE_CONFIG_MISMATCH',
      wrongProfile.slice(0, 80),
    );

    // ---- 2. Real engine A through the production composition.
    await switchEngine(A);
    current = await startApi(A);
    const direct = await time('direct-route', () =>
      (current as Api).inject({
        method: 'POST',
        url: '/bff/v1/routing/walking-routes',
        headers: session.headers(true),
        payload: { ...probeBody, requestId: 'op-direct' },
      }),
    );
    const directResult = walkingRouteResultSchema.parse(direct.json());
    const directDistance =
      directResult.outcome === 'route_computed' ? directResult.distanceMeters : null;
    check(
      'configured-direct-route-real-engine',
      direct.statusCode === 200 &&
        directResult.outcome === 'route_computed' &&
        directResult.computation.graph.identitySource === 'engine' &&
        directResult.computation.graph.graphBuildId === graphA &&
        directDistance !== null &&
        directDistance >= KRC01.distance[0] &&
        directDistance <= KRC01.distance[1],
      `status ${direct.statusCode} ${directResult.outcome} graph ${directResult.computation.graph.graphBuildId} ` +
        `distance ${directDistance?.toFixed(1)} m vertices ${directResult.outcome === 'route_computed' ? directResult.geometry.coordinates.length : 0}`,
    );

    // A course to route: imported GPX along the same street, no graph on it yet.
    const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="m2-01k" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>M2-01k operational</name>${[
      KRC01.waypoints[0],
      VIA,
      KRC01.waypoints[1],
    ]
      .map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`)
      .join('')}</rte></gpx>`;
    const imported = await current.inject({
      method: 'POST',
      url: '/bff/v1/courses/imports',
      headers: session.headers(true),
      payload: {
        name: null,
        originalFilename: 'm2-01k-operational.gpx',
        selection: null,
        fileBase64: Buffer.from(gpx).toString('base64'),
      },
    });
    if (imported.statusCode !== 200)
      throw new Error(`IMPORT_${imported.statusCode} ${imported.body}`);
    const importResult = courseImportResultSchema.parse(imported.json());
    if (importResult.outcome !== 'imported' || importResult.course.status !== 'available')
      throw new Error(`IMPORT_FAILED ${imported.statusCode}`);
    const courseId = importResult.course.course.courseId;
    check(
      'import-has-no-graph',
      importResult.course.revision.generation.kind === 'imported-file',
      importResult.course.revision.generation.kind,
    );

    const waypoints = (points: Position[]): CourseWaypoint[] =>
      points.map((position, index) => ({
        role: index === 0 ? 'start' : index === points.length - 1 ? 'finish' : 'via',
        position,
        name: null,
        sourceSampleId: null,
        locked: false,
      }));
    let draftRevision = 0;
    const propose = async (points: Position[]) => {
      draftRevision += 1;
      const response = await time('course-proposal', () =>
        (current as Api).inject({
          method: 'POST',
          url: `/bff/v1/courses/${courseId}/route-proposals`,
          headers: session.headers(true),
          payload: { requestId: `op-${randomUUID()}`, draftRevision, waypoints: waypoints(points) },
        }),
      );
      return {
        status: response.statusCode,
        result: courseRouteProposalResultSchema.parse(response.json()),
        draftRevision,
      };
    };
    const read = async () => {
      const response = await (current as Api).inject({
        method: 'GET',
        url: `/bff/v1/courses/${courseId}`,
        headers: session.headers(false),
      });
      const result = courseReadResultSchema.parse(response.json());
      if (result.status !== 'available') throw new Error('COURSE_UNAVAILABLE');
      return result;
    };
    const save = async (change: Record<string, unknown>) => {
      const head = await read();
      const response = await (current as Api).inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${courseId}`,
        headers: session.headers(true),
        payload: { expectedRevision: head.course.headRevision, change },
      });
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    };

    const underA = await propose([KRC01.waypoints[0], VIA, KRC01.waypoints[1]]);
    check(
      'proposal-real-engine-A',
      underA.status === 200 &&
        underA.result.outcome === 'route_computed' &&
        underA.result.proposal.computation.graph.graphBuildId === graphA,
      `status ${underA.status} ${underA.result.outcome}`,
    );
    const beforeSave = await revisions(courseId);
    check('proposal-changes-nothing', beforeSave.length === 1, `revisions ${beforeSave.length}`);
    if (underA.result.outcome !== 'route_computed') throw new Error('NO_PROPOSAL_UNDER_A');
    const savedA = await save({
      kind: 'reroute',
      proposalId: underA.result.proposal.proposalId,
      draftRevision: underA.draftRevision,
      acknowledgedGraph: { previous: null, next: graphA },
    });
    check('reviewed-save-under-A', savedA.status === 200, `status ${savedA.status}`);

    // Candidates on the real engine, timed: M2-01i measured only a fixture.
    draftRevision += 1;
    const candidateResponse = await time('candidate-search', () =>
      (current as Api).inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/route-candidates`,
        headers: session.headers(true),
        payload: {
          requestId: `op-c-${randomUUID().slice(0, 12)}`,
          draftRevision,
          targetDistanceMeters: 2000,
          seed: '0123456789abcdef',
          waypoints: waypoints([KRC01.waypoints[0], KRC01.waypoints[1]]),
        },
      }),
    );
    const candidates = courseRouteCandidateResultSchema.parse(candidateResponse.json());
    const candidateSummary =
      candidates.outcome === 'candidates_generated'
        ? {
            outcome: candidates.outcome,
            candidates: candidates.set.candidates.length,
            graphs: [
              ...new Set(candidates.set.candidates.map((c) => c.computation.graph.graphBuildId)),
            ],
            attemptsMade: candidates.set.search.attemptsMade,
            elapsedMilliseconds: candidates.set.search.elapsedMilliseconds,
            stoppedBecause: candidates.set.search.stoppedBecause,
            engineDistances: candidates.set.candidates.map((c) =>
              Math.round(c.evaluation.engineDistanceMeters),
            ),
            errorRatios: candidates.set.candidates.map((c) =>
              Number(c.evaluation.distanceErrorRatio.toFixed(3)),
            ),
          }
        : {
            outcome: candidates.outcome,
            attemptsMade: candidates.search.attemptsMade,
            stoppedBecause: candidates.search.stoppedBecause,
          };
    check(
      'candidates-real-engine-A',
      candidates.outcome === 'candidates_generated' &&
        candidates.set.candidates.every((c) => c.computation.graph.graphBuildId === graphA),
      JSON.stringify(candidateSummary),
    );
    if (candidates.outcome === 'candidates_generated') {
      const picked = candidates.set.candidates[0];
      const pick = await save({
        kind: 'pick-candidate',
        candidateSetId: candidates.set.candidateSetId,
        proposalId: picked?.proposalId,
        draftRevision,
        acknowledgedGraph: { previous: graphA, next: graphA },
      });
      check('candidate-pick-saved-under-A', pick.status === 200, `status ${pick.status}`);
    }
    const stableUnderA = await revisions(courseId);
    check(
      'head-computed-on-A',
      stableUnderA.at(-1)?.graph === graphA,
      `revisions ${stableUnderA.map((r) => `${r.course_revision}:${r.graph}`).join(' ')}`,
    );

    // ---- 3. Replace the engine's graph while the API is still pinned to A.
    await switchEngine(B);
    const pinnedToA = await propose([KRC01.waypoints[0], KRC01.waypoints[1]]);
    check(
      'pinned-api-refuses-replaced-engine',
      pinnedToA.status === 502 && pinnedToA.result.outcome === 'graph_mismatch',
      `status ${pinnedToA.status} ${pinnedToA.result.outcome}`,
    );
    const afterMismatch = await revisions(courseId);
    check(
      'mismatch-writes-nothing',
      JSON.stringify(afterMismatch) === JSON.stringify(stableUnderA),
      `revisions ${afterMismatch.length}`,
    );

    // Complete the replacement: redeploy the API on B. Stored revisions stay as written.
    current = await startApi(B);
    const afterSwap = await revisions(courseId);
    check(
      'swap-recomputes-nothing',
      JSON.stringify(afterSwap) === JSON.stringify(stableUnderA),
      `revisions ${afterSwap.map((r) => `${r.course_revision}:${r.graph}:${r.content_digest.slice(0, 8)}`).join(' ')}`,
    );
    const headAfterSwap = await read();
    const underB = await propose([KRC01.waypoints[0], VIA, KRC01.waypoints[1]]);
    check(
      'proposal-real-engine-B',
      underB.result.outcome === 'route_computed' &&
        underB.result.proposal.computation.graph.graphBuildId === graphB,
      `status ${underB.status} ${underB.result.outcome}`,
    );
    if (underB.result.outcome !== 'route_computed') throw new Error('NO_PROPOSAL_UNDER_B');
    const silentlyAcrossGraphs = await save({
      kind: 'reroute',
      proposalId: underB.result.proposal.proposalId,
      draftRevision: underB.draftRevision,
      acknowledgedGraph: { previous: graphA, next: graphA },
    });
    check(
      'cross-graph-save-needs-acknowledgement',
      silentlyAcrossGraphs.status === 409 &&
        JSON.stringify(silentlyAcrossGraphs.body).includes('COURSE_GRAPH_ACKNOWLEDGEMENT_STALE'),
      `status ${silentlyAcrossGraphs.status} ${JSON.stringify(silentlyAcrossGraphs.body).slice(0, 80)}`,
    );
    const acknowledgedB = await save({
      kind: 'reroute',
      proposalId: underB.result.proposal.proposalId,
      draftRevision: underB.draftRevision,
      acknowledgedGraph: { previous: graphA, next: graphB },
    });
    const afterB = await revisions(courseId);
    check(
      'acknowledged-save-on-B-appends',
      acknowledgedB.status === 200 &&
        afterB.length === stableUnderA.length + 1 &&
        afterB.at(-1)?.graph === graphB &&
        JSON.stringify(afterB.slice(0, -1)) === JSON.stringify(stableUnderA),
      `status ${acknowledgedB.status} head ${afterB.at(-1)?.course_revision}:${afterB.at(-1)?.graph} (was ${headAfterSwap.course.headRevision})`,
    );

    // ---- 4. Roll back: engine to A first (API on B refuses it), then the API.
    await switchEngine(A);
    const pinnedToB = await propose([KRC01.waypoints[0], KRC01.waypoints[1]]);
    check(
      'rollback-engine-refused-by-api-on-B',
      pinnedToB.status === 502 && pinnedToB.result.outcome === 'graph_mismatch',
      `status ${pinnedToB.status} ${pinnedToB.result.outcome}`,
    );
    current = await startApi(A);
    const afterRollback = await revisions(courseId);
    check(
      'rollback-recomputes-nothing',
      JSON.stringify(afterRollback) === JSON.stringify(afterB),
      `head ${afterRollback.at(-1)?.course_revision}:${afterRollback.at(-1)?.graph}`,
    );
    const rolledBack = await propose([KRC01.waypoints[0], VIA, KRC01.waypoints[1]]);
    check(
      'rollback-returns-exact-graph-A',
      rolledBack.result.outcome === 'route_computed' &&
        rolledBack.result.proposal.computation.graph.graphBuildId === graphA,
      `${rolledBack.result.outcome} ${rolledBack.result.outcome === 'route_computed' ? rolledBack.result.proposal.computation.graph.graphBuildId : ''}`,
    );
    if (rolledBack.result.outcome === 'route_computed') {
      const backToA = await save({
        kind: 'reroute',
        proposalId: rolledBack.result.proposal.proposalId,
        draftRevision: rolledBack.draftRevision,
        acknowledgedGraph: { previous: graphB, next: graphA },
      });
      const final = await revisions(courseId);
      check(
        'rollback-save-keeps-history',
        backToA.status === 200 &&
          final.at(-1)?.graph === graphA &&
          JSON.stringify(final.slice(0, -1)) === JSON.stringify(afterB),
        final.map((r) => `${r.course_revision}:${r.graph}`).join(' '),
      );
    }

    // ---- Finding: iterative editing against the per-course proposal bound.
    const openProposals = async (id: string) =>
      (
        await database.admin.query<{ open: number }>(
          `SELECT count(*)::int AS open FROM course_route_proposal
            WHERE course_id=$1 AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [id],
        )
      ).rows[0]?.open ?? -1;
    const siblingsHeld = await openProposals(courseId);
    const second = await (current as Api).inject({
      method: 'POST',
      url: '/bff/v1/courses/imports',
      headers: session.headers(true),
      payload: {
        name: 'M2-01k iterative editing',
        originalFilename: 'm2-01k-iterative.gpx',
        selection: null,
        fileBase64: Buffer.from(gpx).toString('base64'),
      },
    });
    const secondCourse = courseImportResultSchema.parse(second.json());
    if (secondCourse.outcome !== 'imported' || secondCourse.course.status !== 'available')
      throw new Error('SECOND_IMPORT_FAILED');
    const iterativeId = secondCourse.course.course.courseId;
    const iterative: string[] = [];
    // Twice the per-course bound and then some (M2-01p): before the fix the sixth was refused.
    const edits = 12;
    for (let edit = 1; edit <= edits; edit += 1) {
      const started = performance.now();
      const response = await (current as Api).inject({
        method: 'POST',
        url: `/bff/v1/courses/${iterativeId}/route-proposals`,
        headers: session.headers(true),
        payload: {
          requestId: `op-iterate-${edit}`,
          draftRevision: edit,
          // Each edit nudges the via point, as dragging it along a street would.
          waypoints: waypoints([
            KRC01.waypoints[0],
            [VIA[0] + edit * 0.0002, VIA[1]],
            KRC01.waypoints[1],
          ]),
        },
      });
      const body = response.json() as { outcome?: string; error?: { code?: string } };
      iterative.push(
        `${edit}:${response.statusCode}:${body.outcome ?? body.error?.code ?? '?'}:${Math.round(performance.now() - started)}ms`,
      );
    }
    console.log(
      `iterative editing: ${iterative.join(' ')}; siblings held after a pick: ${siblingsHeld}`,
    );
    if (!iterative.every((entry) => entry.split(':')[1] === '200'))
      findings.push({
        id: 'iterative-recompute-refused-by-proposal-quota',
        requirement:
          'S14 edit loop (move a waypoint, recompute, review) and V2-A35 rapid successive waypoint edits',
        expected:
          'Each recompute of the latest draft succeeds; only the latest draft can be saved from the editor.',
        observed: `${edits} unsaved recomputes of one course within the 30 min TTL: ${iterative.join(' ')}. The refusal comes after the engine computed the route. Unsaved siblings of a picked candidate also keep holding slots: ${siblingsHeld} on the routed course.`,
      });

    // ---- 5. The tenant admission bound, with the engine up, then the engine down.
    // Alice spent her window through the API instances of the sections above; with the
    // shared limiter (M2-01ah) it outlives them. Start this section from an empty window.
    const admissionBeforeBounds = await clearAdmissionHistory(database.admin);
    console.log(
      `admission history before the bound section: ${JSON.stringify(admissionBeforeBounds)}`,
    );
    const bob = new Session();
    await bob.login(current, 'bob');
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let index = 0; index < 21; index += 1) {
      const response = await current.inject({
        method: 'POST',
        url: '/bff/v1/routing/walking-routes',
        headers: bob.headers(true),
        payload: { ...probeBody, requestId: `op-burst-${index}` },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) retryAfter = String(response.headers['retry-after']);
    }
    check(
      'tenant-rate-bound',
      statuses.slice(0, 20).every((status) => status === 200) &&
        statuses[20] === 429 &&
        retryAfter !== undefined,
      `statuses ${statuses.join(',')} retry-after ${retryAfter}`,
    );
    const aliceUnaffected = await (current as Api).inject({
      method: 'POST',
      url: '/bff/v1/routing/walking-routes',
      headers: session.headers(true),
      payload: { ...probeBody, requestId: 'op-other-tenant' },
    });
    check(
      'rate-bound-is-per-tenant',
      aliceUnaffected.statusCode === 200,
      `other tenant status ${aliceUnaffected.statusCode}`,
    );

    await switchEngine(null);
    const beforeDown = await revisions(courseId);
    const down = await propose([KRC01.waypoints[0], KRC01.waypoints[1]]);
    check(
      'engine-down-is-distinct-and-stores-nothing',
      down.status === 502 &&
        down.result.outcome === 'engine_unavailable' &&
        JSON.stringify(await revisions(courseId)) === JSON.stringify(beforeDown),
      `status ${down.status} ${down.result.outcome}`,
    );
  } finally {
    if (api !== null) await (api as Api).close().catch(() => undefined);
    if (engine !== null) await stopEngine(engine);
    await oidc.close().catch(() => undefined);
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  const report = {
    schemaVersion: 1,
    node: 'M2-01k',
    measuredAt: new Date().toISOString(),
    what: 'Production API composition (createConfiguredApi) against the self-hosted GraphHopper engine on loopback, fixture OIDC, isolated PostgreSQL. Not a coverage review.',
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
        graphBuildId: graphA,
        graphImportedAt: deploymentA.manifest.graphImportedAt,
        graphContentSha256: deploymentA.manifest.graphContentSha256,
      },
      B: {
        graphBuildId: graphB,
        graphImportedAt: deploymentB.manifest.graphImportedAt,
        graphContentSha256: deploymentB.manifest.graphContentSha256,
        builtThisRun: graphBBuilt,
        importMilliseconds: graphBImportMilliseconds,
        note: 'Re-import of the same allowlisted extract with the same engine and profile; a distinct build, not newer map data.',
      },
    },
    timingsMilliseconds: timings,
    checks,
    findings,
    result: failed.length === 0 ? 'all_checks_passed' : 'checks_failed',
  };
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, reportPath);
  console.log(
    JSON.stringify({
      result: report.result,
      failed: failed.map((entry) => entry.id),
      findings: findings.map((entry) => entry.id),
      timings,
    }),
  );
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
