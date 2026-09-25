import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';

import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  createCoursePreferenceRepository,
  type CoursePreferenceRepository,
} from '../src/course-preferences.js';
import {
  CourseNotFoundError,
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantActivityTracks, grantCourses, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';

/**
 * M2-01ao: a course the owner deleted after a backup came back when that backup was restored,
 * because `delete_course` left no row a restore could replay. The deletion now writes a ledger
 * row (tenant, course id, when), arms the course's object-directory purge and makes the id
 * terminal; `replay_course_deletion` applies one ledger entry to a restored cluster, fail-closed
 * and idempotently. The end-to-end version (backup → delete → restore → replay) is the drill's.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let runtime: Pool;
let activities: ActivityRepository;
let tracks: ActivityTrackRepository;
let courses: CourseRepository;
let preferences: CoursePreferenceRepository;
let operations: OperationsRepository;

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
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
  runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
  activities = createActivityRepository(database);
  tracks = createActivityTrackRepository(database);
  courses = createCourseRepository(database);
  preferences = createCoursePreferenceRepository(database);
  operations = createOperationsRepository(database);
});

afterAll(async () => {
  await runtime?.end();
  await database?.close();
  await admin.end();
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

/** A tenant the (restored) cluster knows: it has an identity account. */
async function knownTenant(): Promise<string> {
  const account = await admin.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1)
     RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const athleteId = account.rows[0]?.athlete_id;
  if (!athleteId) throw new Error('account was not created');
  return athleteId;
}

