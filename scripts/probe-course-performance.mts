/**
 * M2-01k: time and memory of the course pipeline on a representative long track, measured
 * through the PRODUCTION API composition (`createConfiguredApi`) on this machine.
 *
 *   node --import tsx scripts/probe-course-performance.mts --execute
 *
 * Opt-in, refuses CI, binds the fixture identity provider on 4400 (hold the harness lock),
 * starts the self-hosted routing engine on loopback 8991. Nothing external is called.
 *
 * The track is SYNTHETIC: 20,000 samples, about 76 km, the size M2-01d fixed as the
 * representative long track for its map harness. No personal FIT or GPS is read. Every
 * number here is a single-caller measurement on this desktop machine through Fastify
 * `inject` (no network, no browser). It is not a device result, not a load test and not a
 * product budget; browser rendering of the same track is measured separately.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  courseReadResultSchema,
  courseRouteCandidateResultSchema,
  courseRouteProposalResultSchema,
  type CourseWaypoint,
} from '../packages/contracts/src/courses.ts';
import { renderCourseThumbnail } from '../packages/server/courses/src/thumbnail.ts';
import { createConfiguredApi } from '../apps/api/src/configured.ts';
import {
  routingGraphConfig,
  routingGraphDirectory,
  startEngine,
  stopEngine,
  waitForEngine,
} from './build-routing-graph.mjs';
import {
  LONG_TRACK_SAMPLES as SAMPLES,
  longTrackAt as at,
  longTrackFitBytes,
  longTrackLengthMeters,
  longTrackPosition as position,
  type LongTrackPosition as Position,
} from './fixtures/long-track.ts';
import { fixtureOidc, startFixtureOidc } from './fixtures/oidc-provider.ts';
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
const reportPath = join(repositoryRoot, 'docs/implementation/research/course-performance.json');

// The representative long track lives in ./fixtures/long-track.ts, shared with the M2-01k-f
// budget probe and browser spec so every measurement uses the same bytes.

function memory() {
  const usage = process.memoryUsage();
  return {
    rssMiB: Math.round(usage.rss / 2 ** 20),
    heapUsedMiB: Math.round(usage.heapUsed / 2 ** 20),
    externalMiB: Math.round(usage.external / 2 ** 20),
  };
}

const steps: {
  step: string;
  milliseconds: number;
  status: number | null;
  detail: string;
  memoryAfter: ReturnType<typeof memory>;
}[] = [];
async function measure<T>(
  step: string,
  work: () => Promise<{ value: T; status: number | null; detail: string }>,
) {
  const started = performance.now();
  const { value, status, detail } = await work();
  const milliseconds = Math.round(performance.now() - started);
  steps.push({ step, milliseconds, status, detail, memoryAfter: memory() });
  console.log(`${step}: ${milliseconds} ms status ${status} ${detail}`);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== '--execute') {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-course-performance.mts --execute. Binds the fixture ' +
        'OIDC provider on 4400 (hold the harness lock) and the routing engine on loopback 8991.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Performance probes are disabled in CI');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');

  const directory = await mkdtemp(join(tmpdir(), 'workout-course-performance-'));
  const storageRoot = join(directory, 'objects');
  await mkdir(storageRoot, { recursive: true });
  const database = await startDatabase(directory, detectedBin);
  const oidc = await startFixtureOidc();
  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    extractPath,
    graphPath: routingGraphDirectory,
  });
  let api: Api | null = null;
  const baseline = memory();
  try {
    await waitForEngine(engine, 8991);
    api = await createConfiguredApi({
      NODE_ENV: 'development',
      DATABASE_URL: database.runtimeUrl,
      PUBLIC_ORIGIN,
      OIDC_ISSUER: fixtureOidc.issuer,
      OIDC_CLIENT_ID: fixtureOidc.clientId,
      OIDC_CLIENT_SECRET: fixtureOidc.clientSecret,
      ALLOW_INSECURE_LOCALHOST: 'true',
      PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot,
      ROUTING_ENGINE_URL: 'http://127.0.0.1:8991/',
      ROUTING_GRAPH_DIRECTORY: routingGraphDirectory,
      ROUTING_ENGINE_ARTIFACT: jarPath,
      ROUTING_PROFILE_CONFIG: routingGraphConfig,
    });
    const app = api;
    await app.ready();
    const session = new Session();
    await session.login(app, 'alice');

    const length = longTrackLengthMeters();
    const fitBytes = longTrackFitBytes();

    const imported = await measure('activity-import', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/bff/v1/activity-imports',
        headers: session.headers(true),
        payload: {
          source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
          activity: {
            title: 'M2-01k synthetic long track',
            kind: 'running',
            startedAt: at(0),
            timezone: 'UTC',
            durationSeconds: SAMPLES,
            durationKind: 'elapsed',
            distanceMeters: Math.round(length),
          },
        },
      });
      const body = response.json() as { activityId: string; revision: number };
      return { value: body, status: response.statusCode, detail: '' };
    });
    const reservation = await measure('track-reserve', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/activities/${imported.activityId}/track-uploads`,
        headers: session.headers(true),
        payload: { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
      });
      return {
        value: response.json() as { uploadId: string },
        status: response.statusCode,
        detail: '',
      };
    });
    await measure('track-upload-and-server-parse', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
        headers: {
          ...session.headers(true),
          'content-type': 'application/octet-stream',
          'x-track-file-name': encodeURIComponent('long.fit'),
        },
        payload: fitBytes,
      });
      return {
        value: null,
        status: response.statusCode,
        detail: `fit ${fitBytes.byteLength} bytes, ${SAMPLES} records, ${(length / 1000).toFixed(1)} km`,
      };
    });
    await measure('track-finalize', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
        // No body, so no JSON content type: Fastify refuses an empty JSON body.
        headers: Object.fromEntries(
          Object.entries(session.headers(true)).filter(([name]) => name !== 'content-type'),
        ),
      });
      return {
        value: null,
        status: response.statusCode,
        detail: response.statusCode === 200 ? '' : response.body.slice(0, 160),
      };
    });
    const mapPath = await measure('read-map-path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/bff/v1/activities/${imported.activityId}/track/content?variant=map_path`,
        headers: session.headers(false),
      });
      return {
        value: response.body,
        status: response.statusCode,
        detail: `${response.rawPayload.byteLength} bytes`,
      };
    });
    const normalized = await measure('read-normalized', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/bff/v1/activities/${imported.activityId}/track/content?variant=normalized`,
        headers: session.headers(false),
      });
      return {
        value: response.body,
        status: response.statusCode,
        detail: `${response.rawPayload.byteLength} bytes`,
      };
    });
    const sampleIds = [...normalized.matchAll(/"sampleId":"(\d+:\d+)"/g)].map((match) => match[1]);
    const mapVertices = (mapPath.match(/\[\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*\]/g) ?? []).length;
    const track = await measure('read-track-head', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/bff/v1/activities/${imported.activityId}/track`,
        headers: session.headers(false),
      });
      const body = response.json() as { track: { trackRevision: number } };
      return {
        value: body.track,
        status: response.statusCode,
        detail: `samples ${sampleIds.length}, map path vertices ~${mapVertices}`,
      };
    });

    const course = await measure('course-from-full-segment', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/bff/v1/courses',
        headers: session.headers(true),
        payload: {
          name: 'M2-01k long course',
          from: {
            kind: 'recorded-segment',
            activityId: imported.activityId,
            trackRevision: track.trackRevision,
            startSampleId: sampleIds[0],
            endSampleId: sampleIds.at(-1),
          },
        },
      });
      const body = courseReadResultSchema.safeParse(response.json());
      return {
        value: body.success && body.data.status === 'available' ? body.data : null,
        status: response.statusCode,
        detail: body.success
          ? body.data.status === 'available'
            ? `${body.data.revision.geometry.coordinates.length} vertices, ${Math.round(body.data.revision.distanceMeters)} m planned line`
            : body.data.status
          : response.body.slice(0, 160),
      };
    });
    if (course === null) throw new Error('COURSE_NOT_CREATED');
    const courseId = course.course.courseId;

    await measure('thumbnail-render-in-process', async () => {
      const drawn = renderCourseThumbnail(course.revision.geometry.coordinates);
      return {
        value: null,
        status: null,
        detail: `${drawn.byteSize} bytes ${drawn.mediaType} from ${drawn.vertexCount} vertices`,
      };
    });
    await measure('gpx-export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/bff/v1/courses/${courseId}/export.gpx`,
        headers: session.headers(false),
      });
      return {
        value: null,
        status: response.statusCode,
        detail: `${response.rawPayload.byteLength} bytes`,
      };
    });
    const zones = await measure('privacy-zone-create', async () => {
      const [lon, lat] = position(0);
      const response = await app.inject({
        method: 'POST',
        url: '/bff/v1/courses/privacy-zones',
        headers: session.headers(true),
        payload: { name: '출발지 보호', center: [lon, lat], radiusMeters: 300 },
      });
      return {
        value: response.json() as { zoneSetDigest: string },
        status: response.statusCode,
        detail: '',
      };
    });
    await measure('privacy-trim', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/bff/v1/courses/${courseId}`,
        headers: session.headers(true),
        payload: {
          expectedRevision: course.course.headRevision,
          change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: zones.zoneSetDigest },
        },
      });
      const body = courseReadResultSchema.safeParse(response.json());
      return {
        value: null,
        status: response.statusCode,
        detail:
          body.success && body.data.status === 'available'
            ? `${body.data.revision.geometry.coordinates.length} vertices after trim`
            : response.body.slice(0, 160),
      };
    });

    const waypoints = (points: Position[]): CourseWaypoint[] =>
      points.map((point, index) => ({
        role: index === 0 ? 'start' : index === points.length - 1 ? 'finish' : 'via',
        position: point,
        name: null,
        sourceSampleId: null,
        locked: false,
      }));
    // 12 waypoints (the contract maximum) spread along the track: ~6.8 km straight legs.
    const rowEnds: Position[] = Array.from({ length: 12 }, (_, index) =>
      position(Math.min(SAMPLES - 1, Math.floor((index * SAMPLES) / 12))),
    );
    let draftRevision = 0;
    for (const [label, points] of [
      ['reroute-4-waypoints', rowEnds.slice(0, 4)],
      ['reroute-12-waypoints', rowEnds],
    ] as const) {
      await measure(label, async () => {
        draftRevision += 1;
        const response = await app.inject({
          method: 'POST',
          url: `/bff/v1/courses/${courseId}/route-proposals`,
          headers: session.headers(true),
          payload: {
            requestId: `perf-${randomUUID()}`,
            draftRevision,
            waypoints: waypoints(points),
          },
        });
        const result = courseRouteProposalResultSchema.safeParse(response.json());
        return {
          value: null,
          status: response.statusCode,
          detail: result.success
            ? result.data.outcome === 'route_computed'
              ? `route_computed ${Math.round(result.data.proposal.engineDistanceMeters)} m, ${result.data.proposal.geometry.coordinates.length} vertices, engine ${result.data.proposal.computation.computationMilliseconds} ms`
              : `${result.data.outcome} after ${result.data.computation.computationMilliseconds} ms`
            : response.body.slice(0, 160),
        };
      });
    }
    // Each search gets its own copy of the long course. The per-course bound on unsaved
    // proposals (5) would otherwise refuse the search after the two reroutes above — a
    // finding recorded by the operational probe, not something to measure here.
    for (const target of [2_000, 10_000]) {
      const copyId = await measure(`course-copy-for-${target}m`, async () => {
        const head = courseReadResultSchema.parse(
          (
            await app.inject({
              method: 'GET',
              url: `/bff/v1/courses/${courseId}`,
              headers: session.headers(false),
            })
          ).json(),
        );
        if (head.status !== 'available') throw new Error('COURSE_UNAVAILABLE');
        const response = await app.inject({
          method: 'POST',
          url: '/bff/v1/courses',
          headers: session.headers(true),
          payload: {
            name: `M2-01k copy ${target}`,
            from: {
              kind: 'course-copy',
              courseId,
              expectedRevision: head.course.headRevision,
            },
          },
        });
        const copy = courseReadResultSchema.safeParse(response.json());
        return {
          value: copy.success ? copy.data.course.courseId : '',
          status: response.statusCode,
          detail:
            copy.success && copy.data.status === 'available'
              ? `${copy.data.revision.geometry.coordinates.length} vertices copied`
              : response.body.slice(0, 160),
        };
      });
      await measure(`candidates-${target}m`, async () => {
        draftRevision += 1;
        const response = await app.inject({
          method: 'POST',
          url: `/bff/v1/courses/${copyId}/route-candidates`,
          headers: session.headers(true),
          payload: {
            requestId: `perf-c-${randomUUID().slice(0, 12)}`,
            draftRevision,
            targetDistanceMeters: target,
            seed: '0123456789abcdef',
            waypoints: waypoints([
              [126.9779, 37.5663],
              [126.9769, 37.5759],
            ]),
          },
        });
        const result = courseRouteCandidateResultSchema.safeParse(response.json());
        return {
          value: null,
          status: response.statusCode,
          detail: result.success
            ? result.data.outcome === 'candidates_generated'
              ? `${result.data.set.candidates.length} candidates, ${result.data.set.search.attemptsMade} attempts, search ${result.data.set.search.elapsedMilliseconds} ms, stopped ${result.data.set.search.stoppedBecause}`
              : `${result.data.outcome}, ${result.data.search.attemptsMade} attempts, stopped ${result.data.search.stoppedBecause}`
            : response.body.slice(0, 160),
        };
      });
    }
    await measure('course-list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/bff/v1/courses',
        headers: session.headers(false),
      });
      return {
        value: null,
        status: response.statusCode,
        detail: `${response.rawPayload.byteLength} bytes`,
      };
    });
  } finally {
    if (api !== null) await api.close().catch(() => undefined);
    await stopEngine(engine);
    await oidc.close().catch(() => undefined);
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: 1,
    node: 'M2-01k',
    measuredAt: new Date().toISOString(),
    label:
      'Desktop, this machine, single caller, Fastify inject through createConfiguredApi. Not a device, browser or load result.',
    track: {
      kind: 'synthetic',
      samples: SAMPLES,
      approximateLengthMeters: 'see track-upload-and-server-parse detail',
      region: 'central Seoul zig-zag, inside the routing graph extract',
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
    },
    baselineMemory: baseline,
    /**
     * Units are MiB throughout. `peakRssMiB` is this Node process's own maximum resident set
     * (process.resourceUsage), which includes the synthetic FIT generator running in the same
     * process — an upper bound for the API, not the API alone. The JVM engine is a separate
     * process and is NOT included; its RSS is not measured here under load.
     */
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    steps,
    failures: steps
      .filter((entry) => entry.status !== null && entry.status >= 400)
      .map((entry) => entry.step),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${reportPath}.tmp`, reportPath);
  console.log(JSON.stringify({ failures: report.failures }));
}

await main();
