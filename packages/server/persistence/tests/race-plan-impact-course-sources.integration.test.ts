import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import type { ActivityImport } from '@workout/contracts/activity';
import { courseContentDigest } from '@workout/server-courses/digest';
import { createActivityRepository, type ActivityRepository } from '../src/activities.js';
import {
  createActivityTrackRepository,
  type ActivityTrackRepository,
} from '../src/activity-tracks.js';
import {
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { grantActivityTracks, grantCourses, grantOperations, migrate } from '../src/migrate.js';
import { captureCourseReadSources } from '../src/race-plan-impact-course-sources.js';
import { validateCourseReadManifest } from '../src/race-plan-impact-course-manifest.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `course_sources_${suffix}`,
  ownerRole = `course_sources_owner_${suffix}`,
  runtimeRole = `course_sources_app_${suffix}`;
let owner: Pool,
  database: Database,
  courses: CourseRepository,
  tracks: ActivityTrackRepository,
  activities: ActivityRepository;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantActivityTracks(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  // Existing public activities repository producer grant, identical to courses.integration
  // and API activity-track-lifecycle fixtures. This does not grant private ledger access.
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
  );
  database = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  courses = createCourseRepository(database);
  tracks = createActivityTrackRepository(database);
  activities = createActivityRepository(database);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function account() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await owned(athlete, (c) =>
    c.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
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
  const result: PreparedCourseContent = {
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
    contentDigest: '',
  };
  return { ...result, contentDigest: courseContentDigest(result) };
}

/** Real public producer lifecycle; object bytes/storage I/O are synthetic metadata
 * only. No provider, filesystem track bytes, routing engine or external deletion. */
async function fixture() {
  const athlete = await account(),
    input = importInput(),
    imported = await activities.importActivity(athlete, input),
    stored = await storeTrack(athlete, imported.activityId, imported.revision);
  const body = content({
    activityId: imported.activityId,
    trackId: stored.trackId,
    mapPathSha: stored.mapPathSha,
  });
  const saved = await courses.create(athlete, body, randomUUID());
  if (saved.status !== 'available') throw Error('course unavailable');
  const ref = {
    courseId: saved.course.courseId,
    courseRevision: saved.revision.courseRevision,
    revisionId: saved.revision.revisionId,
  };
  return { athlete, input, imported, stored, saved, ref, body };
}
// Public repositories expose millisecond ISO dates through pg Date; the helper
// transports original SQL microsecond instants. Compare the same exact instant.
const capture = (athlete: string, ref: unknown) =>
  database.snapshotTenant
    ? database.snapshotTenant(athlete, (tx) =>
        captureCourseReadSources(tx, ref, { bytes: 0n, sources: 0 }),
      )
    : Promise.reject(Error('Snapshot transaction required'));
it('normal107 plain owner / unprivileged runtime composition reads actual recorded lineage and public metadata only', async () => {
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n,max(version)::int AS last FROM schema_migrations',
      )
    ).rows[0],
  ).toEqual({ n: 107, last: 107 });
  const f = await fixture(),
    result = await capture(f.athlete, f.ref),
    track = await tracks.read(f.athlete, f.imported.activityId);
  if (track.status !== 'available') throw Error('stored track unavailable');
  expect(result?.owned?.revision).toEqual({
    ...f.saved.revision,
    createdAt: f.saved.revision.createdAt,
  });
  expect(result?.lineageSources).toEqual([
    {
      athleteId: f.athlete,
      activity: { id: f.imported.activityId, revision: f.imported.revision, deleted: false },
      track: { ...track.track, createdAt: track.track.createdAt },
      suppression: { state: 'absent' },
    },
  ]);
  expect(
    validateCourseReadManifest({ athleteId: f.athlete, eventCourse: f.ref }, result),
  ).toMatchObject({
    status: 'validated_read_scope',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
  });
  expect(JSON.stringify(result)).not.toContain('storageRef');
  expect(
    await database.tenant(
      f.athlete,
      async (tx) =>
        (
          await tx.query(
            "SELECT has_table_privilege(current_user,'public.course_deletion','SELECT') AS private_read",
          )
        ).rows[0],
    ),
  ).toEqual({ private_read: false });
});
it('exact historical course version survives a later public renamed head', async () => {
  const f = await fixture(),
    body = { ...f.body, name: 'Later head', edit: { kind: 'renamed' as const } };
  const later = await courses.update(
    f.athlete,
    f.ref.courseId,
    1,
    { ...body, contentDigest: courseContentDigest(body) },
    randomUUID(),
  );
  if (later.status !== 'available') throw Error('later course');
  const result = await capture(f.athlete, f.ref);
  expect(result?.owned?.revision).toEqual({
    ...f.saved.revision,
    createdAt: f.saved.revision.createdAt,
  });
  expect(result?.owned?.head).toMatchObject({
    headRevision: 2,
    revisionId: later.revision.revisionId,
  });
  expect(
    validateCourseReadManifest({ athleteId: f.athlete, eventCourse: f.ref }, result).status,
  ).toBe('validated_read_scope');
});
it('foreign course and wrong requested immutable revision remain unavailable without fabricated digest', async () => {
  const f = await fixture(),
    foreign = await account();
  await expect(capture(foreign, f.ref)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await expect(capture(f.athlete, { ...f.ref, revisionId: randomUUID() })).rejects.toMatchObject({
    code: 'SOURCE_UNAVAILABLE',
  });
  await expect(capture(f.athlete, { ...f.ref, courseRevision: 2 })).rejects.toMatchObject({
    code: 'SOURCE_UNAVAILABLE',
  });
});
it('public activity deletion suppresses reimport and reclaims owned course geometry/lineage', async () => {
  const f = await fixture();
  await activities.deleteActivity(f.athlete, f.imported.activityId, {
    expectedRevision: f.imported.revision,
  });
  expect(
    (await activities.importActivity(f.athlete, { ...f.input, idempotencyKey: randomUUID() }))
      .outcome,
  ).toBe('suppressed');
  const read = await courses.read(f.athlete, f.ref.courseId);
  expect(read.status).toBe('unavailable');
  await expect(capture(f.athlete, f.ref)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  const rows = await database.tenant(f.athlete, (tx) =>
    tx.query(
      'SELECT (SELECT count(*)::int FROM course_revision WHERE athlete_id=$1 AND course_id=$2) AS bodies,(SELECT count(*)::int FROM course_revision_source WHERE athlete_id=$1 AND course_id=$2) AS lineage',
      [f.athlete, f.ref.courseId],
    ),
  );
  expect(rows.rows[0]).toEqual({ bodies: 0, lineage: 0 });
});
it('public course deletion is read through narrow existing ledger port only', async () => {
  const f = await fixture();
  expect(await courses.remove(f.athlete, f.ref.courseId, 1)).toEqual({ deleted: true });
  await expect(capture(f.athlete, f.ref)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  const deletion = await database.tenant(f.athlete, (tx) =>
    tx.query(
      'SELECT count(*)::int AS n FROM public.export_course_deletions() WHERE athlete_id=$1 AND course_id=$2',
      [f.athlete, f.ref.courseId],
    ),
  );
  expect(deletion.rows[0]).toEqual({ n: 1 });
});
it('scalar preflight exhausts shared budget before transport of geometry or lineage track bodies', async () => {
  const f = await fixture(),
    calls: string[] = [];
  await expect(
    database.snapshotTenant?.(f.athlete, async (tx) => {
      const observed: Transaction = {
        athleteId: tx.athleteId,
        query(sql, values) {
          calls.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureCourseReadSources(observed, f.ref, { bytes: 4194304n, sources: 0 });
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(calls).toHaveLength(4);
  expect(calls.some((sql) => sql.includes('AS body'))).toBe(false);
  expect(calls.some((sql) => sql.includes(' AS track,'))).toBe(false);
});
it('missing EXECUTE capability safely leaves the caller transaction usable without private fallback', async () => {
  const f = await fixture();
  await owner.query(
    `REVOKE EXECUTE ON FUNCTION public.export_course_deletions() FROM "${runtimeRole}"`,
  );
  try {
    await database.tenant(f.athlete, async (tx) => {
      await expect(
        captureCourseReadSources(tx, f.ref, { bytes: 0n, sources: 0 }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect((await tx.query('SELECT 1 AS usable')).rows[0]).toEqual({ usable: 1 });
    });
  } finally {
    await grantOperations(url(ownerRole), runtimeRole);
  }
});
it('actual failed SQL privileges are propagated to outer rollback and never converted to a successful read', async () => {
  const f = await fixture();
  await owner.query(`REVOKE SELECT ON course_revision FROM "${runtimeRole}"`);
  try {
    await expect(capture(f.athlete, f.ref)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await grantOperations(url(ownerRole), runtimeRole);
    await grantCourses(url(ownerRole), runtimeRole);
  }
  expect((await capture(f.athlete, f.ref))?.digest).toBe(f.saved.revision.contentDigest);
});

it('public course producer rejects foreign recording lineage instead of minting owned source facts', async () => {
  const foreign = await fixture(),
    athlete = await account();
  const body = content({
    activityId: foreign.imported.activityId,
    trackId: foreign.stored.trackId,
    mapPathSha: foreign.stored.mapPathSha,
  });
  await expect(courses.create(athlete, body, randomUUID())).rejects.toThrow();
  const rows = await database.tenant(athlete, (tx) =>
    tx.query('SELECT count(*)::int AS n FROM course WHERE athlete_id=$1', [athlete]),
  );
  expect(rows.rows[0]).toEqual({ n: 0 });
});
