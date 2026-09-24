import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { createCourseRepository } from '@workout/server-persistence/courses';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import {
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
  grantOperations,
  migrate,
} from '@workout/server-persistence/migrate';
import {
  auditLogLines,
  coordinateProbes,
  createLogCapture,
  formatLogFindings,
  valueProbes,
} from '@workout/server-courses/log-audit';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';

import { createApi } from '../src/app.js';
import { auditRouteLogs, testRelease } from './log-audit-support.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Isolated real PostgreSQL required: run pnpm test:integration');

const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let objectRoot: string;
let storage: ObjectStorage;
let athleteId: string;

const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};

/** A recording with a gap: the second run starts after a four minute break. */
const gpxBytes = Buffer.from(
  `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>` +
    `<trkpt lat="37.5" lon="127.02"><time>2026-03-01T00:00:00Z</time></trkpt>` +
    `<trkpt lat="37.5001" lon="127.0201"><time>2026-03-01T00:00:10Z</time></trkpt>` +
    `<trkpt lat="37.5002" lon="127.0202"><time>2026-03-01T00:00:20Z</time></trkpt>` +
    `<trkpt lat="37.5003" lon="127.0203"><time>2026-03-01T00:00:30Z</time></trkpt>` +
    `</trkseg><trkseg>` +
    `<trkpt lat="37.51" lon="127.03"><time>2026-03-01T00:20:00Z</time></trkpt>` +
    `<trkpt lat="37.5101" lon="127.0301"><time>2026-03-01T00:20:10Z</time></trkpt>` +
    `</trkseg></trk></gpx>`,
  'utf8',
);

const courseNames = ['Cheonggyecheon stretch', 'Across the gap', 'Renamed stretch', 'Too late'];
const recordedPositions = [
  [127.02, 37.5],
  [127.0201, 37.5001],
  [127.0202, 37.5002],
  [127.0203, 37.5003],
  [127.03, 37.51],
  [127.0301, 37.5101],
];
/** Everything this file plants that no log line may carry (M2-01k-c2). */
const probes = () => [
  ...coordinateProbes(recordedPositions),
  ...valueProbes('object_key', [objectRoot]),
  ...valueProbes('token', [csrfToken, 'session=fixture']),
  ...valueProbes('body', courseNames),
];
// The API's real log stream over the real database, parse host and storage, audited after
// each test.
const logs = auditRouteLogs(probes);

/**
 * The course thumbnail worker exactly as it is deployed: its own CLI, its own process, its
 * own database role (M2-01l). Its stdout and stderr are its log stream.
 */
const thumbnailWorkerRole = 'workout_course_thumbnail_worker';
const thumbnailWorkerEntry = fileURLToPath(
  new URL('../../worker/src/course-thumbnail.ts', import.meta.url),
);

