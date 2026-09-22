import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import { courseLimits } from '@workout/contracts/courses';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  CourseNotFoundError,
  courseGeometrySha256,
  CourseStateError,
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantActivityTracks, grantCourses, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { PersistenceConflict } from '../src/outbox.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let courses: CourseRepository;
let tracks: ActivityTrackRepository;
let activities: ActivityRepository;

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
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  courses = createCourseRepository(database);
  tracks = createActivityTrackRepository(database);
  activities = createActivityRepository(database);
});

afterAll(async () => {
  await database?.close();
  await admin.end();
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

function finalRef(input: {
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

/** Store one recording, as the API's upload lifecycle does. */
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
      storageRef: finalRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: finalRef({
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

const coordinates: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function content(input: {
  activityId: string;
  trackId: string;
  name?: string;
  trackRevision?: number;
  mapPathSha?: string;
  endSampleId?: string;
  coordinates?: [number, number][];
}): PreparedCourseContent {
  const line = input.coordinates ?? coordinates;
  const [startPosition] = line;
  const endPosition = line[line.length - 1];
  if (startPosition === undefined || endPosition === undefined)
    throw new Error('a course needs at least two vertices');
  const generation = {
    kind: 'recorded-segment',
    activityId: input.activityId,
    trackId: input.trackId,
    trackRevision: input.trackRevision ?? 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: input.endSampleId ?? '0:2',
    vertexCount: line.length,
    mapPathContentSha256: input.mapPathSha ?? 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  } as const;
  const lineage = [
    {
      activityId: input.activityId,
      trackId: input.trackId,
      trackRevision: input.trackRevision ?? 1,
    },
  ];
  const name = input.name ?? 'Seoul loop';
  return {
    name,
    coordinates: line,
    waypoints: [
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0', locked: false },
      {
        role: 'finish',
        position: endPosition,
        name: null,
        sourceSampleId: generation.endSampleId,
        locked: false,
      },
    ],
    generation,
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: hashOf(
      JSON.stringify([name, line, generation.endSampleId, lineage, input.trackRevision ?? 1]),
    ),
  };
}

/** One activity with a stored recording and one course cut from it. */
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

describe('M2-01f private course ledger', () => {
  it('creates a course with its own identity and never touches the recording', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    expect(course.course.courseId).not.toBe(imported.activityId);
    expect(course.course.headRevision).toBe(1);
    expect(course.course.visibility).toBe('private');
    expect(course.revision.lineage).toEqual([
      { activityId: imported.activityId, trackId: stored.trackId, trackRevision: 1 },
    ]);
    // The recording is exactly as it was: same activity revision, same track revision,
    // same number of source revisions and overlay revisions.
    const activity = await activities.getActivity(athlete, imported.activityId);
    expect(activity?.revision).toBe(imported.revision);
    const track = await tracks.read(athlete, imported.activityId);
    expect(track.status === 'available' && track.track.trackRevision).toBe(1);
    const counts = await database.tenant(athlete, async (tx) => ({
      sources: (
        await tx.query(
          'SELECT count(*)::int AS total FROM activity_source_revision WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0]?.['total'],
      overlays: (
        await tx.query(
          'SELECT count(*)::int AS total FROM activity_overlay_revision WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0]?.['total'],
      trackRevisions: (
        await tx.query(
          'SELECT count(*)::int AS total FROM activity_track_revision WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0]?.['total'],
    }));
    expect(counts).toEqual({ sources: 1, overlays: 0, trackRevisions: 1 });
  });

  it('appends a revision under the expected revision and never rewrites the first', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const first = course.revision;
    const renamed = await courses.update(
      athlete,
      course.course.courseId,
      1,
      {
        ...content({
          activityId: imported.activityId,
          trackId: stored.trackId,
          name: 'Renamed loop',
        }),
        edit: { kind: 'renamed' },
      },
      `course-${randomUUID()}`,
    );
    if (renamed.status !== 'available') throw new Error('expected an available course');
    expect(renamed.course.headRevision).toBe(2);
    expect(renamed.revision.name).toBe('Renamed loop');
    const original = await database.tenant(athlete, async (tx) =>
      tx.query(
        `SELECT name,geometry,content_digest,revision_id FROM course_revision
         WHERE athlete_id=$1 AND course_id=$2 AND course_revision=1`,
        [athlete, course.course.courseId],
      ),
    );
    expect(original.rows[0]?.['name']).toBe(first.name);
    expect(original.rows[0]?.['content_digest']).toBe(first.contentDigest);
    expect(original.rows[0]?.['revision_id']).toBe(first.revisionId);
  });

  it('refuses a write that expected an older revision', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      {
        ...content({ activityId: imported.activityId, trackId: stored.trackId, name: 'Second' }),
        edit: { kind: 'renamed' },
      },
      `course-${randomUUID()}`,
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        {
          ...content({ activityId: imported.activityId, trackId: stored.trackId, name: 'Third' }),
          edit: { kind: 'renamed' },
        },
        `course-${randomUUID()}`,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'COURSE_REVISION_CONFLICT' }));
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status === 'available' && read.course.headRevision).toBe(2);
  });

  it('lets only one of two concurrent edits claim the next revision', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const attempt = (name: string) =>
      courses.update(
        athlete,
        course.course.courseId,
        1,
        {
          ...content({ activityId: imported.activityId, trackId: stored.trackId, name }),
          edit: { kind: 'renamed' },
        },
        `course-${randomUUID()}`,
      );
    const outcomes = await Promise.allSettled([attempt('Left'), attempt('Right')]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(CourseStateError);
    const revisions = await database.tenant(athlete, async (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM course_revision WHERE athlete_id=$1 AND course_id=$2',
        [athlete, course.course.courseId],
      ),
    );
    expect(revisions.rows[0]?.['total']).toBe(2);
  });

  it('replays a repeated write instead of creating a second version', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const edit = {
      ...content({ activityId: imported.activityId, trackId: stored.trackId, name: 'Once' }),
      edit: { kind: 'renamed' as const },
    };
    const key = `course-${randomUUID()}`;
    const first = await courses.update(athlete, course.course.courseId, 1, edit, key);
    const second = await courses.update(athlete, course.course.courseId, 1, edit, key);
    expect(second).toEqual(first);
    const revisions = await database.tenant(athlete, async (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM course_revision WHERE athlete_id=$1 AND course_id=$2',
        [athlete, course.course.courseId],
      ),
    );
    expect(revisions.rows[0]?.['total']).toBe(2);
    // A different request under the same key is a conflict, not an overwrite.
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        {
          ...edit,
          name: 'Different',
          contentDigest: hashOf('different'),
        },
        key,
      ),
    ).rejects.toBeInstanceOf(PersistenceConflict);
  });

  it('keeps the head when a write would produce identical content', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const identical = {
      ...content({ activityId: imported.activityId, trackId: stored.trackId }),
      edit: { kind: 'renamed' as const },
    };
    const result = await courses.update(
      athlete,
      course.course.courseId,
      1,
      identical,
      `course-${randomUUID()}`,
    );
    if (result.status !== 'available') throw new Error('expected an available course');
    expect(result.course.headRevision).toBe(1);
    expect(result.revision.revisionId).toBe(course.revision.revisionId);
    const revisions = await database.tenant(athlete, async (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM course_revision WHERE athlete_id=$1 AND course_id=$2',
        [athlete, course.course.courseId],
      ),
    );
    expect(revisions.rows[0]?.['total']).toBe(1);
  });

  it('refuses to rewrite a stored revision, at the grant and at the trigger', async () => {
    const { athlete, course } = await athleteWithCourse();
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE course_revision SET name=$3 WHERE athlete_id=$1 AND course_id=$2', [
          athlete,
          course.course.courseId,
          'rewritten',
        ]),
      ),
    ).rejects.toThrowError(/permission denied|IMMUTABLE_COURSE_REVISION/);
    await expect(
      admin.query(
        `UPDATE course_revision SET name='rewritten' WHERE athlete_id=$1 AND course_id=$2`,
        [athlete, course.course.courseId],
      ),
    ).rejects.toThrowError(/IMMUTABLE_COURSE_REVISION/);
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status === 'available' && read.revision.name).toBe('Seoul loop');
  });

  it('refuses a head that skips a revision', async () => {
    const { athlete, course } = await athleteWithCourse();
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `UPDATE course SET head_revision=3,revision_id=gen_random_uuid(),updated_at=now()
           WHERE athlete_id=$1 AND course_id=$2`,
          [athlete, course.course.courseId],
        ),
      ),
    ).rejects.toThrowError(/INVALID_COURSE_TRANSITION/);
  });

  it('refuses a course derived from a deleted activity or a suppressed source', async () => {
    const { athlete, imported, stored } = await athleteWithCourse();
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    await expect(
      courses.create(
        athlete,
        content({ activityId: imported.activityId, trackId: stored.trackId, name: 'After' }),
        `course-${randomUUID()}`,
      ),
    ).rejects.toThrowError(/ACTIVITY_DELETED/);
    // Direct SQL is refused too: the guard is in the database, not only in the repository.
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `INSERT INTO course_revision_source(athlete_id,course_id,course_revision,activity_id,
             track_id,track_revision) VALUES($1,gen_random_uuid(),1,$2,$3,1)`,
          [athlete, imported.activityId, stored.trackId],
        ),
      ),
    ).rejects.toThrowError(/ACTIVITY_DELETED/);
  });

  it('reclaims every course derived from a deleted activity, copies included', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    // An independently edited copy: a different course, a different name, the same lineage.
    const copyContent = content({
      activityId: imported.activityId,
      trackId: stored.trackId,
      name: 'Independent copy',
    });
    const copy = await courses.create(
      athlete,
      {
        ...copyContent,
        edit: { kind: 'copied', copiedFromCourseId: course.course.courseId, copiedFromRevision: 1 },
      },
      `course-${randomUUID()}`,
    );
    if (copy.status !== 'available') throw new Error('copy was not created');
    // A second activity with its own course, which must survive untouched.
    const other = await athleteWithCourse('Other athlete loop');
    const unrelatedActivity = await activities.importActivity(athlete, importInput());
    const unrelatedTrack = await storeTrack(
      athlete,
      unrelatedActivity.activityId,
      unrelatedActivity.revision,
    );
    const unrelated = await courses.create(
      athlete,
      content({
        activityId: unrelatedActivity.activityId,
        trackId: unrelatedTrack.trackId,
        name: 'Another recording',
      }),
      `course-${randomUUID()}`,
    );
    if (unrelated.status !== 'available') throw new Error('unrelated course missing');

    const impact = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(impact.total).toBe(2);
    expect(impact.courses.map((entry) => entry.courseId).sort()).toEqual(
      [course.course.courseId, copy.course.courseId].sort(),
    );

    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });

    for (const reclaimed of [course.course.courseId, copy.course.courseId]) {
      const read = await courses.read(athlete, reclaimed);
      expect(read.status).toBe('unavailable');
      if (read.status !== 'unavailable') throw new Error('expected unavailable');
      expect(read.course.reason).toBe('source_activity_deleted');
      expect(JSON.stringify(read)).not.toContain('126.97');
    }
    const remaining = await database.tenant(athlete, async (tx) =>
      tx.query(
        `SELECT count(*)::int AS total FROM course_revision
         WHERE athlete_id=$1 AND course_id=ANY($2::uuid[])`,
        [athlete, [course.course.courseId, copy.course.courseId]],
      ),
    );
    expect(remaining.rows[0]?.['total']).toBe(0);
    const stillThere = await courses.read(athlete, unrelated.course.courseId);
    expect(stillThere.status).toBe('available');
    const otherAthlete = await courses.read(other.athlete, other.course.course.courseId);
    expect(otherAthlete.status).toBe('available');
    // Reclaiming courses queues no object at all: a course owns no object, and the
    // recording's objects are queued by the track ledger, which still protects live ones.
    const queued = await admin.query(
      `SELECT count(*)::int AS total FROM resource_object_cleanup
       WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
      [`private/v1/tenants/${athlete}/activities/${unrelatedActivity.activityId}/%`],
    );
    expect(queued.rows[0]?.['total']).toBe(0);
  });

  it('refuses a deletion whose confirmed course list is no longer current', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const confirmed = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(confirmed.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(confirmed.courses.map((entry) => entry.courseId)).toEqual([course.course.courseId]);
    // Another tab cuts a second course from the same recording. The Activity revision does
    // not move, so only the impact digest can express that the confirmed list is stale.
    const second = await courses.create(
      athlete,
      content({
        activityId: imported.activityId,
        trackId: stored.trackId,
        name: 'Made in another tab',
      }),
      `course-${randomUUID()}`,
    );
    expect(second.status).toBe('available');
    await expect(
      activities.deleteActivity(athlete, imported.activityId, {
        expectedRevision: imported.revision,
        expectedCourseImpact: confirmed.digest,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'COURSE_IMPACT_CHANGED' }));
    const stillThere = await activities.getActivity(athlete, imported.activityId);
    expect(stillThere?.revision).toBe(imported.revision);
    expect((await courses.read(athlete, course.course.courseId)).status).toBe('available');
    // Re-confirming against the current list succeeds and reclaims both courses.
    const refreshed = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(refreshed.total).toBe(2);
    expect(refreshed.digest).not.toBe(confirmed.digest);
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
      expectedCourseImpact: refreshed.digest,
    });
    expect((await courses.read(athlete, course.course.courseId)).status).toBe('unavailable');
  });

  it('never answers with a list and a digest from different snapshots', async () => {
    const { athlete, imported, stored } = await athleteWithCourse();
    /** The digest the database computes, recomputed here from the list it returned. */
    const digestOf = (courses: readonly { courseId: string; name: string }[]) =>
      createHash('sha256')
        .update(
          [...courses]
            .sort((left, right) => (left.courseId < right.courseId ? -1 : 1))
            .map((course) => `${course.courseId}|${course.name}`)
            .join('\n'),
          'utf8',
        )
        .digest('hex');
    // A writer cutting more courses from the same recording while the preview is read.
    // Two separate selects let the pair drift; one statement cannot.
    let writing = true;
    const writer = (async () => {
      for (let index = 0; index < 40 && writing; index += 1)
        await courses.create(
          athlete,
          content({
            activityId: imported.activityId,
            trackId: stored.trackId,
            name: `Concurrent ${index}`,
          }),
          `course-${randomUUID()}`,
        );
    })();
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const impact = await courses.affectedByActivityDeletion(athlete, imported.activityId);
        expect(impact.digest).toBe(digestOf(impact.courses));
        expect(impact.total).toBe(impact.courses.length);
      }
    } finally {
      writing = false;
      await writer;
    }
    const settled = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(settled.courses.length).toBeGreaterThan(1);
    expect(settled.digest).toBe(digestOf(settled.courses));
  });

  it('gives the same digest for the same list and a different one when a name changes', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const first = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    const again = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(again.digest).toBe(first.digest);
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      {
        ...content({ activityId: imported.activityId, trackId: stored.trackId, name: 'Renamed' }),
        edit: { kind: 'renamed' },
      },
      `course-${randomUUID()}`,
    );
    const renamed = await courses.affectedByActivityDeletion(athlete, imported.activityId);
    expect(renamed.digest).not.toBe(first.digest);
  });

  it('refuses to edit or copy a reclaimed course and keeps it out of new writes', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    expect(await courses.headContent(athlete, course.course.courseId)).toBeNull();
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        {
          ...content({ activityId: imported.activityId, trackId: stored.trackId, name: 'Nope' }),
          edit: { kind: 'renamed' },
        },
        `course-${randomUUID()}`,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'COURSE_UNAVAILABLE' }));
    const list = await courses.list(athlete);
    expect(list.courses.map((entry) => entry.status)).toEqual(['unavailable']);
  });

  it('removes a course the owner deletes and refuses a stale expectation', async () => {
    const { athlete, course } = await athleteWithCourse();
    await expect(courses.remove(athlete, course.course.courseId, 2)).rejects.toThrowError(
      expect.objectContaining({ code: 'COURSE_REVISION_CONFLICT' }),
    );
    expect(await courses.remove(athlete, course.course.courseId, 1)).toEqual({ deleted: true });
    await expect(courses.read(athlete, course.course.courseId)).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    const rows = await database.tenant(athlete, async (tx) =>
      tx.query('SELECT count(*)::int AS total FROM course_revision WHERE athlete_id=$1', [athlete]),
    );
    expect(rows.rows[0]?.['total']).toBe(0);
  });

  it('keeps one tenant out of another tenant course, through RLS and the repository', async () => {
    const mine = await athleteWithCourse();
    const theirs = await athleteWithCourse();
    await expect(courses.read(theirs.athlete, mine.course.course.courseId)).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    const rows = await database.tenant(theirs.athlete, async (tx) =>
      tx.query('SELECT count(*)::int AS total FROM course WHERE course_id=$1', [
        mine.course.course.courseId,
      ]),
    );
    expect(rows.rows[0]?.['total']).toBe(0);
    expect((await courses.list(theirs.athlete)).total).toBe(1);
  });

  it('exports courses and revisions without coordinates and keeps a reclaimed head', async () => {
    const { athlete, imported, stored, course } = await athleteWithCourse();
    const secondActivity = await activities.importActivity(athlete, importInput());
    const secondTrack = await storeTrack(
      athlete,
      secondActivity.activityId,
      secondActivity.revision,
    );
    const kept = await courses.create(
      athlete,
      content({
        activityId: secondActivity.activityId,
        trackId: secondTrack.trackId,
        name: 'Kept loop',
      }),
      `course-${randomUUID()}`,
    );
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    if (exported.schemaVersion !== 20) throw new Error('expected v20');
    expect(exported.data.courses).toHaveLength(2);
    const reclaimed = exported.data.courses.find(
      (row) => row['course_id'] === course.course.courseId,
    );
    expect(reclaimed?.['status']).toBe('unavailable');
    expect(reclaimed?.['head_revision']).toBeNull();
    expect(exported.data.courseRevisions).toHaveLength(1);
    expect(exported.data.courseRevisions[0]?.['course_id']).toBe(
      kept.status === 'available' ? kept.course.courseId : '',
    );
    expect(exported.data.courseRevisions[0]?.['lineage']).toEqual([
      {
        activity_id: secondActivity.activityId,
        track_id: secondTrack.trackId,
        track_revision: 1,
      },
    ]);
    // Coordinates never leave through the export; the GPX export is the way to get them.
    expect(JSON.stringify(exported.data.courseRevisions)).not.toContain('126.97');
    expect(JSON.stringify(exported)).not.toContain(stored.mapPathSha.slice(0, 16));
  });

  it('erases every course row with the account', async () => {
    const { athlete, course } = await athleteWithCourse();
    await createOperationsRepository(database).eraseAccount(athlete);
    const rows = await admin.query(
      `SELECT (SELECT count(*)::int FROM course WHERE athlete_id=$1) AS heads,
         (SELECT count(*)::int FROM course_revision WHERE athlete_id=$1) AS revisions,
         (SELECT count(*)::int FROM course_revision_source WHERE athlete_id=$1) AS lineage`,
      [athlete],
    );
    expect(rows.rows[0]).toEqual({ heads: 0, revisions: 0, lineage: 0 });
    expect(course.course.courseId).toBeTruthy();
  });
});

/**
 * M2-01h stores what the engine computed, as a proposal, and turns it into a revision only
 * when the owner saves it. The tests below are about the seam between those two steps: one
 * computation may become at most one revision, the revision that comes out of it carries
 * the graph that answered, and nothing the reclamation and erasure rules reach can survive
 * inside a proposal.
 */
const routeComputation = (
  requestId: string,
  draftRevision: number,
  graphBuildId = '0123456789abcdef',
) => ({
  schemaVersion: 1 as const,
  requestId,
  requestRevision: draftRevision,
  graph: {
    engine: 'graphhopper' as const,
    identitySource: 'engine' as const,
    engineVersion: '10.0',
    engineArtifactSha256: 'a'.repeat(64),
    profileId: 'foot-v1' as const,
    profileConfigSha256: 'b'.repeat(64),
    extractSha256: 'c'.repeat(64),
    extractRegion: 'seoul',
    graphContentSha256: 'd'.repeat(64),
    graphBuildId,
    graphImportedAt: '2026-03-01T00:00:00.000Z',
    roadDataAt: '2026-02-01T00:00:00.000Z',
  },
  conditions: {
    profileId: 'foot-v1' as const,
    algorithm: 'flexible' as const,
    contractionHierarchies: false as const,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 2,
  },
  computedAt: '2026-03-02T00:00:00.000Z',
  computationMilliseconds: 42,
  warnings: [],
});

const routedLine: [number, number][] = [
  [126.9779, 37.5665],
  [126.9784, 37.5669],
  [126.9799, 37.5671],
];

function proposalInput(courseId: string, draftRevision = 2, graphBuildId?: string) {
  const requestId = `req-${randomUUID()}`;
  return {
    courseId,
    draftRevision,
    requestId,
    waypoints: [
      {
        role: 'start' as const,
        position: routedLine[0] as [number, number],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
      {
        role: 'finish' as const,
        position: routedLine[2] as [number, number],
        name: null,
        sourceSampleId: null,
        locked: true,
      },
    ],
    coordinates: routedLine,
    engineDistanceMeters: 210.5,
    engineDurationSeconds: 150,
    snappedWaypoints: [
      {
        requested: routedLine[0] as [number, number],
        snapped: routedLine[0] as [number, number],
        snapDistanceMeters: 0,
      },
      {
        requested: routedLine[2] as [number, number],
        snapped: routedLine[2] as [number, number],
        snapDistanceMeters: 4.5,
      },
    ],
    computation: routeComputation(requestId, draftRevision, graphBuildId),
    ttlSeconds: 1800,
  };
}

/** The revision content a reviewed proposal becomes, as the API derives it. */
function routedContent(
  head: {
    name: string;
    lineage: readonly { activityId: string; trackId: string; trackRevision: number }[];
  },
  input: ReturnType<typeof proposalInput>,
): PreparedCourseContent {
  return {
    name: head.name,
    coordinates: input.coordinates,
    waypoints: input.waypoints,
    // Built here rather than imported from the courses domain package: the repository
    // records what the application derived, and this test is about the ledger, not the
    // derivation (which `packages/server/courses/tests/routed.test.ts` covers).
    generation: {
      kind: 'routed-waypoints',
      computation: input.computation,
      engineDistanceMeters: input.engineDistanceMeters,
      engineDurationSeconds: input.engineDurationSeconds,
      maxSnapDistanceMeters: Math.max(
        ...input.snappedWaypoints.map((waypoint) => waypoint.snapDistanceMeters),
      ),
      waypointCount: input.waypoints.length,
      vertexCount: input.coordinates.length,
    },
    edit: { kind: 'rerouted' },
    lineage: head.lineage,
    distanceMeters: 211.75,
    contentDigest: hashOf(
      JSON.stringify([head.name, input.coordinates, input.computation.graph.graphBuildId]),
    ),
  };
}

describe('M2-01h route proposals', () => {
  it('stores a computed route without changing the course at all', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const stored = await courses.storeRouteProposal(athlete, proposalInput(course.course.courseId));
    expect(stored.proposalId).toBeTruthy();
    expect(stored.geometry.coordinates).toEqual(routedLine);
    // Everything the RouteComputationRecord carries survived the round trip.
    expect(stored.computation.graph.graphBuildId).toBe('0123456789abcdef');
    expect(stored.computation.graph.graphContentSha256).toBe('d'.repeat(64));
    expect(stored.computation.requestRevision).toBe(2);
    expect(stored.computation.computationMilliseconds).toBe(42);
    expect(stored.waypoints[1]?.locked).toBe(true);
    // A proposal is not a course. The head has not moved and no revision appeared.
    const after = await courses.read(athlete, course.course.courseId);
    expect(after.status === 'available' && after.course.headRevision).toBe(1);
    const revisions = await database.tenant(athlete, async (tx) =>
      Number(
        (
          await tx.query('SELECT count(*)::int AS total FROM course_revision WHERE course_id=$1', [
            course.course.courseId,
          ])
        ).rows[0]?.['total'],
      ),
    );
    expect(revisions).toBe(1);
  });

  it('turns a reviewed proposal into a revision that names the graph that answered', async () => {
    const { athlete, imported, stored: track, course } = await athleteWithCourse('Routed loop');
    const input = proposalInput(course.course.courseId);
    const proposal = await courses.storeRouteProposal(athlete, input);
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    const saved = await courses.update(
      athlete,
      course.course.courseId,
      1,
      routedContent(head, input),
      `save-${randomUUID()}`,
      { kind: 'reroute' },
      {
        consumeProposal: {
          proposalId: proposal.proposalId,
          draftRevision: proposal.draftRevision,
          geometrySha256: courseGeometrySha256(input.coordinates),
        },
      },
    );
    if (saved.status !== 'available') throw new Error('course was reclaimed');
    expect(saved.course.headRevision).toBe(2);
    expect(saved.revision.edit).toEqual({ kind: 'rerouted' });
    expect(saved.revision.generation.kind).toBe('routed-waypoints');
    if (saved.revision.generation.kind !== 'routed-waypoints') throw new Error('unreachable');
    expect(saved.revision.generation.computation.graph.graphBuildId).toBe('0123456789abcdef');
    expect(saved.revision.generation.computation.warnings).toEqual([]);
    expect(saved.revision.generation.maxSnapDistanceMeters).toBe(4.5);
    // The revision inherits the lineage of the head: rerouting is not a way out of the
    // recording a course came from, so deleting that activity still reaches this revision.
    expect(saved.revision.lineage).toEqual([
      { activityId: imported.activityId, trackId: track.trackId, trackRevision: 1 },
    ]);
    // Revision 1 is untouched, as every other edit leaves it.
    const first = await database.tenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            'SELECT generation FROM course_revision WHERE course_id=$1 AND course_revision=1',
            [course.course.courseId],
          )
        ).rows[0],
    );
    expect((first as { generation: { kind: string } }).generation.kind).toBe('recorded-segment');
  });

  it('refuses to save one reviewed computation twice', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const input = proposalInput(course.course.courseId);
    const proposal = await courses.storeRouteProposal(athlete, input);
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    const consume = {
      consumeProposal: {
        proposalId: proposal.proposalId,
        draftRevision: proposal.draftRevision,
        geometrySha256: courseGeometrySha256(input.coordinates),
      },
    };
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      routedContent(head, input),
      `save-${randomUUID()}`,
      { kind: 'reroute', attempt: 1 },
      consume,
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        2,
        { ...routedContent(head, input), name: 'Routed loop', contentDigest: hashOf('different') },
        `save-${randomUUID()}`,
        { kind: 'reroute', attempt: 2 },
        consume,
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_ALREADY_SAVED' });
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status === 'available' && read.course.headRevision).toBe(2);
  });

  it('lets only one of two concurrent saves of one proposal succeed', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const input = proposalInput(course.course.courseId);
    const proposal = await courses.storeRouteProposal(athlete, input);
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    const attempt = (key: string) =>
      courses.update(
        athlete,
        course.course.courseId,
        1,
        routedContent(head, input),
        key,
        { kind: 'reroute', key },
        {
          consumeProposal: {
            proposalId: proposal.proposalId,
            draftRevision: proposal.draftRevision,
            geometrySha256: courseGeometrySha256(input.coordinates),
          },
        },
      );
    const results = await Promise.allSettled([
      attempt(`save-a-${randomUUID()}`),
      attempt(`save-b-${randomUUID()}`),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status === 'available' && read.course.headRevision).toBe(2);
  });

  it('refuses a save whose draft moved on, and one whose geometry is not the proposed line', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const input = proposalInput(course.course.courseId, 5);
    const proposal = await courses.storeRouteProposal(athlete, input);
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        routedContent(head, input),
        `save-${randomUUID()}`,
        { kind: 'reroute', stale: true },
        {
          consumeProposal: {
            proposalId: proposal.proposalId,
            // The owner edited a waypoint after the computation came back.
            draftRevision: 6,
            geometrySha256: courseGeometrySha256(input.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_STALE_DRAFT' });
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        { ...routedContent(head, input), coordinates: coordinates },
        `save-${randomUUID()}`,
        { kind: 'reroute', substituted: true },
        {
          consumeProposal: {
            proposalId: proposal.proposalId,
            draftRevision: proposal.draftRevision,
            geometrySha256: courseGeometrySha256(coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_CONTENT_MISMATCH' });
    const read = await courses.read(athlete, course.course.courseId);
    expect(read.status === 'available' && read.course.headRevision).toBe(1);
  });

  it('refuses an expired proposal and stops offering it', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const input = proposalInput(course.course.courseId);
    // The shortest life the contract allows, then waited out. The expiry cannot be forced
    // by writing to the row: the write-once trigger refuses that, which the last test here
    // fixes in place.
    const proposal = await courses.storeRouteProposal(athlete, { ...input, ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      await courses.readRouteProposal(athlete, course.course.courseId, proposal.proposalId),
    ).toBeNull();
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        routedContent(head, input),
        `save-${randomUUID()}`,
        { kind: 'reroute', expired: true },
        {
          consumeProposal: {
            proposalId: proposal.proposalId,
            draftRevision: proposal.draftRevision,
            geometrySha256: courseGeometrySha256(input.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_EXPIRED' });
  });

  it('reclaims unsaved proposals with the activity the course came from', async () => {
    const { athlete, imported, course } = await athleteWithCourse('Routed loop');
    const other = await athleteWithCourse('Unrelated');
    const mine = await courses.storeRouteProposal(athlete, proposalInput(course.course.courseId));
    const theirs = await courses.storeRouteProposal(
      other.athlete,
      proposalInput(other.course.course.courseId),
    );
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    // The draft's waypoints and the computed line are private location data belonging to a
    // course that has just lost every coordinate it had. Leaving them would keep exactly
    // what the reclamation exists to remove, and leave a saveable route behind.
    const rows = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_proposal WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]).toEqual({ total: 0 });
    expect(mine.proposalId).toBeTruthy();
    const untouched = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_proposal WHERE athlete_id=$1',
      [other.athlete],
    );
    expect(untouched.rows[0]).toEqual({ total: 1 });
    expect(theirs.proposalId).toBeTruthy();
  });

  it('removes a proposal when its course is deleted, and with the account', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    await courses.storeRouteProposal(athlete, proposalInput(course.course.courseId));
    await courses.remove(athlete, course.course.courseId, 1);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS total FROM course_route_proposal WHERE athlete_id=$1',
          [athlete],
        )
      ).rows[0],
    ).toEqual({ total: 0 });

    const second = await athleteWithCourse('Routed loop');
    await courses.storeRouteProposal(second.athlete, proposalInput(second.course.course.courseId));
    await createOperationsRepository(database).eraseAccount(second.athlete);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS total FROM course_route_proposal WHERE athlete_id=$1',
          [second.athlete],
        )
      ).rows[0],
    ).toEqual({ total: 0 });
  });

  it('bounds how many unsaved proposals one course may hold', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    for (let index = 0; index < courseLimits.openRouteProposalsPerCourse; index += 1)
      await courses.storeRouteProposal(athlete, proposalInput(course.course.courseId, index + 1));
    await expect(
      courses.storeRouteProposal(athlete, proposalInput(course.course.courseId, 99)),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_QUOTA_EXCEEDED' });
  });

  it('refuses to compute for a reclaimed course and keeps one tenant out of another', async () => {
    const { athlete, imported, course } = await athleteWithCourse('Routed loop');
    await activities.deleteActivity(athlete, imported.activityId, {
      expectedRevision: imported.revision,
    });
    await expect(
      courses.storeRouteProposal(athlete, proposalInput(course.course.courseId)),
    ).rejects.toMatchObject({ code: 'COURSE_UNAVAILABLE' });
    const intruder = randomUUID();
    await expect(
      courses.storeRouteProposal(intruder, proposalInput(course.course.courseId)),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
  });

  it('gives the runtime role no way to rewrite or remove a proposal', async () => {
    const { athlete, course } = await athleteWithCourse('Routed loop');
    const proposal = await courses.storeRouteProposal(
      athlete,
      proposalInput(course.course.courseId),
    );
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE course_route_proposal SET draft_revision=99 WHERE proposal_id=$1', [
          proposal.proposalId,
        ]),
      ),
    ).rejects.toThrowError(/permission denied|IMMUTABLE_ROUTE_PROPOSAL/);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('DELETE FROM course_route_proposal WHERE proposal_id=$1', [proposal.proposalId]),
      ),
    ).rejects.toThrowError(/permission denied|IMMUTABLE_ROUTE_PROPOSAL/);
    // The owner's own role may not rewrite a stored proposal either.
    await expect(
      admin.query('UPDATE course_route_proposal SET geometry=$2::jsonb WHERE proposal_id=$1', [
        proposal.proposalId,
        JSON.stringify({ type: 'LineString', coordinates }),
      ]),
    ).rejects.toThrowError(/IMMUTABLE_ROUTE_PROPOSAL/);
  });
});

const candidateLine: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5672],
  [126.9769, 37.5672],
  [126.9779, 37.5665],
];

const candidateEvaluation = {
  evaluationVersion: 1 as const,
  targetDistanceMeters: 5_000,
  engineDistanceMeters: 4_800,
  plannedLineMeters: 4_790,
  distanceErrorMeters: -200,
  distanceErrorRatio: -0.04,
  loop: { closed: true, gapMeters: 0 },
  connectivity: 'engine-attested-edges' as const,
  repetition: { repeatedMeters: 0, repeatedRatio: 0, outAndBack: false },
  knowledge: {
    stairs: 'unknown' as const,
    surface: 'unknown' as const,
    nightAccess: 'unknown' as const,
    accessRestrictions: 'unknown' as const,
    gradient: 'unknown' as const,
  },
  gradientSource: 'none' as const,
  maxSnapDistanceMeters: 4.5,
  waypointCount: 3,
  vertexCount: candidateLine.length,
};

const candidateWaypoints = [
  {
    role: 'start' as const,
    position: candidateLine[0] as [number, number],
    name: null,
    sourceSampleId: null,
    locked: false,
  },
  {
    role: 'via' as const,
    position: candidateLine[1] as [number, number],
    name: null,
    sourceSampleId: null,
    locked: false,
  },
  {
    role: 'finish' as const,
    position: candidateLine[0] as [number, number],
    name: null,
    sourceSampleId: null,
    locked: false,
  },
];

function candidateSetInput(
  courseId: string,
  options: {
    draftRevision?: number;
    count?: number;
    ttlSeconds?: number;
    graphBuildId?: string;
    searchSeed?: string;
  } = {},
) {
  const draftRevision = options.draftRevision ?? 2;
  const count = options.count ?? 2;
  return {
    courseId,
    draftRevision,
    requestId: `req-${randomUUID()}`,
    targetDistanceMeters: 5_000,
    searchSeed: options.searchSeed ?? 'feedfacefeedface',
    ttlSeconds: options.ttlSeconds ?? 1800,
    bounds: {
      maxCandidates: 4,
      maxAttempts: 8,
      searchBudgetMilliseconds: 30_000,
      maxSearchRadiusMeters: 2_500,
      distanceToleranceRatio: 0.25,
    },
    search: {
      attemptsMade: count,
      elapsedMilliseconds: 120,
      duplicatesDropped: 0,
      attempts: Array.from({ length: count }, (_, index) => ({
        attemptIndex: index,
        candidateSeed: `${index}`.repeat(16).slice(0, 16),
        requestedRadiusMeters: 962,
        outcome: 'accepted' as const,
        engineDistanceMeters: 4_800,
      })),
      stoppedBecause: 'candidate_limit' as const,
    },
    candidates: Array.from({ length: count }, (_, ordinal) => {
      const requestId = `req-${randomUUID()}`;
      // Each candidate is a different line, as two candidates of one search must be.
      const coordinates = candidateLine.map(
        ([longitude, latitude]) => [longitude + ordinal * 0.0005, latitude] as [number, number],
      );
      return {
        ordinal,
        attemptIndex: ordinal,
        candidateSeed: `${ordinal}`.repeat(16).slice(0, 16),
        waypoints: candidateWaypoints.map((waypoint, index) => ({
          ...waypoint,
          position: (index === 1 ? coordinates[1] : coordinates[0]) as [number, number],
        })),
        coordinates,
        engineDistanceMeters: 4_800,
        engineDurationSeconds: 3_600,
        snappedWaypoints: [0, 1, 0].map((index) => ({
          requested: coordinates[index] as [number, number],
          snapped: coordinates[index] as [number, number],
          snapDistanceMeters: 4.5,
        })),
        computation: {
          ...routeComputation(requestId, draftRevision, options.graphBuildId),
          conditions: {
            ...routeComputation(requestId, draftRevision).conditions,
            waypointCount: 3,
          },
        },
        evaluation: candidateEvaluation,
      };
    }),
  };
}

/** The revision content a picked candidate becomes, as the API derives it. */
function candidateContent(
  head: {
    name: string;
    lineage: readonly { activityId: string; trackId: string; trackRevision: number }[];
  },
  set: { targetDistanceMeters: number; searchSeed: string },
  candidate: ReturnType<typeof candidateSetInput>['candidates'][number],
): PreparedCourseContent {
  return {
    name: head.name,
    coordinates: candidate.coordinates,
    waypoints: candidate.waypoints,
    generation: {
      kind: 'target-distance-loop',
      computation: candidate.computation,
      engineDistanceMeters: candidate.engineDistanceMeters,
      engineDurationSeconds: candidate.engineDurationSeconds,
      maxSnapDistanceMeters: 4.5,
      waypointCount: candidate.waypoints.length,
      vertexCount: candidate.coordinates.length,
      targetDistanceMeters: set.targetDistanceMeters,
      searchSeed: set.searchSeed,
      candidateSeed: candidate.candidateSeed,
      attemptIndex: candidate.attemptIndex,
      generatorVersion: 'target-distance-loop-v1',
      evaluation: { ...candidateEvaluation, vertexCount: candidate.coordinates.length },
    },
    edit: { kind: 'generated' },
    lineage: head.lineage,
    distanceMeters: 4_790,
    contentDigest: hashOf(
      JSON.stringify([head.name, candidate.coordinates, candidate.candidateSeed]),
    ),
  };
}

describe('M2-01i target-distance candidates', () => {
  it('stores a whole search without changing the course at all', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const stored = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId),
    );
    expect(stored.candidates).toHaveLength(2);
    expect(stored.searchSeed).toBe('feedfacefeedface');
    expect(stored.generatorVersion).toBe('target-distance-loop-v1');
    expect(stored.evaluationVersion).toBe(1);
    expect(stored.search.attemptsMade).toBe(2);
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    // Nothing about the course moved: not the head, not the number of revisions.
    expect(after.course.headRevision).toBe(1);
    const revisions = await admin.query(
      'SELECT count(*)::int AS total FROM course_revision WHERE athlete_id=$1 AND course_id=$2',
      [athlete, course.course.courseId],
    );
    expect(revisions.rows[0]?.['total']).toBe(1);
  });

  it('turns one picked candidate into a revision that names the search that made it', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const source = input.candidates[0];
    if (!first || !source) throw new Error('no candidate');
    const read = await courses.readRouteCandidate(
      athlete,
      course.course.courseId,
      stored.candidateSetId,
      first.proposalId,
    );
    expect(read?.searchSeed).toBe('feedfacefeedface');
    expect(read?.targetDistanceMeters).toBe(5_000);
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      source,
    );
    const saved = await courses.update(
      athlete,
      course.course.courseId,
      1,
      content,
      `pick-${randomUUID()}`,
      undefined,
      {
        consumeCandidate: {
          proposalId: first.proposalId,
          candidateSetId: stored.candidateSetId,
          draftRevision: 2,
          geometrySha256: courseGeometrySha256(content.coordinates),
        },
      },
    );
    if (saved.status !== 'available') throw new Error('save failed');
    expect(saved.course.headRevision).toBe(2);
    expect(saved.revision.edit).toEqual({ kind: 'generated' });
    expect(saved.revision.generation.kind).toBe('target-distance-loop');
    if (saved.revision.generation.kind === 'target-distance-loop') {
      expect(saved.revision.generation.searchSeed).toBe('feedfacefeedface');
      expect(saved.revision.generation.candidateSeed).toBe(source.candidateSeed);
      expect(saved.revision.generation.targetDistanceMeters).toBe(5_000);
      expect(saved.revision.generation.evaluation.knowledge.surface).toBe('unknown');
      expect(saved.revision.generation.computation.graph.graphBuildId).toBe('0123456789abcdef');
    }
    // The picked candidate is consumed; its sibling is untouched and still unconsumed.
    const rows = await admin.query(
      `SELECT proposal_id,consumed_at,consumed_course_revision FROM course_route_proposal
       WHERE athlete_id=$1 AND candidate_set_id=$2 ORDER BY candidate_ordinal`,
      [athlete, stored.candidateSetId],
    );
    expect(rows.rows[0]?.['consumed_at']).not.toBeNull();
    expect(rows.rows[0]?.['consumed_course_revision']).toBe(2);
    expect(rows.rows[1]?.['consumed_at']).toBeNull();
    // A spent candidate stops being offered: reading it back finds nothing to pick again.
    expect(
      await courses.readRouteCandidate(
        athlete,
        course.course.courseId,
        stored.candidateSetId,
        first.proposalId,
      ),
    ).toBeNull();
    // The siblings go with it: they were alternatives to a choice that has been made, and
    // the search itself is spent so none of them can become a second course.
    const sibling = stored.candidates[1];
    if (!sibling) throw new Error('no sibling');
    expect(
      await courses.readRouteCandidate(
        athlete,
        course.course.courseId,
        stored.candidateSetId,
        sibling.proposalId,
      ),
    ).toBeNull();
    const spentSearch = await admin.query(
      `SELECT consumed_proposal_id,consumed_course_revision FROM course_route_candidate_set
       WHERE athlete_id=$1 AND candidate_set_id=$2`,
      [athlete, stored.candidateSetId],
    );
    expect(spentSearch.rows[0]?.['consumed_proposal_id']).toBe(first.proposalId);
    expect(spentSearch.rows[0]?.['consumed_course_revision']).toBe(2);
  });

  it('refuses to save one picked candidate twice', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const source = input.candidates[0];
    if (!first || !source) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      source,
    );
    const consume = {
      proposalId: first.proposalId,
      candidateSetId: stored.candidateSetId,
      draftRevision: 2,
      geometrySha256: courseGeometrySha256(content.coordinates),
    };
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content,
      `pick-${randomUUID()}`,
      undefined,
      {
        consumeCandidate: consume,
      },
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        2,
        { ...content, contentDigest: hashOf('different') },
        `pick-${randomUUID()}`,
        undefined,
        { consumeCandidate: { ...consume, draftRevision: 2 } },
      ),
      // The search is spent before the candidate is even looked at, so this is the answer
      // rather than `ROUTE_PROPOSAL_ALREADY_SAVED`: one search, one revision. The
      // candidate row is marked consumed too, which the sibling test above relies on.
    ).rejects.toMatchObject({ code: 'ROUTE_CANDIDATE_ALREADY_CHOSEN' });
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(2);
    const consumedRow = await admin.query(
      `SELECT consumed_at FROM course_route_proposal WHERE athlete_id=$1 AND proposal_id=$2`,
      [athlete, first.proposalId],
    );
    expect(consumedRow.rows[0]?.['consumed_at']).not.toBeNull();
  });

  it('refuses a candidate that belongs to a different search', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const other = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId, { count: 1 }),
    );
    const first = stored.candidates[0];
    const source = input.candidates[0];
    if (!first || !source) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      source,
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: {
            proposalId: first.proposalId,
            candidateSetId: other.candidateSetId,
            draftRevision: 2,
            geometrySha256: courseGeometrySha256(content.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_CANDIDATE_SET_MISMATCH' });
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(1);
  });

  it('refuses a pick whose draft moved on, and one whose geometry is not the candidate', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const source = input.candidates[0];
    if (!first || !source) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      source,
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: {
            proposalId: first.proposalId,
            candidateSetId: stored.candidateSetId,
            draftRevision: 9,
            geometrySha256: courseGeometrySha256(content.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_STALE_DRAFT' });
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: {
            proposalId: first.proposalId,
            candidateSetId: stored.candidateSetId,
            draftRevision: 2,
            geometrySha256: 'a'.repeat(64),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_CONTENT_MISMATCH' });
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(1);
  });

  it('lets only one of two concurrent picks of one candidate succeed', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const source = input.candidates[0];
    if (!first || !source) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      source,
    );
    const consume = {
      proposalId: first.proposalId,
      candidateSetId: stored.candidateSetId,
      draftRevision: 2,
      geometrySha256: courseGeometrySha256(content.coordinates),
    };
    const settled = await Promise.allSettled([
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: consume,
        },
      ),
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: consume,
        },
      ),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(2);
  });

  it('refuses an expired search and stops offering its candidates', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const stored = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId, { ttlSeconds: 1 }),
    );
    const first = stored.candidates[0];
    const source = candidateSetInput(course.course.courseId).candidates[0];
    if (!first || !source) throw new Error('no candidate');
    // The shortest life the contract allows, then waited out. The expiry cannot be forced
    // by writing to the row: the write-once trigger refuses that even for the table owner,
    // which the immutability test below fixes in place.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      await courses.readRouteCandidate(
        athlete,
        course.course.courseId,
        stored.candidateSetId,
        first.proposalId,
      ),
    ).toBeNull();
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      { ...source, coordinates: first.geometry.coordinates as [number, number][] },
    );
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        content,
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: {
            proposalId: first.proposalId,
            candidateSetId: stored.candidateSetId,
            draftRevision: 2,
            geometrySha256: courseGeometrySha256(content.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_EXPIRED' });
  });

  it('bounds how many unsaved candidates one course may hold', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId, { count: 4 }),
    );
    await expect(
      courses.storeRouteCandidateSet(
        athlete,
        candidateSetInput(course.course.courseId, { count: 4 }),
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_QUOTA_EXCEEDED' });
  });

  it('reclaims unsaved searches with the activity the course came from', async () => {
    const mine = await athleteWithCourse('Target loop');
    const other = await athleteWithCourse('Someone else');
    await courses.storeRouteCandidateSet(
      mine.athlete,
      candidateSetInput(mine.course.course.courseId),
    );
    await courses.storeRouteCandidateSet(
      other.athlete,
      candidateSetInput(other.course.course.courseId),
    );
    await activities.deleteActivity(mine.athlete, mine.imported.activityId, {
      expectedRevision: mine.imported.revision,
    });
    const remaining = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [mine.athlete],
    );
    expect(remaining.rows[0]?.['total']).toBe(0);
    const theirs = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [other.athlete],
    );
    expect(theirs.rows[0]?.['total']).toBe(1);
    const candidates = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_proposal WHERE athlete_id=$1',
      [mine.athlete],
    );
    expect(candidates.rows[0]?.['total']).toBe(0);
  });

  it('removes a search when its course is deleted, and with the account', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    await courses.storeRouteCandidateSet(athlete, candidateSetInput(course.course.courseId));
    await courses.remove(athlete, course.course.courseId, 1);
    const afterDelete = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [athlete],
    );
    expect(afterDelete.rows[0]?.['total']).toBe(0);
    const second = await athleteWithCourse('Target loop');
    await courses.storeRouteCandidateSet(
      second.athlete,
      candidateSetInput(second.course.course.courseId),
    );
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.athlete_id', second.athlete]);
        await client.query('SELECT public.erase_account($1)', [second.athlete]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
    const afterErase = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [second.athlete],
    );
    expect(afterErase.rows[0]?.['total']).toBe(0);
  });

  it('gives the runtime role no way to rewrite or remove a search', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const stored = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId),
    );
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
        await expect(
          client.query('UPDATE course_route_candidate_set SET search_seed=$1 WHERE athlete_id=$2', [
            'aaaaaaaaaaaaaaaa',
            athlete,
          ]),
        ).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
        await expect(
          client.query('DELETE FROM course_route_candidate_set WHERE athlete_id=$1', [athlete]),
        ).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
    // Even the owner of the table cannot edit one: it is written once.
    await expect(
      admin.query(
        'UPDATE course_route_candidate_set SET search_seed=$1 WHERE candidate_set_id=$2',
        ['aaaaaaaaaaaaaaaa', stored.candidateSetId],
      ),
    ).rejects.toThrow(/IMMUTABLE_ROUTE_CANDIDATE_SET/);
  });

  it('refuses to save a second candidate from the same search', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const [first, second] = stored.candidates;
    const [firstSource, secondSource] = input.candidates;
    if (!first || !second || !firstSource || !secondSource) throw new Error('need two candidates');
    const contentFor = (source: typeof firstSource) =>
      candidateContent({ name: 'Target loop', lineage: course.revision.lineage }, stored, source);
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      contentFor(firstSource),
      `pick-${randomUUID()}`,
      undefined,
      {
        consumeCandidate: {
          proposalId: first.proposalId,
          candidateSetId: stored.candidateSetId,
          draftRevision: 2,
          geometrySha256: courseGeometrySha256(firstSource.coordinates),
        },
      },
    );
    // One search proposes several routes and the owner chooses ONE. The draft revision is
    // stored, so it cannot tell a second choice apart: the search itself has to be spent.
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        2,
        contentFor(secondSource),
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeCandidate: {
            proposalId: second.proposalId,
            candidateSetId: stored.candidateSetId,
            draftRevision: 2,
            geometrySha256: courseGeometrySha256(secondSource.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_CANDIDATE_ALREADY_CHOSEN' });
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(2);
    const consumed = await admin.query(
      `SELECT count(*)::int AS total FROM course_route_proposal
       WHERE athlete_id=$1 AND candidate_set_id=$2 AND consumed_at IS NOT NULL`,
      [athlete, stored.candidateSetId],
    );
    expect(consumed.rows[0]?.['total']).toBe(1);
    // The siblings are spent with the search: nothing is left to offer or to pick.
    expect(
      await courses.readRouteCandidate(
        athlete,
        course.course.courseId,
        stored.candidateSetId,
        second.proposalId,
      ),
    ).toBeNull();
  });

  it('frees the proposal quota once a search has been spent', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId, { count: 4 });
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const firstSource = input.candidates[0];
    if (!first || !firstSource) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      firstSource,
    );
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content,
      `pick-${randomUUID()}`,
      undefined,
      {
        consumeCandidate: {
          proposalId: first.proposalId,
          candidateSetId: stored.candidateSetId,
          draftRevision: 2,
          geometrySha256: courseGeometrySha256(content.coordinates),
        },
      },
    );
    // Three siblings are still unconsumed rows, but they can never be used: the search is
    // spent. Counting them against the quota would stop the owner searching again.
    const next = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId, { count: 4, draftRevision: 3 }),
    );
    expect(next.candidates).toHaveLength(4);
    const remaining = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [athlete],
    );
    expect(remaining.rows[0]?.['total']).toBe(1);
  });

  it('never lets a candidate be saved through the plain proposal path', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const firstSource = input.candidates[0];
    if (!first || !firstSource) throw new Error('no candidate');
    // A candidate row IS a proposal row, which is how it inherits every rule migration 035
    // established. It must not inherit the generic save with it: that path records
    // `routed-waypoints` conditions, which carry no target, no seed and no evaluation, so a
    // course saved through it could not say what search produced it.
    expect(
      await courses.readRouteProposal(athlete, course.course.courseId, first.proposalId),
    ).toBeNull();
    const head = await courses.headContent(athlete, course.course.courseId);
    if (!head) throw new Error('missing head');
    await expect(
      courses.update(
        athlete,
        course.course.courseId,
        1,
        candidateContent(
          { name: 'Target loop', lineage: course.revision.lineage },
          stored,
          firstSource,
        ),
        `pick-${randomUUID()}`,
        undefined,
        {
          consumeProposal: {
            proposalId: first.proposalId,
            draftRevision: 2,
            geometrySha256: courseGeometrySha256(firstSource.coordinates),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_PROPOSAL_IS_CANDIDATE' });
    const after = await courses.read(athlete, course.course.courseId);
    if (after.status !== 'available') throw new Error('course went away');
    expect(after.course.headRevision).toBe(1);
  });

  it('does not deadlock when a course is deleted while its searches are reaped', async () => {
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const first = stored.candidates[0];
    const firstSource = input.candidates[0];
    if (!first || !firstSource) throw new Error('no candidate');
    const content = candidateContent(
      { name: 'Target loop', lineage: course.revision.lineage },
      stored,
      firstSource,
    );
    await courses.update(
      athlete,
      course.course.courseId,
      1,
      content,
      `pick-${randomUUID()}`,
      undefined,
      {
        consumeCandidate: {
          proposalId: first.proposalId,
          candidateSetId: stored.candidateSetId,
          draftRevision: 2,
          geometrySha256: courseGeometrySha256(content.coordinates),
        },
      },
    );

    // The reaper removes a search and the cascade takes its candidates with it: search row
    // first, candidate rows second. Course deletion removes the same rows through two
    // foreign keys of its own, and nothing made it take them in that order. Two writers
    // taking two rows in opposite orders is a deadlock, and it was one: 40P01.
    //
    // `reaperSide` stands where the reaper stands after it has locked the search and before
    // the cascade reaches the candidates; `deleteSide` runs the real `delete_course`.
    const reaperSide = await admin.connect();
    const deleteRunner = new Pool({ connectionString: runtimeUrl });
    try {
      await reaperSide.query('BEGIN');
      await reaperSide.query(
        `SELECT 1 FROM course_route_candidate_set
         WHERE athlete_id=$1 AND candidate_set_id=$2 FOR UPDATE`,
        [athlete, stored.candidateSetId],
      );
      const deleteSide = await deleteRunner.connect();
      const deletion = (async () => {
        await deleteSide.query('BEGIN');
        await deleteSide.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
        await deleteSide.query('SELECT public.delete_course($1,$2)', [course.course.courseId, 2]);
        await deleteSide.query('COMMIT');
      })();
      // Give the deletion time to take whatever locks it is going to take first.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await reaperSide.query(
        'DELETE FROM course_route_proposal WHERE athlete_id=$1 AND candidate_set_id=$2',
        [athlete, stored.candidateSetId],
      );
      await reaperSide.query('COMMIT');
      await deletion;
      deleteSide.release();
    } finally {
      await reaperSide.query('ROLLBACK').catch(() => undefined);
      reaperSide.release();
      await deleteRunner.end();
    }
    const left = await admin.query(
      'SELECT count(*)::int AS total FROM course WHERE athlete_id=$1 AND course_id=$2',
      [athlete, course.course.courseId],
    );
    expect(left.rows[0]?.['total']).toBe(0);
  });

  it('erases an account without meeting the reaper head on', async () => {
    // The third writer of the same two rows. Migration 035's erasure removes every proposal
    // row first and reaches the searches afterwards through the course cascade, which is
    // candidate-then-search — the opposite of everything else. One writer going the other
    // way is all a deadlock needs.
    const { athlete, course } = await athleteWithCourse('Target loop');
    const stored = await courses.storeRouteCandidateSet(
      athlete,
      candidateSetInput(course.course.courseId),
    );
    const reaperSide = await admin.connect();
    const eraser = new Pool({ connectionString: runtimeUrl });
    try {
      await reaperSide.query('BEGIN');
      await reaperSide.query(
        `SELECT 1 FROM course_route_candidate_set
         WHERE athlete_id=$1 AND candidate_set_id=$2 FOR UPDATE`,
        [athlete, stored.candidateSetId],
      );
      const client = await eraser.connect();
      const erasure = (async () => {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
        await client.query('SELECT public.erase_account($1)', [athlete]);
        await client.query('COMMIT');
      })();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await reaperSide.query(
        'DELETE FROM course_route_proposal WHERE athlete_id=$1 AND candidate_set_id=$2',
        [athlete, stored.candidateSetId],
      );
      await reaperSide.query('COMMIT');
      await erasure;
      client.release();
    } finally {
      await reaperSide.query('ROLLBACK').catch(() => undefined);
      reaperSide.release();
      await eraser.end();
    }
    const left = await admin.query(
      `SELECT (SELECT count(*)::int FROM course WHERE athlete_id=$1) AS courses,
              (SELECT count(*)::int FROM course_route_candidate_set WHERE athlete_id=$1) AS searches`,
      [athlete],
    );
    expect(left.rows[0]?.['courses']).toBe(0);
    expect(left.rows[0]?.['searches']).toBe(0);
  });

  it('serialises course deletion with a store-and-reap holding the tenant lock', async () => {
    // The other half of the same hazard, one table further out. A store-and-reap holds the
    // tenant lock, removes a spent search, then inserts a new one — and that insert needs a
    // foreign-key share lock on the course row. Deletion used to take that course row
    // exclusively without ever asking for the tenant lock, so the two could face each other
    // across two different tables. Deletion now joins the same queue instead.
    const { athlete, course } = await athleteWithCourse('Target loop');
    const input = candidateSetInput(course.course.courseId);
    const stored = await courses.storeRouteCandidateSet(athlete, input);
    const runtime = new Pool({ connectionString: runtimeUrl });
    try {
      const writer = await runtime.connect();
      await writer.query('BEGIN');
      await writer.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      await admin.query(
        'DELETE FROM course_route_candidate_set WHERE athlete_id=$1 AND candidate_set_id=$2',
        [athlete, stored.candidateSetId],
      );
      // Deletion starts here and must wait for the tenant lock, not race ahead of it.
      const deletion = courses.remove(athlete, course.course.courseId, 1);
      const settled: string[] = [];
      void deletion.then(
        () => settled.push('deleted'),
        (error: unknown) => settled.push(String((error as Error).message)),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toEqual([]);
      await writer.query(
        `INSERT INTO course_route_candidate_set(athlete_id,candidate_set_id,course_id,
           draft_revision,request_id,target_distance_meters,search_seed,generator_version,
           evaluation_version,bounds,search,created_at,expires_at)
         VALUES($1,$2,$3,9,'req-serialise',5000,'feedfacefeedface','target-distance-loop-v1',1,
           $4::jsonb,$5::jsonb,statement_timestamp(),statement_timestamp()+interval '30 minutes')`,
        [
          athlete,
          randomUUID(),
          course.course.courseId,
          JSON.stringify(input.bounds),
          JSON.stringify(input.search),
        ],
      );
      await writer.query('COMMIT');
      writer.release();
      await expect(deletion).resolves.toEqual({ deleted: true });
    } finally {
      await runtime.end();
    }
    const left = await admin.query(
      'SELECT count(*)::int AS total FROM course_route_candidate_set WHERE athlete_id=$1',
      [athlete],
    );
    expect(left.rows[0]?.['total']).toBe(0);
  });

  it('keeps one tenant out of another tenant search', async () => {
    const mine = await athleteWithCourse('Target loop');
    const other = await athleteWithCourse('Someone else');
    const stored = await courses.storeRouteCandidateSet(
      mine.athlete,
      candidateSetInput(mine.course.course.courseId),
    );
    const first = stored.candidates[0];
    if (!first) throw new Error('no candidate');
    expect(
      await courses.readRouteCandidate(
        other.athlete,
        mine.course.course.courseId,
        stored.candidateSetId,
        first.proposalId,
      ),
    ).toBeNull();
  });
});
