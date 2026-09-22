import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  CourseNotFoundError,
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
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0' },
      {
        role: 'finish',
        position: endPosition,
        name: null,
        sourceSampleId: generation.endSampleId,
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
    if (exported.schemaVersion !== 19) throw new Error('expected v19');
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