function importInput(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Course deletion run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

/** One stored recording, through the real upload lifecycle's database half. */
async function recording(athleteId: string) {
  const imported = await activities.importActivity(athleteId, importInput());
  const reservation = await tracks.reserve(
    athleteId,
    imported.activityId,
    { expectedActivityRevision: imported.revision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const prefix = `private/v1/tenants/${athleteId}/activities/${imported.activityId}/tracks/${reservation.trackId}`;
  const artifact = (kind: string, extension: string) => {
    const sha256 = hashOf(`${kind}-${reservation.uploadId}`);
    return {
      storageRef: `${prefix}/${kind}/uploads/${reservation.uploadId}/sha256/${sha256}.${extension}`,
      sizeBytes: 1024,
      sha256,
    };
  };
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: { ...artifact('raw', 'gpx'), format: 'gpx', originalFileName: 'run.gpx' },
    normalized: artifact('normalized', 'json'),
    mapPath: artifact('map_path', 'json'),
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
  return { activityId: imported.activityId, trackId: reservation.trackId };
}

function content(activityId: string, trackId: string, name: string): PreparedCourseContent {
  const line: [number, number][] = [
    [126.9779, 37.5665],
    [126.9789, 37.5668],
    [126.9799, 37.5671],
  ];
  const lineage = [{ activityId, trackId, trackRevision: 1 }];
  return {
    name,
    coordinates: line,
    waypoints: [
      {
        role: 'start',
        position: [126.9779, 37.5665],
        name: null,
        sourceSampleId: '0:0',
        locked: false,
      },
      {
        role: 'finish',
        position: [126.9799, 37.5671],
        name: null,
        sourceSampleId: '0:2',
        locked: false,
      },
    ],
    generation: {
      kind: 'recorded-segment',
      activityId,
      trackId,
      trackRevision: 1,
      lineIndex: 0,
      segmentIndex: 0,
      startSampleId: '0:0',
      endSampleId: '0:2',
      vertexCount: line.length,
      mapPathContentSha256: 'a'.repeat(64),
      simplificationVersion: 1,
      toleranceMeters: 2.5,
    },
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: hashOf(JSON.stringify([name, line, lineage])),
  };
}

/** A course with everything the owner can hang off it: a favourite mark and a note. */
async function courseWithOwnerFacts(athleteId: string): Promise<string> {
  const source = await recording(athleteId);
  const created = await courses.create(
    athleteId,
    content(source.activityId, source.trackId, `Course ${randomUUID()}`),
    `course-${randomUUID()}`,
  );
  if (created.status !== 'available') throw new Error('course was not created');
  const courseId = created.course.courseId;
  await preferences.write(athleteId, courseId, { favourite: true });
  await preferences.writeAccessibilityNote(athleteId, courseId, {
    expectedRevision: 1,
    note: 'Ramp at the north gate',
  });
  return courseId;
}

const courseTables = [
  'course',
  'course_revision',
  'course_revision_source',
  'course_preference',
  'course_accessibility_note',
  'course_thumbnail',
  'course_route_proposal',
  'course_route_candidate_set',
] as const;

async function courseRowCounts(athleteId: string, courseId: string) {
  const counts: Record<string, number> = {};
  for (const table of courseTables) {
    const rows = await admin.query(`SELECT 1 FROM ${table} WHERE athlete_id=$1 AND course_id=$2`, [
      athleteId,
      courseId,
    ]);
    counts[table] = rows.rowCount ?? -1;
  }
  return counts;
}

const noRows = Object.fromEntries(courseTables.map((table) => [table, 0]));

async function ledgerRows(athleteId: string) {
  return (
    await admin.query<{ course_id: string; deleted_at: Date }>(
      'SELECT course_id::text,deleted_at FROM course_deletion WHERE athlete_id=$1 ORDER BY 1',
      [athleteId],
    )
  ).rows;
}

async function coursePurge(athleteId: string, courseId: string) {
  return (
    // Instants as text: microseconds, which a JavaScript Date would round away.
    (
      await admin.query<{ open: boolean; armed_at: string; available_at: string }>(
        `SELECT completed_at IS NULL AS open,armed_at::text,available_at::text
       FROM object_scope_purge
       WHERE athlete_id=$1 AND scope_kind='course' AND scope_id=$2`,
        [athleteId, courseId],
      )
    ).rows
  );
}

async function asTenant<T>(session: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [session]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** One ledger entry replayed as the restore replays it: admin, the tenant's session, one transaction. */
async function replay(
  athleteId: string,
  courseId: string,
  deletedAt: Date | null = new Date(Date.now() - 60_000),
  session = athleteId,
) {
  return asTenant(session, async (client) => {
    const result = await client.query<{ outcome: string }>(
      'SELECT public.replay_course_deletion($1,$2,$3) AS outcome',
      [athleteId, courseId, deletedAt],
    );
    return result.rows[0]?.outcome;
  });
}

describe('course deletion ledger (M2-01ao)', () => {
  it('records the owner deletion, arms the course purge and leaves nothing of the course', async () => {
    const tenant = randomUUID();
    const courseId = await courseWithOwnerFacts(tenant);
    const kept = await courseWithOwnerFacts(tenant);
    const before = new Date();
    await courses.remove(tenant, courseId, 1);

    await expect(courses.read(tenant, courseId)).rejects.toBeInstanceOf(CourseNotFoundError);
    expect(await courseRowCounts(tenant, courseId)).toEqual(noRows);
    const ledger = await ledgerRows(tenant);
    expect(ledger.map((row) => row.course_id)).toEqual([courseId]);
    expect(ledger[0]?.deleted_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(await coursePurge(tenant, courseId)).toEqual([expect.objectContaining({ open: true })]);
    // The course the owner kept is untouched: no ledger row, no purge, every row still there.
    expect((await courses.read(tenant, kept)).status).toBe('available');
    expect(await coursePurge(tenant, kept)).toEqual([]);
    // The runtime role cannot read or write the ledger directly.
    await expect(runtime.query('SELECT * FROM course_deletion')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('holds the course purge back until a render still running could no longer publish', async () => {
    const tenant = randomUUID();
    const courseId = await courseWithOwnerFacts(tenant);
    // A render that holds its lease for another half hour when the owner deletes the course.
    // Its picture row is what tells the purge when that writer's window closes, and the row
    // cascades away with the revisions — so the purge must be armed before they are deleted.
    const leased = await asTenant(tenant, (client) =>
      client.query<{ lease_until: string }>(
        `UPDATE course_thumbnail SET state='rendering',lease_owner=$3,lease_token=$4,
           lease_until=clock_timestamp()+interval '30 minutes'
         WHERE athlete_id=$1 AND course_id=$2 RETURNING lease_until::text`,
        [tenant, courseId, randomUUID(), randomUUID()],
      ),
    );
    expect(leased.rowCount).toBe(1);
    await courses.remove(tenant, courseId, 1);
    const fence = await admin.query<{ held_back: boolean }>(
      `SELECT p.available_at>=$3::timestamptz+interval '1 hour' AS held_back
       FROM object_scope_purge p
       WHERE p.athlete_id=$1 AND p.scope_kind='course' AND p.scope_id=$2`,
      [tenant, courseId, leased.rows[0]?.lease_until],
    );
    expect(fence.rows).toEqual([{ held_back: true }]);
  });

  it('never makes a deleted course id a course again', async () => {
    const tenant = randomUUID();
    const courseId = await courseWithOwnerFacts(tenant);
    await courses.remove(tenant, courseId, 1);
    await expect(
      asTenant(tenant, (client) =>
        client.query(
          `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
             revision_id,created_at,updated_at)
           VALUES($1,$2,'Back again','private','available',1,$3,now(),now())`,
          [tenant, courseId, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/COURSE_DELETION_TERMINAL/);
  });

  it('replays a deletion onto a restored course as the live deletion does, and only once', async () => {
    const tenant = await knownTenant();
    const courseId = await courseWithOwnerFacts(tenant);
    const deletedAt = new Date(Date.now() - 3_600_000);

    expect(await replay(tenant, courseId, deletedAt)).toBe('deleted');
    expect(await courseRowCounts(tenant, courseId)).toEqual(noRows);
    expect(await ledgerRows(tenant)).toEqual([{ course_id: courseId, deleted_at: deletedAt }]);
    const purge = await coursePurge(tenant, courseId);
    expect(purge).toEqual([expect.objectContaining({ open: true })]);

    // Replaying the same entry again changes nothing at all.
    expect(await replay(tenant, courseId, deletedAt)).toBe('already_applied');
    expect(await ledgerRows(tenant)).toEqual([{ course_id: courseId, deleted_at: deletedAt }]);
    expect(await coursePurge(tenant, courseId)).toEqual(purge);
    expect(await courseRowCounts(tenant, courseId)).toEqual(noRows);
  });

  it('records a deletion of a course the restored cluster never held, and arms its purge', async () => {
    const tenant = await knownTenant();
    const courseId = randomUUID();
    const deletedAt = new Date(Date.now() - 60_000);

    expect(await replay(tenant, courseId, deletedAt)).toBe('absent');
    expect(await ledgerRows(tenant)).toEqual([{ course_id: courseId, deleted_at: deletedAt }]);
    const purge = await coursePurge(tenant, courseId);
    expect(purge).toEqual([expect.objectContaining({ open: true })]);

    expect(await replay(tenant, courseId, deletedAt)).toBe('already_applied');
    expect(await coursePurge(tenant, courseId)).toEqual(purge);
  });

  it('fails closed on every entry it cannot verify, and leaves nothing behind', async () => {
    const tenant = await knownTenant();
    const other = await knownTenant();
    const foreignCourse = await courseWithOwnerFacts(other);
    const erased = await knownTenant();
    await operations.eraseAccount(erased);

    const refused = async (
      call: () => Promise<unknown>,
      code: RegExp,
      owner: string,
    ): Promise<void> => {
      await expect(call()).rejects.toThrow(code);
      expect(await ledgerRows(owner)).toEqual([]);
    };
    // Another tenant's session.
    await refused(
      () => replay(tenant, randomUUID(), undefined, other),
      /COURSE_REPLAY_TENANT_MISMATCH/,
      tenant,
    );
    // Ids that name no key prefix.
    await refused(
      () => replay(tenant.toUpperCase(), randomUUID(), undefined, tenant.toUpperCase()),
      /COURSE_REPLAY_INVALID_ID/,
      tenant.toUpperCase(),
    );
    await refused(
      () => replay(tenant, '00000000-0000-0000-0000-000000000000'),
      /COURSE_REPLAY_INVALID_ID/,
      tenant,
    );
    // No deletion time, or one in the future.
    await refused(() => replay(tenant, randomUUID(), null), /COURSE_REPLAY_INVALID_ENTRY/, tenant);
    await refused(
      () => replay(tenant, randomUUID(), new Date(Date.now() + 3_600_000)),
      /COURSE_REPLAY_INVALID_ENTRY/,
      tenant,
    );
    // A tenant the cluster does not know — what a cluster without its data looks like.
    const stranger = randomUUID();
    await refused(() => replay(stranger, randomUUID()), /COURSE_REPLAY_TENANT_UNKNOWN/, stranger);
    // An erased tenant: its erasure replay satisfies the entry, the caller counts it.
    await refused(() => replay(erased, randomUUID()), /COURSE_REPLAY_TENANT_ERASED/, erased);
    // A course id another tenant holds.
    await refused(() => replay(tenant, foreignCourse), /COURSE_REPLAY_FOREIGN_COURSE/, tenant);
    expect((await courses.read(other, foreignCourse)).status).toBe('available');

    // One bad entry rolls back the good ones before it in the same transaction.
    const good = await courseWithOwnerFacts(tenant);
    await expect(
      asTenant(tenant, async (client) => {
        await client.query('SELECT public.replay_course_deletion($1,$2,now())', [tenant, good]);
        await client.query('SELECT public.replay_course_deletion($1,$2,now())', [
          tenant,
          foreignCourse,
        ]);
      }),
    ).rejects.toThrow(/COURSE_REPLAY_FOREIGN_COURSE/);
    expect((await courses.read(tenant, good)).status).toBe('available');
    expect(await ledgerRows(tenant)).toEqual([]);
  });

  it('is not granted to the runtime role', async () => {
    const privileges = await admin.query(
      `SELECT
         has_function_privilege('workout_runtime',
           'public.replay_course_deletion(text,uuid,timestamptz)','EXECUTE') AS replay,
         has_function_privilege('workout_runtime',
           'public.apply_course_deletion(text,uuid,timestamptz)','EXECUTE') AS apply,
         has_function_privilege('workout_runtime','public.delete_course(uuid,integer)',
           'EXECUTE') AS delete_course,
         has_table_privilege('workout_runtime','course_deletion','SELECT') AS read_ledger`,
    );
    expect(privileges.rows[0]).toEqual({
      replay: false,
      apply: false,
      delete_course: true,
      read_ledger: false,
    });
  });

  it('erasure removes the tenant ledger rows with the account', async () => {
    const tenant = randomUUID();
    const courseId = await courseWithOwnerFacts(tenant);
    await courses.remove(tenant, courseId, 1);
    expect(await ledgerRows(tenant)).toHaveLength(1);
    // The link this migration wraps is 048's Garmin one: the same erasure must still reach it.
    await asTenant(tenant, (client) =>
      client.query(
        `INSERT INTO garmin_unofficial_connection(athlete_id,state,profile_hash)
         VALUES($1,'reconnect_required',$2)`,
        [tenant, 'a'.repeat(64)],
      ),
    );
    await operations.eraseAccount(tenant);
    expect(await ledgerRows(tenant)).toEqual([]);
    const garmin = await admin.query(
      'SELECT 1 FROM garmin_unofficial_connection WHERE athlete_id=$1',
      [tenant],
    );
    expect(garmin.rowCount).toBe(0);
  });
});