async function runThumbnailWorker(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const workerUrl = new URL(runtimeUrl as string);
  workerUrl.username = thumbnailWorkerRole;
  const child = spawn(process.execPath, ['--import', 'tsx', thumbnailWorkerEntry], {
    env: {
      PATH: process.env['PATH'],
      COURSE_THUMBNAIL_DATABASE_URL: workerUrl.href,
      RESOURCE_STORAGE_ROOT: objectRoot,
      WORKOUT_RELEASE: testRelease,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantActivityTracks(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO workout_runtime`,
  );
  await admin.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${thumbnailWorkerRole}') THEN
         CREATE ROLE ${thumbnailWorkerRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
       END IF;
     END $$`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${thumbnailWorkerRole}`);
  await grantCourseThumbnailWorker(adminUrl, thumbnailWorkerRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  objectRoot = await mkdtemp(join(tmpdir(), 'course-lifecycle-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
  athleteId = randomUUID();
});

afterAll(async () => {
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Course run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

function setup() {
  return createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId,
        sessionId: 'current',
        csrfToken,
        method: 'cookie' as const,
      }),
    },
    consent: {
      getConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
      setConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
    },
    activityTracks: {
      tracks: createActivityTrackRepository(database),
      storage,
      parser: createBoundedTrackParser({
        execArgv: ['--import', 'tsx'],
        maxOldGenerationSizeMb: 256,
      }),
    },
    courses: {
      courses: createCourseRepository(database),
      tracks: createActivityTrackRepository(database),
      storage,
    },
    ...logs.options(),
  });
}

/** Store a recording through the product's own three-step upload. */
async function storeRecording(
  app: ReturnType<typeof createApi>,
  activityId: string,
  revision: number,
) {
  const reservation = await app.inject({
    method: 'POST',
    url: `/bff/v1/activities/${activityId}/track-uploads`,
    headers: { ...headers, 'idempotency-key': `track-${randomUUID()}` },
    payload: { expectedActivityRevision: revision, recordedTrackIndex: 0 },
  });
  expect(reservation.statusCode).toBe(200);
  const uploadId = reservation.json().uploadId as string;
  const content = await app.inject({
    method: 'PUT',
    url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-track-file-name': 'run.gpx',
    },
    payload: gpxBytes,
  });
  expect(content.statusCode).toBe(200);
  const finalized = await app.inject({
    method: 'POST',
    url: `/bff/v1/activity-track-uploads/${uploadId}/finalize`,
    headers,
  });
  expect(finalized.statusCode).toBe(200);
  return finalized.json().track as { trackRevision: number; trackId: string };
}

describe('turning a stored recording into a course, end to end', () => {
  it(
    'cuts a selected range, exports it as GPX and leaves the recording untouched',
    { timeout: 240_000 },
    async () => {
      const activities = createActivityRepository(database);
      const imported = await activities.importActivity(athleteId, importInput());
      const app = setup();
      try {
        const track = await storeRecording(app, imported.activityId, imported.revision);
        const created = await app.inject({
          method: 'POST',
          url: '/bff/v1/courses',
          headers: { ...headers, 'idempotency-key': `course-${randomUUID()}` },
          payload: {
            name: 'Cheonggyecheon stretch',
            from: {
              kind: 'recorded-segment',
              activityId: imported.activityId,
              trackRevision: track.trackRevision,
              startSampleId: '0:1',
              endSampleId: '0:3',
            },
          },
        });
        expect(created.statusCode).toBe(200);
        const course = created.json();
        expect(course.status).toBe('available');
        expect(course.course.headRevision).toBe(1);
        expect(course.course.visibility).toBe('private');
        expect(course.revision.geometry.coordinates).toHaveLength(3);
        expect(course.revision.generation.mapPathContentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(course.revision.lineage).toEqual([
          {
            activityId: imported.activityId,
            trackId: track.trackId,
            trackRevision: track.trackRevision,
          },
        ]);

        // The save enqueued a thumbnail render. The real worker CLI draws it, one job per
        // process; renders other test files left queued are older and are leased first, so
        // it runs until this course's picture is ready. What each process prints is its log.
        const thumbnailOf = async () =>
          (
            await app.inject({
              method: 'GET',
              url: `/bff/v1/courses/${course.course.courseId}`,
              headers,
            })
          ).json().thumbnail as { status: string };
        const backlog = await admin.query<{ queued: number }>(
          `SELECT count(*)::int AS queued FROM course_thumbnail WHERE state IN ('queued','rendering')`,
        );
        const bound = (backlog.rows[0]?.queued ?? 0) + 1;
        const worker = createLogCapture();
        const results: string[] = [];
        while (results.length < bound && (await thumbnailOf()).status !== 'ready') {
          const outcome = await runThumbnailWorker();
          expect({ code: outcome.code, stderr: outcome.stderr }).toEqual({ code: 0, stderr: '' });
          worker.append(outcome.stdout);
          results.push((JSON.parse(outcome.stdout) as { result: string }).result);
        }
        expect(await thumbnailOf()).toMatchObject({ status: 'ready', courseRevision: 1 });
        const workerFindings = auditLogLines(worker.lines(), {
          traceField: 'runId',
          version: testRelease,
          probes: probes(),
          minRecords: 1,
        });
        expect(workerFindings, formatLogFindings(workerFindings)).toEqual([]);
        // One line per process: nothing else reached stdout.
        expect(worker.lines()).toHaveLength(results.length);

        // The recording is untouched: same activity revision, same stored track revision,
        // and its own geometry still has both runs.
        const activity = await activities.getActivity(athleteId, imported.activityId);
        expect(activity?.revision).toBe(imported.revision);
        const storedTrack = await app.inject({
          method: 'GET',
          url: `/bff/v1/activities/${imported.activityId}/track`,
          headers,
        });
        expect(storedTrack.json().track.trackRevision).toBe(track.trackRevision);
        expect(storedTrack.json().track.segmentCount).toBe(2);

        // A selection that would jump the gap is refused rather than joined.
        const acrossGap = await app.inject({
          method: 'POST',
          url: '/bff/v1/courses',
          headers: { ...headers, 'idempotency-key': `course-${randomUUID()}` },
          payload: {
            name: 'Across the gap',
            from: {
              kind: 'recorded-segment',
              activityId: imported.activityId,
              trackRevision: track.trackRevision,
              startSampleId: '0:1',
              endSampleId: '0:5',
            },
          },
        });
        expect(acrossGap.statusCode).toBe(422);
        expect(acrossGap.json().error.code).toBe('SEGMENT_SPANS_A_GAP');

        const exported = await app.inject({
          method: 'GET',
          url: `/bff/v1/courses/${course.course.courseId}/export.gpx`,
          headers,
        });
        expect(exported.statusCode).toBe(200);
        expect(exported.body).toContain('<rte>');
        expect(exported.body).not.toContain('<trk>');
        for (const [longitude, latitude] of course.revision.geometry.coordinates as [
          number,
          number,
        ][])
          expect(exported.body).toContain(
            `<rtept lat="${latitude.toFixed(7)}" lon="${longitude.toFixed(7)}" />`,
          );

        // An edit appends a revision; the first one is still readable byte for byte.
        const renamed = await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${course.course.courseId}`,
          headers: { ...headers, 'idempotency-key': `course-${randomUUID()}` },
          payload: { expectedRevision: 1, change: { kind: 'rename', name: 'Renamed stretch' } },
        });
        expect(renamed.statusCode).toBe(200);
        expect(renamed.json().course.headRevision).toBe(2);
        const stale = await app.inject({
          method: 'PATCH',
          url: `/bff/v1/courses/${course.course.courseId}`,
          headers: { ...headers, 'idempotency-key': `course-${randomUUID()}` },
          payload: { expectedRevision: 1, change: { kind: 'rename', name: 'Too late' } },
        });
        expect(stale.statusCode).toBe(409);

        // Deleting the activity reclaims the course, and the confirmation said so first.
        const impact = await app.inject({
          method: 'GET',
          url: `/bff/v1/activities/${imported.activityId}/deletion-impact`,
          headers,
        });
        expect(impact.json()).toMatchObject({
          total: 1,
          courses: [{ courseId: course.course.courseId, headRevision: 2 }],
        });
        await activities.deleteActivity(athleteId, imported.activityId, {
          expectedRevision: imported.revision,
        });
        const afterDeletion = await app.inject({
          method: 'GET',
          url: `/bff/v1/courses/${course.course.courseId}`,
          headers,
        });
        expect(afterDeletion.statusCode).toBe(200);
        expect(afterDeletion.json().status).toBe('unavailable');
        expect(afterDeletion.body).not.toContain('127.02');
        const afterExport = await app.inject({
          method: 'GET',
          url: `/bff/v1/courses/${course.course.courseId}/export.gpx`,
          headers,
        });
        expect(afterExport.statusCode).toBe(410);

        // Every request above wrote its completion line, and each one is audited after the
        // test; here, only that none was dropped.
        const completed = logs
          .lines()
          .filter(
            (line) => (JSON.parse(line) as { event?: unknown }).event === 'request_completed',
          );
        expect(completed.length).toBeGreaterThanOrEqual(13);
      } finally {
        await app.close();
      }
    },
  );
});
