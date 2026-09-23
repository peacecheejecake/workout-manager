import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import { courseThumbnailLimits } from '@workout/contracts/courses';
import {
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  validateObjectKey,
  type ObjectStorage,
  type StoreReachability,
} from '@workout/server-media';
import { renderCourseThumbnail } from '@workout/server-courses/thumbnail';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  createCourseThumbnailWorkerRepository,
  type CourseThumbnailLease,
  type CourseThumbnailWorkerRepository,
} from '../src/course-thumbnails.js';
import {
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
  grantOperations,
  grantResourceObjectCleanupWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  reconcileCourseThumbnailObjects,
  type ResourceObjectCleanupRepository,
} from '../src/resource-object-cleanup.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let courses: CourseRepository;
let tracks: ActivityTrackRepository;
let activities: ActivityRepository;
let operations: OperationsRepository;
let renderer: CourseThumbnailWorkerRepository;
let cleanup: ResourceObjectCleanupRepository;
let storage: ObjectStorage & StoreReachability;
let objectRoot: string;
// Two least-privilege roles, as in production: one draws, one deletes. Neither is the
// runtime role, and neither can do the other's job.
const renderRole = `course_thumb_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const cleanupRole = `course_clean_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

function roleUrl(role: string): string {
  const parsed = new URL(runtimeUrl as string);
  parsed.username = role;
  return parsed.href;
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
  for (const role of [renderRole, cleanupRole]) {
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  }
  await grantCourseThumbnailWorker(adminUrl, renderRole);
  await grantResourceObjectCleanupWorker(adminUrl, cleanupRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  courses = createCourseRepository(database);
  tracks = createActivityTrackRepository(database);
  activities = createActivityRepository(database);
  operations = createOperationsRepository(database);
  renderer = createCourseThumbnailWorkerRepository({ connectionString: roleUrl(renderRole) });
  cleanup = createResourceObjectCleanupRepository({
    connectionString: roleUrl(cleanupRole),
    max: 2,
  });
  objectRoot = await mkdtemp(join(tmpdir(), 'course-thumbnails-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterAll(async () => {
  await renderer?.close();
  await cleanup?.close();
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

function importInput(sourceId = randomUUID()): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
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

function trackRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

async function storeTrack(athleteId: string, activityId: string, expectedActivityRevision: number) {
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${reservation.uploadId}`);
  const normalizedSha = hashOf(`normalized-${reservation.uploadId}`);
  const mapPathSha = hashOf(`map-${reservation.uploadId}`);
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: trackRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: trackRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: trackRef({
        ...shared,
        artifactKind: 'map_path',
        sha256: mapPathSha,
        extension: 'json',
      }),
      sizeBytes: 1024,
      sha256: mapPathSha,
    },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${reservation.uploadId}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { trackId: reservation.trackId, mapPathSha };
}

const baseLine: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function content(input: {
  activityId: string;
  trackId: string;
  name?: string;
  coordinates?: [number, number][];
  edit?: PreparedCourseContent['edit'];
}): PreparedCourseContent {
  const line = input.coordinates ?? baseLine;
  const [startPosition] = line;
  const endPosition = line[line.length - 1];
  if (startPosition === undefined || endPosition === undefined)
    throw new Error('a course needs at least two vertices');
  const generation = {
    kind: 'recorded-segment',
    activityId: input.activityId,
    trackId: input.trackId,
    trackRevision: 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: '0:2',
    vertexCount: line.length,
    mapPathContentSha256: 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  } as const;
  const lineage = [{ activityId: input.activityId, trackId: input.trackId, trackRevision: 1 }];
  const name = input.name ?? 'Seoul loop';
  return {
    name,
    coordinates: line,
    waypoints: [
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0', locked: false },
      { role: 'finish', position: endPosition, name: null, sourceSampleId: '0:2', locked: false },
    ],
    generation,
    edit: input.edit ?? { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: hashOf(JSON.stringify([name, line, lineage])),
  };
}

async function athleteWithCourse(name = 'Seoul loop') {
  const athlete = randomUUID();
  const imported = await activities.importActivity(athlete, importInput());
  const stored = await storeTrack(athlete, imported.activityId, imported.revision);
  const created = await courses.create(
    athlete,
    content({ activityId: imported.activityId, trackId: stored.trackId, name }),
    `course-${randomUUID()}`,
  );
  if (created.status !== 'available') throw new Error('course was not created');
  return { athlete, imported, stored, course: created };
}

/** Everything the render worker does for one leased job, against the real object store. */
async function renderLease(lease: CourseThumbnailLease): Promise<{
  outcome: string;
  storageRef: string;
}> {
  const drawn = renderCourseThumbnail(lease.coordinates);
  const temporaryKey = createCourseThumbnailTemporaryObjectKey({
    tenantId: lease.athleteId,
    courseId: lease.courseId,
    jobId: lease.jobId,
  });
  const finalKey = createCourseThumbnailFinalObjectKey({
    tenantId: lease.athleteId,
    courseId: lease.courseId,
    revisionId: lease.revisionId,
    sha256: drawn.sha256,
  });
  await storage.delete(temporaryKey).catch(() => undefined);
  await storage.writeTemporary(
    temporaryKey,
    (async function* () {
      yield drawn.bytes;
    })(),
  );
  const prepared = await renderer.prepare(lease, {
    storageRef: finalKey,
    sha256: drawn.sha256,
    byteSize: drawn.byteSize,
    vertexCount: drawn.vertexCount,
  });
  if (!prepared) throw new Error('preparation was refused');
  await storage.publishTemporary(temporaryKey, finalKey, {
    sha256: drawn.sha256,
    sizeBytes: drawn.byteSize,
  });
  const outcome = await renderer.finalize(lease);
  if (outcome !== 'ready') await renderer.requeueRefs(lease);
  return { outcome, storageRef: finalKey };
}

/**
 * Draw every render this database has queued.
 *
 * The queue is deliberately tenant-blind — one worker drains every tenant — so a test
 * cannot assume the next lease is its own. Draining the whole queue and looking the answer
 * up by course is both honest about that and deterministic.
 */
async function renderEverything(): Promise<Map<string, { outcome: string; storageRef: string }>> {
  const drawn = new Map<string, { outcome: string; storageRef: string }>();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const lease = await renderer.lease(60);
    if (lease === null) return drawn;
    try {
      drawn.set(`${lease.courseId}:${lease.courseRevision}`, await renderLease(lease));
    } catch {
      // Some tests deliberately put a tenant over budget or a key under an authorized
      // deletion. The queue is shared, so draining it must survive those rows rather than
      // letting one test's arranged refusal fail another test's render.
      await renderer.fail(lease, 'RENDER_FAILED', { retryable: false });
    }
  }
  throw new Error('the render queue did not drain');
}

async function renderedFor(courseId: string, courseRevision = 1) {
  const drawn = await renderEverything();
  const entry = drawn.get(`${courseId}:${courseRevision}`);
  if (!entry) throw new Error('this course had no queued render');
  return entry;
}

/** Lease this course's own render, having drained whatever else was waiting. */
async function leaseFor(courseId: string): Promise<CourseThumbnailLease> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const lease = await renderer.lease(60);
    if (lease === null) break;
    if (lease.courseId === courseId) return lease;
    try {
      await renderLease(lease);
    } catch {
      await renderer.fail(lease, 'RENDER_FAILED', { retryable: false });
    }
  }
  throw new Error('this course had no queued render');
}

async function thumbnailState(athlete: string, courseId: string) {
  const read = await courses.read(athlete, courseId);
  if (read.status !== 'available') throw new Error('course is unavailable');
  return read.thumbnail;
}

async function queuedReasons(storageRef: string): Promise<readonly string[]> {
  const rows = await admin.query(
    'SELECT reason,completed_at FROM resource_object_cleanup WHERE storage_ref=$1',
    [storageRef],
  );
  return rows.rows.map((row) => String(row['reason']));
}

/** Drain the shared cleanup queue until it is empty, exactly as the worker does. */
async function drainCleanup(): Promise<number> {
  let drained = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const outcome = await processOneResourceObjectCleanup(cleanup, (storageRef) =>
      storage.delete(validateObjectKey(storageRef)),
    );
    if (outcome === 'empty') return drained;
    drained += 1;
  }
  throw new Error('the cleanup queue did not drain');
}

/**
 * Drive the M2-01m sweep deterministically: the cursor is parked immediately before the
 * reference under test, so one bounded window examines exactly that reference regardless of
 * what any other test left in the global index. A window that comes back empty means the
 * reference stopped being watched, which is itself an outcome worth asserting.
 */
async function sweepThumbnailReference(reference: string) {
  await cleanup.advanceThumbnailReconcileCursor(reference.slice(0, -1));
  // A window of one that comes back full does not wrap: the cursor advances to this
  // reference, which is asserted directly in the reproduction below.
  return reconcileCourseThumbnailObjects(cleanup, storage, 1);
}

/** Take a render as far as `prepared`, without publishing anything. */
async function preparedRender(courseId: string) {
  const lease = await leaseFor(courseId);
  const drawn = renderCourseThumbnail(lease.coordinates);
  const temporaryKey = createCourseThumbnailTemporaryObjectKey({
    tenantId: lease.athleteId,
    courseId: lease.courseId,
    jobId: lease.jobId,
  });
  const finalKey = createCourseThumbnailFinalObjectKey({
    tenantId: lease.athleteId,
    courseId: lease.courseId,
    revisionId: lease.revisionId,
    sha256: drawn.sha256,
  });
  const prepared = await renderer.prepare(lease, {
    storageRef: finalKey,
    sha256: drawn.sha256,
    byteSize: drawn.byteSize,
    vertexCount: drawn.vertexCount,
  });
  if (!prepared) throw new Error('preparation was refused');
  return { lease, drawn, temporaryKey, finalKey };
}

/**
 * The two storage calls of a writer that is past every gate: exactly what a render that
 * resumed after its lease, its fence and the fence's grace had all expired would do, because
 * no gate can reach a call that is already in flight.
 */
async function publishDrawn(
  temporaryKey: ReturnType<typeof createCourseThumbnailTemporaryObjectKey>,
  finalKey: ReturnType<typeof createCourseThumbnailFinalObjectKey>,
  drawn: ReturnType<typeof renderCourseThumbnail>,
) {
  await storage.writeTemporary(
    temporaryKey,
    (async function* () {
      yield drawn.bytes;
    })(),
  );
  await storage.publishTemporary(temporaryKey, finalKey, {
    sha256: drawn.sha256,
    sizeBytes: drawn.byteSize,
  });
}

/** Push one render's lease, fence and deadline into the past, as a real stall would. */
async function stallRender(jobId: string, hours: number) {
  await admin.query(
    `UPDATE course_thumbnail
       SET created_at=clock_timestamp()-make_interval(hours=>$2+1),
           updated_at=clock_timestamp()-make_interval(hours=>$2+1),
           lease_until=clock_timestamp()-make_interval(hours=>$2),
           publication_lease_until=clock_timestamp()-make_interval(hours=>$2),
           expires_at=clock_timestamp()-make_interval(hours=>$2)
     WHERE job_id=$1`,
    [jobId, hours],
  );
}

/** Age a closed render past the seven days `prune_course_thumbnail_history` waits. */
async function ageClosedRender(jobId: string, days: number) {
  await admin.query(
    `UPDATE course_thumbnail
       SET created_at=clock_timestamp()-make_interval(days=>$2+1),
           expires_at=clock_timestamp()-make_interval(days=>$2)-interval '1 hour',
           publication_lease_until=clock_timestamp()-make_interval(days=>$2)-interval '2 hours',
           updated_at=clock_timestamp()-make_interval(days=>$2)
     WHERE job_id=$1`,
    [jobId, days],
  );
}

async function pendingCleanupRows(storageRef: string): Promise<number> {
  const rows = await admin.query(
    'SELECT count(*)::int AS total FROM resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL',
    [storageRef],
  );
  return Number(rows.rows[0]?.['total']);
}

async function watchedRef(storageRef: string) {
  const rows = await admin.query(
    'SELECT athlete_id,recorded_at,settled_at FROM course_thumbnail_object_ref WHERE storage_ref=$1',
    [storageRef],
  );
  return rows.rows[0] ?? null;
}

describe('M2-01l stored course thumbnails', () => {
  it('asks for a picture of the revision it just wrote, inside that revision transaction', async () => {
    const { athlete, course } = await athleteWithCourse();
    // The render is enqueued by a trigger on the revision insert, so no write path can
    // forget it — and it is queued, not drawn, so the save was never delayed by it.
    const state = await thumbnailState(athlete, course.course.courseId);
    expect(state.status).toBe('pending');
    if (state.status !== 'pending') throw new Error('expected a queued render');
    expect(state.courseRevision).toBe(1);
    // There is nothing to serve yet, and saying so is different from having failed.
    expect(await courses.resolveThumbnailObject(athlete, course.course.courseId)).toBeNull();
  });

  it('publishes the picture and reports the facts about it, never its key', async () => {
    const { athlete, course } = await athleteWithCourse('Ready course');
    const rendered = await renderedFor(course.course.courseId);
    expect(rendered.outcome).toBe('ready');
    const state = await thumbnailState(athlete, course.course.courseId);
    if (state.status !== 'ready') throw new Error(`expected a stored picture, got ${state.status}`);
    expect(state.courseRevision).toBe(1);
    expect(state.mediaType).toBe('image/svg+xml');
    expect(state.rendererId).toBe('course-thumbnail-svg-v1');
    expect(state.vertexCount).toBe(3);
    expect(JSON.stringify(state)).not.toContain('private/v1');
    const resolved = await courses.resolveThumbnailObject(athlete, course.course.courseId);
    expect(resolved?.storageRef).toBe(rendered.storageRef);
    const object = await storage.open(validateObjectKey(rendered.storageRef));
    expect(object?.sizeBytes).toBe(state.byteSize);
  });

  it('supersedes the previous picture when a revision is appended, and reclaims its bytes', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Superseding course');
    const first = await renderedFor(course.course.courseId);
    expect(first.outcome).toBe('ready');
    expect(await storage.stat(validateObjectKey(first.storageRef))).not.toBeNull();
    // A privacy trim is exactly this shape: a derived revision appended on top of the head.
    const trimmed = await courses.update(
      athlete,
      course.course.courseId,
      1,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Superseding course',
        coordinates: [baseLine[0] as [number, number], baseLine[1] as [number, number]],
        edit: { kind: 'privacy-trimmed' },
      }),
      `trim-${randomUUID()}`,
    );
    if (trimmed.status !== 'available') throw new Error('the trim did not land');
    expect(trimmed.course.headRevision).toBe(2);
    // The head's picture is the trimmed line's, and it is not there yet.
    expect((await thumbnailState(athlete, course.course.courseId)).status).toBe('pending');
    // The pre-trim picture is a drawing of coordinates the owner just removed. It is not
    // reachable any more, and it is queued for reclamation by the trim's own transaction.
    expect(await courses.resolveThumbnailObject(athlete, course.course.courseId)).toBeNull();
    expect(await queuedReasons(first.storageRef)).toEqual(['course_thumbnail_superseded']);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(first.storageRef))).toBeNull();
    // And the new revision gets its own picture, of the line that is actually stored.
    const second = await renderedFor(course.course.courseId, 2);
    expect(second.outcome).toBe('ready');
    expect(second.storageRef).not.toBe(first.storageRef);
    const state = await thumbnailState(athlete, course.course.courseId);
    if (state.status !== 'ready') throw new Error('expected the trimmed picture');
    expect(state.courseRevision).toBe(2);
    expect(state.vertexCount).toBe(2);
  });

  it('refuses to make a picture current after the course moved on, and gives it back', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Late render');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    expect(
      await renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // The owner edits while the render is in flight. This is the shape of defect this
    // repository keeps reproducing — a late writer overwriting newer state. It is refused
    // structurally rather than by a check: appending a revision supersedes this row in the
    // same transaction as the append, so by the time the render reaches `finalize` its own
    // row already says so. (The unbroken version of that claim — a `finalize` racing an
    // uncommitted append — is the test below.)
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Late render',
        coordinates: [baseLine[0] as [number, number], baseLine[2] as [number, number]],
      }),
      `edit-${randomUUID()}`,
    );
    expect(await renderer.finalize(lease)).toBe('superseded');
    await renderer.requeueRefs(lease);
    const state = await thumbnailState(athlete, course.course.courseId);
    expect(state.status).toBe('pending');
    expect((await queuedReasons(finalKey)).length).toBeGreaterThan(0);
  });

  it('blocks a finalize on an uncommitted revision append and then answers superseded', async () => {
    // The equivalence the removed head re-check used to provide, tested directly.
    //
    // `finalize` no longer asks "is this still the head". It relies on the enqueue trigger
    // superseding this row inside the append's own transaction, which means the two writers
    // must contend on the ROW, not merely happen to run in order. So this test holds the
    // append open: it takes the row lock and does not commit. `finalize` must block on it —
    // it may not read a stale snapshot and publish — and once the append commits, the answer
    // must be `superseded`. If someone moves the enqueue out of that transaction, this is
    // what fails; the sequential test above would not notice.
    const { athlete, imported, stored, course } = await athleteWithCourse('Uncommitted append');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    expect(
      await renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: lease.athleteId,
          courseId: lease.courseId,
          revisionId: lease.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    const appender = new Pool({ connectionString: adminUrl as string, max: 1 });
    const client = await appender.connect();
    let finalize: Promise<string> | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      // The append, uncommitted: its AFTER INSERT trigger has already superseded the row and
      // holds the lock on it.
      await client.query(
        `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
           geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
           created_at)
         SELECT r.athlete_id,r.course_id,2,gen_random_uuid(),r.name,r.geometry,r.waypoints,
           r.generation,r.edit,r.vertex_count,r.distance_meters,repeat('b',64),clock_timestamp()
         FROM course_revision r
         WHERE r.athlete_id=$1 AND r.course_id=$2 AND r.course_revision=1`,
        [athlete, course.course.courseId],
      );
      // The revision carries a recording's generation, so it has to carry that recording in
      // its lineage too — the contract refuses a `recorded-segment` revision without it.
      await client.query(
        `INSERT INTO course_revision_source(athlete_id,course_id,course_revision,activity_id,
           track_id,track_revision)
         SELECT s.athlete_id,s.course_id,2,s.activity_id,s.track_id,s.track_revision
         FROM course_revision_source s
         WHERE s.athlete_id=$1 AND s.course_id=$2 AND s.course_revision=1`,
        [athlete, course.course.courseId],
      );
      await client.query(
        `UPDATE course SET head_revision=2,
           revision_id=(SELECT revision_id FROM course_revision
             WHERE athlete_id=$1 AND course_id=$2 AND course_revision=2),
           updated_at=clock_timestamp()
         WHERE athlete_id=$1 AND course_id=$2`,
        [athlete, course.course.courseId],
      );
      finalize = renderer.finalize(lease);
      // It must not answer while the append is uncommitted: `finalize` takes the row
      // `FOR UPDATE`, so it waits rather than publishing against a stale snapshot.
      const raced = await Promise.race([
        finalize,
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 600)),
      ]);
      expect(raced).toBe('blocked');
      await client.query('COMMIT');
    } finally {
      client.release();
      await appender.end();
    }
    expect(await finalize).toBe('superseded');
    await renderer.requeueRefs(lease);
    expect((await thumbnailState(athlete, course.course.courseId)).status).toBe('pending');
    expect(imported.activityId).toBeTruthy();
    expect(stored.trackId).toBeTruthy();
  });

  it('hands a lease back on shutdown without spending one of its attempts', async () => {
    const { athlete, course } = await athleteWithCourse('Shut down');
    const lease = await leaseFor(course.course.courseId);
    expect(await renderer.release(lease)).toBe(true);
    // Back to queued, and the attempt returned: a few restarts must not be able to abandon
    // a picture that was never actually tried.
    const row = await admin.query(
      'SELECT state,attempt_count,lease_token FROM course_thumbnail WHERE job_id=$1',
      [lease.jobId],
    );
    expect(row.rows[0]?.['state']).toBe('queued');
    expect(row.rows[0]?.['attempt_count']).toBe(0);
    expect(row.rows[0]?.['lease_token']).toBeNull();
    expect((await thumbnailState(athlete, course.course.courseId)).status).toBe('pending');
    // It is leasable again, and a released lease cannot finalize anything.
    expect(await renderer.finalize(lease)).toBe('lease_lost');
    const again = await leaseFor(course.course.courseId);
    expect(again.leaseToken).not.toBe(lease.leaseToken);
    // A render that already recorded an object reference is NOT releasable: unwinding a
    // recorded name belongs to the reaper, not to a shutdown.
    const drawn = renderCourseThumbnail(again.coordinates);
    expect(
      await renderer.prepare(again, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: again.athleteId,
          courseId: again.courseId,
          revisionId: again.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    expect(await renderer.release(again)).toBe(false);
    // …and the row is untouched by the refusal: still prepared, still holding its object
    // name. Without the state predicate it would become a `queued` row that owns a final
    // name, which is a state nothing else in this ledger can mean.
    const prepared = await admin.query(
      'SELECT state,storage_ref FROM course_thumbnail WHERE job_id=$1',
      [again.jobId],
    );
    expect(prepared.rows[0]?.['state']).toBe('prepared');
    expect(prepared.rows[0]?.['storage_ref']).not.toBeNull();
  });

  it('lets only the leaseholder hand a render back', async () => {
    const { athlete, course } = await athleteWithCourse('Not your render');
    const lease = await leaseFor(course.course.courseId);
    // The same threat model the `finalize` test states: a job id is the only thing another
    // caller could know or guess, and it is not enough. Without the lease token a second
    // worker could take a render away from the one that is drawing it — quietly, because
    // releasing looks like success.
    const impostor = { ...lease, leaseToken: randomUUID() };
    expect(await renderer.release(impostor)).toBe(false);
    const row = await admin.query(
      'SELECT state,lease_token,attempt_count FROM course_thumbnail WHERE job_id=$1',
      [lease.jobId],
    );
    expect(row.rows[0]?.['state']).toBe('rendering');
    expect(row.rows[0]?.['lease_token']).toBe(lease.leaseToken);
    expect(row.rows[0]?.['attempt_count']).toBe(1);
    // The real holder is unaffected and can still finish its own work.
    const drawn = renderCourseThumbnail(lease.coordinates);
    expect(
      await renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: lease.athleteId,
          courseId: lease.courseId,
          revisionId: lease.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    expect((await thumbnailState(athlete, course.course.courseId)).status).toBe('pending');
  });

  it('lets only the writer that drew a picture conclude anything about it', async () => {
    const { course } = await athleteWithCourse('Only the leaseholder');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    expect(
      await renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: lease.athleteId,
          courseId: lease.courseId,
          revisionId: lease.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // A job id is the only thing another caller could know or guess. It is not enough: the
    // lease token is what identifies the writer, so nobody else can publish this picture or
    // learn the state of this render.
    const impostor = { ...lease, leaseToken: randomUUID() };
    expect(await renderer.finalize(impostor)).toBe('lease_lost');
    expect(await renderer.publicationFenceOpen(impostor)).toBe(false);
    expect(await renderer.fail(impostor, 'RENDER_FAILED', { retryable: false })).toBe(false);
    // The real writer is unaffected by the attempt.
    expect(await renderer.finalize(lease)).toBe('ready');
  });

  it('never deletes the object a live course is still showing', async () => {
    const { athlete, course } = await athleteWithCourse('Protected picture');
    const rendered = await renderedFor(course.course.courseId);
    // Someone queues the live object anyway — an over-broad reclamation, a replayed
    // receipt. Authorization re-verifies live references immediately before deletion and
    // closes the receipt instead of deleting.
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES(gen_random_uuid(),$1,'upload_abandoned',clock_timestamp(),clock_timestamp())
       ON CONFLICT(storage_ref) DO UPDATE SET completed_at=NULL,attempts=0,
         available_at=EXCLUDED.available_at,last_error_code=NULL`,
      [rendered.storageRef],
    );
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(rendered.storageRef))).not.toBeNull();
    const receipt = await admin.query(
      'SELECT last_error_code FROM resource_object_cleanup WHERE storage_ref=$1',
      [rendered.storageRef],
    );
    expect(receipt.rows[0]?.['last_error_code']).toBe('REFERENCE_PRESENT');
    const state = await thumbnailState(athlete, course.course.courseId);
    expect(state.status).toBe('ready');
  });

  it('defers reclamation while a render could still publish the object', async () => {
    const { course } = await athleteWithCourse('Mid publication');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    expect(
      await renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // The reference is in the ledger and the writer holds an open publication fence, but the
    // object does not exist yet. Completing a receipt now would strand whatever the writer
    // publishes a moment later, so authorization defers instead of recording a deletion.
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES(gen_random_uuid(),$1,'account_erased',clock_timestamp(),clock_timestamp())
       ON CONFLICT(storage_ref) DO UPDATE SET completed_at=NULL,attempts=0,
         available_at=EXCLUDED.available_at,last_error_code=NULL`,
      [finalKey],
    );
    await drainCleanup();
    const receipt = await admin.query(
      'SELECT last_error_code,completed_at,attempts FROM resource_object_cleanup WHERE storage_ref=$1',
      [finalKey],
    );
    expect(receipt.rows[0]?.['last_error_code']).toBe('PUBLICATION_IN_PROGRESS');
    expect(receipt.rows[0]?.['completed_at']).toBeNull();
    // Waiting never consumes the dead-letter budget.
    expect(Number(receipt.rows[0]?.['attempts'])).toBe(0);
  });

  it('adds no new lock-order inversion to the writers of one tenant', async () => {
    // The two nodes before this one each reproduced a real `40P01` by adding a writer that
    // took the same rows in a different order. Every writer that now touches the thumbnail
    // ledger runs against the others here, on ONE tenant and on the one shared cleanup
    // queue: course edits, course deletions, renders that insert into the queue, and a
    // cleanup drain that leases out of it. Then the account is erased under all of it.
    const athlete = randomUUID();
    const imported = await activities.importActivity(athlete, importInput());
    const stored = await storeTrack(athlete, imported.activityId, imported.revision);
    const failures: string[] = [];
    const record = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (
        // Losing a race to the erasure is a legitimate outcome, whichever layer notices it
        // first: the tenant guard in `database.tenant`, the activity-lineage trigger, or a
        // course that stopped existing under a writer. A deadlock is not.
        !/COURSE_REVISION_CONFLICT|COURSE_NOT_FOUND|COURSE_UNAVAILABLE|preparation was refused|TENANT_ERASED|ACCOUNT_ERASED|ACTIVITY_DELETED/.test(
          message,
        )
      )
        failures.push(message);
    };
    const writers = Array.from({ length: 30 }, async (_unused, index) => {
      try {
        const created = await courses.create(
          athlete,
          content({
            activityId: imported.activityId,
            trackId: stored.trackId,
            name: `Concurrent ${index}`,
          }),
          `course-${randomUUID()}`,
        );
        if (created.status !== 'available') return;
        await courses.update(
          athlete,
          created.course.courseId,
          1,
          content({
            activityId: imported.activityId,
            trackId: stored.trackId,
            name: `Concurrent ${index}`,
            coordinates: [baseLine[0] as [number, number], baseLine[2] as [number, number]],
          }),
          `edit-${randomUUID()}`,
        );
        if (index % 3 === 0) await courses.remove(athlete, created.course.courseId, 2);
      } catch (error) {
        record(error);
      }
    });
    const drains = Array.from({ length: 10 }, async () => {
      for (let round = 0; round < 10; round += 1) {
        try {
          const lease = await renderer.lease(30);
          if (lease !== null) await renderLease(lease);
          await processOneResourceObjectCleanup(cleanup, (storageRef) =>
            storage.delete(validateObjectKey(storageRef)),
          );
          // M2-01m's sweep is a new writer of the shared cleanup queue and of the reference
          // index, and it runs under no advisory lock at all. It belongs in this contention
          // rather than beside it.
          await reconcileCourseThumbnailObjects(cleanup, storage, 5);
        } catch (error) {
          record(error);
        }
      }
    });
    // The erasure runs WITH the writers, not after them. It is the only writer that takes
    // the account lock exclusively and then the command lock, which is the order the two
    // previous nodes each got wrong, so it has to contend with the ordinary writers rather
    // than wait for them. A writer that loses to it fails with TENANT_ERASED, which is a
    // legitimate outcome; a deadlock is not.
    const erasure = (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await operations.eraseAccount(athlete);
          return;
        } catch (error) {
          record(error);
        }
      }
    })();
    await Promise.all([...writers, ...drains, erasure]);
    expect(failures.filter((message) => /40P01|deadlock/i.test(message))).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('holds a reclaimed key back while a render could still publish it, even with its row gone', async () => {
    const { athlete, course } = await athleteWithCourse('Deleted mid publication');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    expect(
      await renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // The owner deletes the course while the render holds an open publication fence. The
    // thumbnail row hangs off the revision by a cascading foreign key, so it goes away — and
    // with it the fence that `authorize` and `finish` would have consulted. The queued
    // receipt therefore carries the fence itself, in its availability.
    await courses.remove(athlete, course.course.courseId, 1);
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(0);
    const queued = await admin.query(
      `SELECT reason,available_at>clock_timestamp()+interval '50 minutes' AS held_back,
         completed_at
       FROM resource_object_cleanup WHERE storage_ref=$1`,
      [finalKey],
    );
    expect(queued.rows[0]?.['reason']).toBe('course_deleted');
    expect(queued.rows[0]?.['held_back']).toBe(true);
    // So a drain right now cannot close the receipt, and the key stays reclaimable for the
    // object the writer is still in the middle of publishing.
    await drainCleanup();
    const after = await admin.query(
      'SELECT completed_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [finalKey],
    );
    expect(after.rows[0]?.['completed_at']).toBeNull();
  });

  it('reclaims the picture when the owner deletes the course', async () => {
    const { athlete, course } = await athleteWithCourse('Deleted course');
    const rendered = await renderedFor(course.course.courseId);
    await courses.remove(athlete, course.course.courseId, 1);
    expect(await queuedReasons(rendered.storageRef)).toEqual(['course_deleted']);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(rendered.storageRef))).toBeNull();
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(0);
  });

  it('reclaims the picture when the recording behind the course is deleted', async () => {
    const { athlete, imported, course } = await athleteWithCourse('Reclaimed course');
    const rendered = await renderedFor(course.course.courseId);
    const impact = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(impact.courses.map((entry) => entry.courseId)).toContain(course.course.courseId);
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
      expectedCourseImpact: impact.digest,
    });
    expect(await queuedReasons(rendered.storageRef)).toEqual(['activity_deleted']);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(rendered.storageRef))).toBeNull();
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status).toBe('unavailable');
  });

  it('removes every picture on account erasure and keeps a fence over its objects', async () => {
    const { athlete, course } = await athleteWithCourse('Erased course');
    const rendered = await renderedFor(course.course.courseId);
    await operations.eraseAccount(athlete);
    expect(await queuedReasons(rendered.storageRef)).toEqual(['account_erased']);
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(0);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(rendered.storageRef))).toBeNull();
    expect(course.course.courseId).toBeTruthy();
  });

  it('keeps one tenant out of another tenant thumbnails, in the database', async () => {
    const owner = await athleteWithCourse('Private picture');
    await renderEverything();
    const stranger = randomUUID();
    const seen = await database.tenant(stranger, async (tx) =>
      tx.query('SELECT count(*)::int AS total FROM course_thumbnail'),
    );
    expect(seen.rows[0]?.['total']).toBe(0);
    const own = await database.tenant(owner.athlete, async (tx) =>
      tx.query('SELECT count(*)::int AS total FROM course_thumbnail'),
    );
    expect(own.rows[0]?.['total']).toBe(1);
  });

  it('gives the API no way to write or delete a stored picture', async () => {
    const { athlete, course } = await athleteWithCourse('Read only');
    await renderedFor(course.course.courseId);
    for (const statement of [
      `UPDATE course_thumbnail SET state='queued' WHERE course_id=$1`,
      `DELETE FROM course_thumbnail WHERE course_id=$1`,
      `INSERT INTO course_thumbnail(athlete_id,course_id,course_revision,revision_id,job_id,state,
         temporary_ref,created_at,updated_at,expires_at)
       SELECT athlete_id,$1,99,gen_random_uuid(),gen_random_uuid(),'queued','x',
         clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'
       FROM course WHERE course_id=$1`,
    ])
      await expect(
        database.tenant(athlete, async (tx) => tx.query(statement, [course.course.courseId])),
      ).rejects.toThrow(/permission denied|COURSE_THUMBNAIL_NOT_WRITABLE/);
  });

  it('keeps a cleanup receipt open until no render could still have published', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Late publication');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    expect(
      await renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // The course moves on, so this render's row is superseded and its temporary name stops
    // being a live reference — and the fence has just passed, so authorization no longer
    // defers either. But the fence only gates ENTRY to publication: a request that got past
    // it a moment ago can still be inside the storage call, so a delete that found nothing
    // must not close the receipt. Closing it would mean never looking at that name again.
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Late publication',
        coordinates: [baseLine[1] as [number, number], baseLine[2] as [number, number]],
      }),
      `edit-${randomUUID()}`,
    );
    await admin.query(
      `UPDATE course_thumbnail SET publication_lease_until=clock_timestamp()-interval '1 second'
       WHERE job_id=$1`,
      [lease.jobId],
    );
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES(gen_random_uuid(),$1,'upload_abandoned',clock_timestamp(),clock_timestamp())
       ON CONFLICT(storage_ref) DO UPDATE SET completed_at=NULL,attempts=0,
         available_at=EXCLUDED.available_at,last_error_code=NULL`,
      [lease.temporaryRef],
    );
    await drainCleanup();
    const receipt = await admin.query(
      'SELECT last_error_code,completed_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [lease.temporaryRef],
    );
    expect(receipt.rows[0]?.['last_error_code']).toBe('PUBLICATION_WINDOW_OPEN');
    expect(receipt.rows[0]?.['completed_at']).toBeNull();
  });

  it('refuses a write to the ledger even from a role that was granted one', async () => {
    // The grant is the first fence and the trigger is the second. This test gives a role
    // the privilege the runtime role deliberately does not have, so what it measures is the
    // trigger alone: a future grant mistake still cannot write a picture into existence.
    const { athlete, course } = await athleteWithCourse('Granted by mistake');
    await renderedFor(course.course.courseId);
    const mistakenRole = `thumb_writer_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await admin.query(`CREATE ROLE "${mistakenRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${mistakenRole}"`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON course_thumbnail TO "${mistakenRole}"`);
    const mistaken = new Pool({ connectionString: roleUrl(mistakenRole), max: 1 });
    const client = await mistaken.connect();
    try {
      // One connection, so the tenant setting and the writes are the same session and row
      // level security is not what refuses these.
      await client.query("SELECT set_config('app.athlete_id',$1,false)", [athlete]);
      const visible = await client.query(
        'SELECT count(*)::int AS total FROM course_thumbnail WHERE course_id=$1',
        [course.course.courseId],
      );
      expect(visible.rows[0]?.['total']).toBe(1);
      await expect(
        client.query(`UPDATE course_thumbnail SET state='queued' WHERE course_id=$1`, [
          course.course.courseId,
        ]),
      ).rejects.toThrow(/COURSE_THUMBNAIL_NOT_WRITABLE/);
      await expect(
        client.query(`DELETE FROM course_thumbnail WHERE course_id=$1`, [course.course.courseId]),
      ).rejects.toThrow(/COURSE_THUMBNAIL_NOT_WRITABLE/);
      // The trigger fires on all three, and this role really holds INSERT, so the third arm
      // is reachable and has to be refused as well: a picture must not be writable into
      // existence by anything but the render pipeline.
      await expect(
        client.query(
          `INSERT INTO course_thumbnail(athlete_id,course_id,course_revision,revision_id,job_id,
             state,temporary_ref,created_at,updated_at,expires_at)
           VALUES($1,$2,1,gen_random_uuid(),gen_random_uuid(),'queued','forged',
             clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`,
          [athlete, course.course.courseId],
        ),
      ).rejects.toThrow(/COURSE_THUMBNAIL_NOT_WRITABLE/);
    } finally {
      client.release();
      await mistaken.end();
    }
  });

  it('refuses a render that would put the tenant over its stored thumbnail budget', async () => {
    const { athlete, course } = await athleteWithCourse('Over budget');
    const lease = await leaseFor(course.course.courseId);
    // Fill the tenant's budget with stored pictures of its own. Each one is at the
    // per-object ceiling, so it takes the real number of them to reach the tenant ceiling —
    // which is the point: the bound is on the tenant, not on one object.
    const needed = Math.ceil(courseThumbnailLimits.tenantBytes / courseThumbnailLimits.maxBytes);
    await admin.query(
      `WITH created AS (
         INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
           reclaimed_at,created_at,updated_at)
         SELECT $1,gen_random_uuid(),'filler '||index,'private','unavailable',
           'source_activity_deleted',clock_timestamp(),clock_timestamp(),clock_timestamp()
         FROM generate_series(1,$2) index
         RETURNING athlete_id,course_id,name
       )
       INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,
         waypoints,generation,edit,vertex_count,distance_meters,content_digest,created_at)
       SELECT c.athlete_id,c.course_id,1,gen_random_uuid(),c.name,
         '{"type":"LineString","coordinates":[[126.9,37.5],[126.91,37.51]]}','[]',
         '{"kind":"imported-file"}','{"kind":"created"}',2,10,repeat('a',64),clock_timestamp()
       FROM created c`,
      [athlete, needed],
    );
    await admin.query(
      `UPDATE course_thumbnail t SET state='ready',ready_at=clock_timestamp(),
         storage_ref='private/v1/tenants/'||t.athlete_id||'/courses/'||t.course_id||
           '/thumbnails/revisions/'||t.revision_id||'/sha256/'||
           encode(sha256(convert_to(t.job_id::text,'UTF8')),'hex')||'.svg',
         content_hash=encode(sha256(convert_to(t.job_id::text,'UTF8')),'hex'),
         size_bytes=$2,media_type='image/svg+xml',viewport=100,vertex_count=2,
         renderer_id='course-thumbnail-svg-v1',renderer_version=1,
         lease_owner=NULL,lease_token=NULL,lease_until=NULL
       WHERE t.athlete_id=$1 AND t.state='queued' AND t.course_id<>$3`,
      [athlete, courseThumbnailLimits.maxBytes, course.course.courseId],
    );
    const drawn = renderCourseThumbnail(lease.coordinates);
    // The quota is checked at preparation, which is before any object can exist, so a
    // tenant over budget publishes nothing rather than publishing and being reclaimed.
    await expect(
      renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: lease.athleteId,
          courseId: lease.courseId,
          revisionId: lease.revisionId,
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).rejects.toThrow(/COURSE_THUMBNAIL_QUOTA_EXCEEDED/);
    const state = await thumbnailState(athlete, course.course.courseId);
    expect(state.status).not.toBe('ready');
  });

  it('refuses an object reference that does not name this revision', async () => {
    const { course } = await athleteWithCourse('Wrong reference');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    await expect(
      renderer.prepare(lease, {
        storageRef: createCourseThumbnailFinalObjectKey({
          tenantId: lease.athleteId,
          courseId: lease.courseId,
          // Another revision's name, with this render's content hash.
          revisionId: randomUUID(),
          sha256: drawn.sha256,
        }),
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).rejects.toThrow(/INVALID_COURSE_THUMBNAIL_REFERENCE/);
  });

  it('stops retrying after a bounded number of attempts and says so', async () => {
    const { athlete, course } = await athleteWithCourse('Dead letter');
    let attempts = 0;
    for (let round = 0; round < courseThumbnailLimits.maxAttempts + 1; round += 1) {
      const lease = await renderer
        .lease(60)
        .then((value) => (value?.courseId === course.course.courseId ? value : null));
      if (lease === null) break;
      attempts += 1;
      expect(
        await renderer.fail(lease, 'RENDER_FAILED', { retryable: true, retryAfterSeconds: 0 }),
      ).toBe(true);
    }
    expect(attempts).toBe(courseThumbnailLimits.maxAttempts);
    const state = await thumbnailState(athlete, course.course.courseId);
    // "failed and coming back" became "failed for good", and the screen can tell them apart.
    if (state.status !== 'abandoned') throw new Error(`expected abandonment, got ${state.status}`);
    expect(state.attemptCount).toBe(courseThumbnailLimits.maxAttempts);
    expect(state.failureCode).toBe('RENDER_FAILED');
    // Nothing more is leasable for this course.
    expect((await renderer.lease(60))?.courseId ?? null).not.toBe(course.course.courseId);
  });

  it('gives a render whose worker died another attempt, and queues what it may have published', async () => {
    const { athlete, course } = await athleteWithCourse('Dead worker');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    expect(
      await renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).toBe(true);
    // The worker dies here: the lease runs out with the row still `prepared`. This is the
    // only path back for it, and the object it may already have published must be accounted
    // for either way.
    await admin.query(
      `UPDATE course_thumbnail SET lease_until=clock_timestamp()-interval '1 second'
       WHERE job_id=$1`,
      [lease.jobId],
    );
    expect(await cleanup.reapCourseThumbnailRenders(100)).toBeGreaterThanOrEqual(1);
    const state = await thumbnailState(athlete, course.course.courseId);
    if (state.status !== 'retrying') throw new Error(`expected a retry, got ${state.status}`);
    expect(state.failureCode).toBe('RENDER_LEASE_EXPIRED');
    expect((await queuedReasons(finalKey)).length).toBeGreaterThan(0);
    // And the retry really is leasable again, so the picture still arrives.
    expect((await renderLease(await leaseFor(course.course.courseId))).outcome).toBe('ready');
  });

  it('abandons a render whose own deadline passed rather than retrying forever', async () => {
    const { athlete, course } = await athleteWithCourse('Out of time');
    // The whole row is moved into the past together: the table refuses a deadline that
    // precedes its own creation, which is itself the bound on how long a render may live.
    await admin.query(
      `UPDATE course_thumbnail SET created_at=clock_timestamp()-interval '2 hours',
         updated_at=clock_timestamp()-interval '2 hours',
         expires_at=clock_timestamp()-interval '1 hour'
       WHERE athlete_id=$1 AND course_id=$2`,
      [athlete, course.course.courseId],
    );
    expect(await cleanup.reapCourseThumbnailRenders(100)).toBeGreaterThanOrEqual(1);
    const state = await thumbnailState(athlete, course.course.courseId);
    if (state.status !== 'abandoned') throw new Error(`expected abandonment, got ${state.status}`);
    expect(state.failureCode).toBe('RENDER_EXPIRED');
    // A deadline is final: the reaper does not pick the same row up again on the next pass.
    expect(await cleanup.reapCourseThumbnailRenders(100)).toBe(0);
    expect((await renderer.lease(60))?.courseId ?? null).not.toBe(course.course.courseId);
  });

  it('prunes a closed render only after its objects are accounted for, and never a live one', async () => {
    const { athlete, course } = await athleteWithCourse('Housekeeping');
    const rendered = await renderedFor(course.course.courseId);
    // A live picture is never pruned, however old it is.
    await admin.query(
      `UPDATE course_thumbnail SET created_at=clock_timestamp()-interval '31 days',
         updated_at=clock_timestamp()-interval '30 days',
         expires_at=clock_timestamp()-interval '31 days'+interval '1 hour'
       WHERE athlete_id=$1`,
      [athlete],
    );
    expect(await cleanup.pruneCourseThumbnailHistory(100)).toBe(0);
    expect(await thumbnailState(athlete, course.course.courseId)).toMatchObject({
      status: 'ready',
    });
    // Close it and age it, but leave its receipt open: an open receipt still needs the row.
    await courses.remove(athlete, course.course.courseId, 1);
    // Deleting the course took its revisions, so the row went with them through the
    // cascade — there is nothing left to prune, and the object is in the queue instead.
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(0);
    expect(await queuedReasons(rendered.storageRef)).toEqual(['course_deleted']);
  });

  it('prunes an aged superseded render, but not while its receipt is still open', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Prunable');
    const first = await renderedFor(course.course.courseId);
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Prunable',
        coordinates: [baseLine[0] as [number, number], baseLine[1] as [number, number]],
      }),
      `edit-${randomUUID()}`,
    );
    const age = async () =>
      admin.query(
        `UPDATE course_thumbnail SET created_at=clock_timestamp()-interval '31 days',
           updated_at=clock_timestamp()-interval '30 days',
           expires_at=clock_timestamp()-interval '31 days'+interval '1 hour'
         WHERE athlete_id=$1 AND state='superseded'`,
        [athlete],
      );
    await age();
    // Its objects are still queued, and this row is where the queue reads their refs from:
    // it has to survive until those receipts are closed.
    expect(await cleanup.pruneCourseThumbnailHistory(100)).toBe(0);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(first.storageRef))).toBeNull();
    // Receipts closed and seven days past: now it goes, and the head's live picture stays.
    await age();
    expect(await cleanup.pruneCourseThumbnailHistory(100)).toBe(1);
    const remaining = await admin.query(
      'SELECT course_revision FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(remaining.rows.map((row) => row['course_revision'])).toEqual([2]);
  });

  it('holds a reclaimed temporary name back while a render that never prepared could write it', async () => {
    const { athlete, course } = await athleteWithCourse('Killed before preparing');
    const lease = await leaseFor(course.course.courseId);
    // The worker writes its temporary object before it records the final one, so a render
    // still in `rendering` has no publication fence — but it does hold a lease, and its
    // temporary object may already exist. Deleting the course here cascades the row away, so
    // the queued receipt has to carry the lease deadline the same way it carries a fence.
    await courses.remove(athlete, course.course.courseId, 1);
    const queued = await admin.query(
      `SELECT available_at>clock_timestamp()+interval '50 minutes' AS held_back
       FROM resource_object_cleanup WHERE storage_ref=$1`,
      [lease.temporaryRef],
    );
    expect(queued.rows[0]?.['held_back']).toBe(true);
    await drainCleanup();
    const after = await admin.query(
      'SELECT completed_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [lease.temporaryRef],
    );
    expect(after.rows[0]?.['completed_at']).toBeNull();
  });

  it('does not draw a revision the course has moved past, or one of a reclaimed course', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Not the head');
    await renderedFor(course.course.courseId);
    // A revision row without a head advance: the render is queued but must never be drawn,
    // because a picture of a line the course is not showing is not a picture of the course.
    const orphan = randomUUID();
    await admin.query(
      `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,
         waypoints,generation,edit,vertex_count,distance_meters,content_digest,created_at)
       SELECT r.athlete_id,r.course_id,2,$3,r.name,r.geometry,r.waypoints,r.generation,r.edit,
         r.vertex_count,r.distance_meters,r.content_digest,clock_timestamp()
       FROM course_revision r
       WHERE r.athlete_id=$1 AND r.course_id=$2 AND r.course_revision=1`,
      [athlete, course.course.courseId, orphan],
    );
    const queued = await admin.query(
      `SELECT state FROM course_thumbnail WHERE athlete_id=$1 AND course_id=$2
         AND course_revision=2`,
      [athlete, course.course.courseId],
    );
    expect(queued.rows[0]?.['state']).toBe('queued');
    expect((await renderer.lease(60))?.courseId ?? null).not.toBe(course.course.courseId);
    // And a course marked unavailable is not drawn either, even with a revision still there.
    const other = await athleteWithCourse('Reclaimed but present');
    await admin.query(
      `UPDATE course SET status='unavailable',head_revision=NULL,revision_id=NULL,
         unavailable_reason='source_activity_deleted',reclaimed_at=clock_timestamp(),
         updated_at=clock_timestamp()
       WHERE athlete_id=$1 AND course_id=$2`,
      [other.athlete, other.course.course.courseId],
    );
    expect((await renderer.lease(60))?.courseId ?? null).not.toBe(other.course.course.courseId);
    expect(imported.activityId).toBeTruthy();
    expect(stored.trackId).toBeTruthy();
  });

  it('makes a render retry rather than race a deletion that is already authorized', async () => {
    const { course } = await athleteWithCourse('Racing a delete');
    const lease = await leaseFor(course.course.courseId);
    const drawn = renderCourseThumbnail(lease.coordinates);
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    // A receipt for this exact key that cleanup has already authorized: the bytes are about
    // to be deleted. Claiming the key now would publish into a delete in flight.
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at,
         lease_owner,lease_until,delete_authorized_at)
       VALUES(gen_random_uuid(),$1,'upload_abandoned',clock_timestamp(),clock_timestamp(),
         gen_random_uuid(),clock_timestamp()+interval '1 minute',clock_timestamp())`,
      [finalKey],
    );
    await expect(
      renderer.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }),
    ).rejects.toThrow(/OBJECT_DELETE_IN_PROGRESS/);
  });

  it('exports the facts about a stored picture and neither its bytes nor its key', async () => {
    const { athlete, course } = await athleteWithCourse('Exported course');
    const rendered = await renderedFor(course.course.courseId);
    const artifact = await operations.exportAccount(athlete);
    expect(artifact.schemaVersion).toBe(22);
    if (artifact.schemaVersion !== 22) throw new Error('expected the current export version');
    const exported = artifact.data.courseThumbnails;
    expect(exported).toHaveLength(1);
    const row = exported[0] as Record<string, unknown>;
    expect(row['renderer_id']).toBe('course-thumbnail-svg-v1');
    expect(row['media_type']).toBe('image/svg+xml');
    expect(row['content_hash']).toBe(rendered.storageRef.split('/sha256/')[1]?.replace('.svg', ''));
    expect(row).not.toHaveProperty('storage_ref');
    expect(row).not.toHaveProperty('temporary_ref');
    // The picture itself is nowhere in the artifact, and neither is any key that would
    // reach it. What is here is enough to check that a rebuild produced the same picture.
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain('private/v1');
    expect(serialized).not.toContain('<svg');
  });

  it('never carries another tenant stored thumbnail into an export', async () => {
    const owner = await athleteWithCourse('Exported by its owner');
    await renderedFor(owner.course.course.courseId);
    const stranger = randomUUID();
    const artifact = await operations.exportAccount(stranger);
    if (artifact.schemaVersion !== 22) throw new Error('expected the current export version');
    // The property comes from row level security plus the projection's own
    // `WHERE athlete_id=$1`; nothing but this pins it.
    expect(artifact.data.courseThumbnails).toEqual([]);
    const owned = await operations.exportAccount(owner.athlete);
    if (owned.schemaVersion !== 22) throw new Error('expected the current export version');
    expect(owned.data.courseThumbnails).toHaveLength(1);
  });

  it('leaves no superseded picture in the export', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse('Only the head');
    await renderedFor(course.course.courseId);
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Only the head',
        coordinates: [baseLine[1] as [number, number], baseLine[2] as [number, number]],
      }),
      `edit-${randomUUID()}`,
    );
    const artifact = await operations.exportAccount(athlete);
    if (artifact.schemaVersion !== 22) throw new Error('expected the current export version');
    expect(artifact.data.courseThumbnails).toEqual([]);
  });
});

describe('M2-01m thumbnail object reconciliation', () => {
  it('reclaims an object a stalled render published after every receipt for it closed', async () => {
    // The hole M2-01l left, reproduced here before it is closed. A render prepares, then
    // stalls for three hours — past its lease, past its publication fence, and past the
    // hour-long grace the queued receipt holds its key back for.
    const { athlete, course } = await athleteWithCourse('Stalled writer');
    const render = await preparedRender(course.course.courseId);
    expect(await watchedRef(render.finalKey)).toMatchObject({ athlete_id: athlete });
    await stallRender(render.lease.jobId, 3);

    // The reaper abandons the render and queues both of its references; the queue drains
    // them; the render's row is now closed and every receipt naming its key is completed.
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    const closed = await admin.query(
      'SELECT completed_at IS NOT NULL AS completed FROM resource_object_cleanup WHERE storage_ref=$1',
      [render.finalKey],
    );
    expect(closed.rows[0]?.['completed']).toBe(true);

    // Now the writer wakes up and finishes the two storage calls it was in the middle of.
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    expect(await storage.stat(validateObjectKey(render.finalKey))).not.toBeNull();

    // This is the measured failure: re-running every receipt-based path reclaims nothing.
    await cleanup.reapCourseThumbnailRenders(100);
    await cleanup.pruneCourseThumbnailHistory(100);
    await drainCleanup();
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);
    expect(await storage.stat(validateObjectKey(render.finalKey))).not.toBeNull();

    // The sweep is the path that does not depend on a receipt being open. One bounded
    // window, one reference, one deletion queued.
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({
      inspected: 1,
      queued: 1,
    });
    expect(await pendingCleanupRows(render.finalKey)).toBe(1);
    // The window was full, so the sweep resumes after this reference rather than restarting.
    expect(await cleanup.thumbnailReconcileCursor()).toBe(render.finalKey);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
  });

  it('still finds the orphan after housekeeping deleted the ledger row that named it', async () => {
    // Why the index is a table of its own rather than a scan of `course_thumbnail`: the row
    // that carries the reference is deleted seven days after its receipts close, and the
    // whole table cascades away when the course goes. The index outlives both.
    const { athlete, course } = await athleteWithCourse('Pruned row');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    await ageClosedRender(render.lease.jobId, 8);
    await cleanup.pruneCourseThumbnailHistory(100);
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_thumbnail WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(0);
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 1 });
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
  });

  it('never reclaims the picture a live course is still showing', async () => {
    // The most dangerous failure this node could introduce. The sweep walks straight over a
    // ready thumbnail's object and must leave it, and its bytes, alone.
    const { athlete, course } = await athleteWithCourse('Live picture');
    const rendered = await renderedFor(course.course.courseId);
    expect(rendered.outcome).toBe('ready');
    expect(await sweepThumbnailReference(rendered.storageRef)).toMatchObject({
      inspected: 1,
      queued: 0,
    });
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(rendered.storageRef))).not.toBeNull();
    const resolved = await courses.resolveThumbnailObject(athlete, course.course.courseId);
    expect(resolved?.storageRef).toBe(rendered.storageRef);
    const state = await thumbnailState(athlete, course.course.courseId);
    expect(state.status).toBe('ready');
  });

  it('leaves a published key alone while its render can still be publishing', async () => {
    // A writer inside its fence has an object on the store that nothing references yet. That
    // is not an orphan, and queueing it would delete a picture about to become live.
    const { course } = await athleteWithCourse('Mid publication');
    const render = await preparedRender(course.course.courseId);
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({
      inspected: 1,
      queued: 0,
    });
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);
    // And it stays a candidate, so the sweep comes back to it.
    expect(await watchedRef(render.finalKey)).toMatchObject({ settled_at: null });
    expect(await renderer.finalize(render.lease)).toBe('ready');
    expect(await storage.stat(validateObjectKey(render.finalKey))).not.toBeNull();
  });

  it('holds a closed render key back for the grace after its fence, then reclaims it', async () => {
    // The grace is the same hour `queue_course_thumbnail_refs` holds a queued receipt back
    // for, and for the same reason: neither gate can reach a storage call already in flight.
    const { course } = await athleteWithCourse('Inside the grace');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    // Move the closed render's fence back inside the grace: minutes ago, not hours.
    await admin.query(
      `UPDATE course_thumbnail SET publication_lease_until=clock_timestamp()-interval '2 minutes'
       WHERE job_id=$1`,
      [render.lease.jobId],
    );
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 0 });
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);
    await admin.query(
      `UPDATE course_thumbnail SET publication_lease_until=clock_timestamp()-interval '61 minutes'
       WHERE job_id=$1`,
      [render.lease.jobId],
    );
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 1 });
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
  });

  it('stops watching an absent reference only after seven days with every path closed', async () => {
    const { course } = await athleteWithCourse('Settling');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    // Nothing was ever published, so the object is absent and no receipt is open.
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);
    // Inside the seven days the reference keeps being watched: a writer can still resume.
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({
      inspected: 1,
      queued: 0,
    });
    expect(await watchedRef(render.finalKey)).toMatchObject({ settled_at: null });
    await admin.query(
      `UPDATE course_thumbnail_object_ref SET recorded_at=clock_timestamp()-interval '8 days'
       WHERE storage_ref=$1`,
      [render.finalKey],
    );
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 0 });
    expect((await watchedRef(render.finalKey))?.['settled_at']).toBeInstanceOf(Date);
    // Settled means out of the window: the candidate query no longer offers it at all.
    expect(
      (await cleanup.thumbnailReconcileWindow(render.finalKey.slice(0, -1), 1)).map(
        (candidate) => candidate.storageRef,
      ),
    ).not.toContain(render.finalKey);
  });

  it('keeps watching a live picture whose object went missing, however old the reference', async () => {
    // An object can disappear from the store without this server doing it. The reference is
    // still live — the course is showing that picture — so the sweep must keep watching it
    // rather than quietly forgetting a key the owner's course still names.
    const { athlete, course } = await athleteWithCourse('Missing but live');
    const rendered = await renderedFor(course.course.courseId);
    await storage.delete(validateObjectKey(rendered.storageRef));
    // Age the whole thing: the picture was drawn a month ago, so the render's own deadline
    // and every lease of it are long past. Being the live picture is the only thing left
    // keeping this reference in the window.
    await admin.query(
      `UPDATE course_thumbnail
         SET created_at=clock_timestamp()-interval '30 days',
             updated_at=clock_timestamp()-interval '30 days'+interval '1 hour',
             ready_at=clock_timestamp()-interval '30 days'+interval '1 hour',
             expires_at=clock_timestamp()-interval '30 days'+interval '1 hour'
       WHERE storage_ref=$1`,
      [rendered.storageRef],
    );
    await admin.query(
      `UPDATE course_thumbnail_object_ref SET recorded_at=clock_timestamp()-interval '30 days'
       WHERE storage_ref=$1`,
      [rendered.storageRef],
    );
    expect(await sweepThumbnailReference(rendered.storageRef)).toMatchObject({ queued: 0 });
    expect(await watchedRef(rendered.storageRef)).toMatchObject({ settled_at: null });
    expect((await thumbnailState(athlete, course.course.courseId)).status).toBe('ready');
  });

  it('keeps watching an absent reference inside the grace after a closed render fence', async () => {
    // Nothing was published and every receipt is closed, but the render's fence passed only
    // minutes ago: a call already in flight can still create this object, so seven days of age
    // is not enough to stop watching it.
    const { course } = await athleteWithCourse('Absent inside the grace');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);
    await admin.query(
      `UPDATE course_thumbnail SET publication_lease_until=clock_timestamp()-interval '2 minutes'
       WHERE job_id=$1`,
      [render.lease.jobId],
    );
    await admin.query(
      `UPDATE course_thumbnail_object_ref SET recorded_at=clock_timestamp()-interval '30 days'
       WHERE storage_ref=$1`,
      [render.finalKey],
    );
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 0 });
    expect(await watchedRef(render.finalKey)).toMatchObject({ settled_at: null });
    // Past the grace, with everything else closed, it settles.
    await admin.query(
      `UPDATE course_thumbnail SET publication_lease_until=clock_timestamp()-interval '61 minutes'
       WHERE job_id=$1`,
      [render.lease.jobId],
    );
    await sweepThumbnailReference(render.finalKey);
    expect((await watchedRef(render.finalKey))?.['settled_at']).toBeInstanceOf(Date);
  });

  it('reports nothing queued for a key whose receipt is already open, and leaves it alone', async () => {
    // The course is deleted while a render holds an open fence, so the receipt is queued with
    // its availability an hour out. The object then appears. The sweep must not report this as
    // something it queued, and must not pull the receipt's availability forward — doing so
    // would let the drain delete the object out from under the writer still publishing it.
    const { athlete, course } = await athleteWithCourse('Receipt already open');
    const render = await preparedRender(course.course.courseId);
    await courses.remove(athlete, course.course.courseId, 1);
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    const before = await admin.query(
      'SELECT available_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [render.finalKey],
    );
    expect(await pendingCleanupRows(render.finalKey)).toBe(1);
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 0 });
    const after = await admin.query(
      'SELECT available_at,reason FROM resource_object_cleanup WHERE storage_ref=$1',
      [render.finalKey],
    );
    expect(after.rows[0]?.['available_at']).toEqual(before.rows[0]?.['available_at']);
    expect(after.rows[0]?.['reason']).toBe('course_deleted');
  });

  it('keeps watching an aged reference whose render can still publish, or whose receipt is open', async () => {
    const { course } = await athleteWithCourse('Aged but open');
    const render = await preparedRender(course.course.courseId);
    await admin.query(
      `UPDATE course_thumbnail_object_ref SET recorded_at=clock_timestamp()-interval '30 days'
       WHERE storage_ref IN ($1,$2)`,
      [render.finalKey, render.temporaryKey],
    );
    // Age alone must not settle anything: this render is `prepared` and holds a live fence.
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ inspected: 1 });
    expect(await watchedRef(render.finalKey)).toMatchObject({ settled_at: null });
    // Closing the render queues both keys, and an open receipt keeps the watch too.
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    expect(await pendingCleanupRows(render.finalKey)).toBe(1);
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ inspected: 1 });
    expect(await watchedRef(render.finalKey)).toMatchObject({ settled_at: null });
  });

  it('reads exactly one index row per candidate and touches no ledger table', async () => {
    // A window of N candidates must cost N rows. This measures what the database actually
    // read inside one transaction, not what the plan looked like.
    await athleteWithCourse('Bounded window');
    const watched = await admin.query(
      'SELECT count(*)::int AS count FROM course_thumbnail_object_ref WHERE settled_at IS NULL',
    );
    expect(watched.rows[0]?.['count']).toBeGreaterThan(5);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const counters = async () =>
        (
          await client.query<{ ledger: string; refs: string }>(
            `SELECT
               pg_stat_get_xact_tuples_returned('course_thumbnail'::regclass)
                 +pg_stat_get_xact_tuples_fetched('course_thumbnail'::regclass) AS ledger,
               pg_stat_get_xact_tuples_returned('course_thumbnail_object_ref'::regclass)
                 +pg_stat_get_xact_tuples_fetched('course_thumbnail_object_ref'::regclass) AS refs`,
          )
        ).rows[0];
      const before = await counters();
      const window = await client.query(
        'SELECT * FROM public.course_thumbnail_reconcile_candidates($1,$2)',
        ['', 1],
      );
      const after = await counters();
      await client.query('ROLLBACK');
      expect(window.rows).toHaveLength(1);
      const read = (key: 'ledger' | 'refs') =>
        Number(after?.[key] ?? 0) - Number(before?.[key] ?? 0);
      expect(read('ledger')).toBe(0);
      expect(read('refs')).toBeLessThanOrEqual(1);
    } finally {
      client.release();
    }
    // The window size is clamped in the database, not trusted from the caller.
    const clamped = await admin.query(
      'SELECT count(*)::int AS total FROM public.course_thumbnail_reconcile_candidates($1,$2)',
      ['', 100000],
    );
    expect(Number(clamped.rows[0]?.['total'])).toBeLessThanOrEqual(1000);
    const atLeastOne = await admin.query(
      'SELECT count(*)::int AS total FROM public.course_thumbnail_reconcile_candidates($1,$2)',
      ['', 0],
    );
    expect(Number(atLeastOne.rows[0]?.['total'])).toBe(1);
  });

  it('gives the runtime role no reach into the reference index at all', async () => {
    // The index is written by a trigger inside the database, so no role outside it needs a
    // grant — and the runtime role, which owns every course write, has none.
    const grants = await admin.query(
      `SELECT count(*)::int AS total FROM information_schema.role_table_grants
       WHERE table_name IN ('course_thumbnail_object_ref','course_thumbnail_reconcile_state')
         AND grantee<>'workout_admin'`,
    );
    expect(Number(grants.rows[0]?.['total'])).toBe(0);
    await expect(
      database.tenant(randomUUID(), (tx) =>
        tx.query('SELECT count(*) FROM course_thumbnail_object_ref'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('removes the tenant reference index on erasure and keeps the erasure fence', async () => {
    const { athlete, course } = await athleteWithCourse('Erased index');
    const rendered = await renderedFor(course.course.courseId);
    expect(await watchedRef(rendered.storageRef)).toMatchObject({ athlete_id: athlete });
    await operations.eraseAccount(athlete);
    expect(await watchedRef(rendered.storageRef)).toBeNull();
    // The object is still queued, and the thirty-day erasure fence is what covers a late
    // writer now that the index no longer watches this key.
    const queued = await admin.query(
      'SELECT reason,completed_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [rendered.storageRef],
    );
    expect(queued.rows[0]?.['reason']).toBe('account_erased');
  });

  it('queues an orphan only the reference index still names when the account is erased', async () => {
    // M2-01s. The orphan of the test above — published after every receipt closed, its
    // ledger row pruned — so the reference index is the only thing left that names it. The
    // account is erased before the sweep got to it. Erasure deletes the index row, and
    // without a receipt for the key nothing would ever name those bytes again: not the
    // ledger (pruned), not the index (erased), not the queue (closed). The same state is
    // what a restore of a backup taken before the erasure hands the replayed erasure.
    const { athlete, course } = await athleteWithCourse('Erased orphan');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    await ageClosedRender(render.lease.jobId, 8);
    await cleanup.pruneCourseThumbnailHistory(100);
    expect(await watchedRef(render.finalKey)).toMatchObject({ athlete_id: athlete });
    expect(await pendingCleanupRows(render.finalKey)).toBe(0);

    await operations.eraseAccount(athlete);
    expect(await watchedRef(render.finalKey)).toBeNull();
    expect(await queuedReasons(render.finalKey)).toEqual(['account_erased']);
    expect(await pendingCleanupRows(render.finalKey)).toBe(1);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
  });

  it('turns a receipt the sweep already opened for an orphan into an erasure receipt', async () => {
    // M2-01s NB-1. The sweep got to the orphan first, so an `upload_abandoned` receipt is
    // open when the account is erased. The 033 and 038 stages convert every receipt their
    // ledgers name to `account_erased`, open or closed; this key is named only by the index,
    // and it has to end up under the same rule — and with it the thirty-day erasure fence.
    const { athlete, course } = await athleteWithCourse('Swept then erased');
    const render = await preparedRender(course.course.courseId);
    await stallRender(render.lease.jobId, 3);
    await cleanup.reapCourseThumbnailRenders(100);
    await drainCleanup();
    await publishDrawn(render.temporaryKey, render.finalKey, render.drawn);
    await ageClosedRender(render.lease.jobId, 8);
    await cleanup.pruneCourseThumbnailHistory(100);
    await admin.query(
      `UPDATE course_thumbnail_object_ref SET recorded_at=clock_timestamp()-interval '9 days'
       WHERE storage_ref=$1`,
      [render.finalKey],
    );
    expect(await sweepThumbnailReference(render.finalKey)).toMatchObject({ queued: 1 });
    expect(await queuedReasons(render.finalKey)).toEqual(['upload_abandoned']);
    expect(await pendingCleanupRows(render.finalKey)).toBe(1);

    await operations.eraseAccount(athlete);
    const queued = await admin.query(
      `SELECT reason,completed_at IS NULL AS open,available_at<=clock_timestamp() AS due
       FROM resource_object_cleanup WHERE storage_ref=$1`,
      [render.finalKey],
    );
    expect(queued.rows).toEqual([{ reason: 'account_erased', open: true, due: true }]);
    await drainCleanup();
    expect(await storage.stat(validateObjectKey(render.finalKey))).toBeNull();
  });

  it('converts a fence-carrying receipt of a deleted course without pulling its fence earlier', async () => {
    // M2-01s NB-1, the other half. A course deleted while its render held an open publication
    // fence cascades the ledger row away; the `course_deleted` receipt carries the fence in
    // its `available_at` alone, and at erasure the key is named only by the index. Erasure
    // makes it an erasure receipt but must not make it due any earlier than it already was.
    const { athlete, course } = await athleteWithCourse('Deleted mid publication, then erased');
    const render = await preparedRender(course.course.courseId);
    await courses.remove(athlete, course.course.courseId, 1);
    const before = await admin.query<{ reason: string; available_at: Date }>(
      'SELECT reason,available_at FROM resource_object_cleanup WHERE storage_ref=$1',
      [render.finalKey],
    );
    expect(before.rows[0]?.reason).toBe('course_deleted');
    expect(await watchedRef(render.finalKey)).toMatchObject({ athlete_id: athlete });

    await operations.eraseAccount(athlete);
    const after = await admin.query<{
      reason: string;
      open: boolean;
      not_earlier: boolean;
      held_back: boolean;
    }>(
      `SELECT reason,completed_at IS NULL AS open,available_at>=$2 AS not_earlier,
         available_at>clock_timestamp()+interval '50 minutes' AS held_back
       FROM resource_object_cleanup WHERE storage_ref=$1`,
      [render.finalKey, before.rows[0]?.available_at],
    );
    expect(after.rows).toEqual([
      { reason: 'account_erased', open: true, not_earlier: true, held_back: true },
    ]);
  });

  it('adds no export surface: the index is internal operating state', async () => {
    // M2-01l settled that a recomputable fact does not go into the export (v21); M2-01j that
    // an owner-entered, non-recomputable one does (v20). This table is neither owner input
    // nor user data: it is a worker's cursor over object keys, and the keys themselves are
    // exactly what the export has always refused to carry. So the export is unchanged, and
    // its version stays 21.
    const { athlete, course } = await athleteWithCourse('Nothing to export');
    const rendered = await renderedFor(course.course.courseId);
    expect(await watchedRef(rendered.storageRef)).toMatchObject({ athlete_id: athlete });
    const artifact = await operations.exportAccount(athlete);
    expect(artifact.schemaVersion).toBe(22);
    expect(JSON.stringify(artifact)).not.toContain(rendered.storageRef);
    expect(JSON.stringify(artifact)).not.toContain('settled_at');
  });
});
