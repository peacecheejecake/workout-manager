import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { courseLimits } from '@workout/contracts/courses';

import { CourseStateError } from '../src/courses.js';
import {
  CoursePreferenceError,
  createCoursePreferenceRepository,
  PrivacyZoneStateError,
  type CoursePreferenceRepository,
} from '../src/course-preferences.js';
import {
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../src/courses.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCourses, grantOperations, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';

/**
 * Per-owner preferences and protected areas against real PostgreSQL (M2-01j).
 *
 * The facts worth a real database are the ones a repository test cannot fake: row-level
 * security between tenants, the grant that makes the allowlist a privilege rather than a
 * convention, the foreign key that stops a preference outliving its course, and erasure.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let courses: CourseRepository;
let preferences: CoursePreferenceRepository;
let operations: ReturnType<typeof createOperationsRepository>;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  // The tenant transaction reads `tenant_erasure` before it touches anything else, so this
  // file grants what it needs itself rather than depending on another file having run
  // first — the suite does not promise an order.
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  courses = createCourseRepository(database);
  preferences = createCoursePreferenceRepository(database);
  operations = createOperationsRepository(database);
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A stand-in for the domain's area-set identity.
 *
 * What is under test here is the **guard** — that the set is read again inside the writing
 * transaction and compared — not the digest itself, which is a domain rule with its own
 * unit tests (and which deliberately covers ids and radii but never a centre). Using a
 * local function keeps this package free of a dependency on the domain package.
 */
const zoneSetDigest = (zones: readonly { zoneId: string; radiusMeters: number }[]) =>
  hashOf(
    zones
      .map((zone) => `${zone.zoneId}:${zone.radiusMeters}`)
      .sort()
      .join('|'),
  );

/**
 * An imported course: it names no recording, which is the one case where a course has no
 * lineage at all. That also keeps this file independent of the activity fixtures.
 */
function importedContent(name = '가져온 코스'): PreparedCourseContent {
  const start: [number, number] = [127.02, 37.5];
  const finish: [number, number] = [127.03, 37.51];
  const coordinates: [number, number][] = [start, finish];
  const generation = {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: 'gpx-rte',
    itemIndex: 0,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    fileSha256: 'a'.repeat(64),
    fileByteLength: 320,
    originalFilename: 'course.gpx',
    fileCreator: 'workout-manager/course-v1',
    vertexCount: 2,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 0,
  } as const;
  return {
    name,
    coordinates,
    waypoints: [
      { role: 'start', position: start, name: null, sourceSampleId: null, locked: false },
      { role: 'finish', position: finish, name: null, sourceSampleId: null, locked: false },
    ],
    generation,
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 1_400,
    contentDigest: hashOf(JSON.stringify([name, coordinates, generation.fileSha256])),
  };
}

async function athleteWithImportedCourse(name = '가져온 코스') {
  const athlete = randomUUID();
  const created = await courses.create(athlete, importedContent(name), `import-${randomUUID()}`);
  if (created.status !== 'available') throw new Error('course was not created');
  return { athlete, courseId: created.course.courseId, head: created };
}

describe('M2-01j course preferences', () => {
  it('stores an imported course with no recording lineage at all', async () => {
    const { head } = await athleteWithImportedCourse();
    expect(head.status).toBe('available');
    if (head.status !== 'available') throw new Error('unreachable');
    expect(head.revision.lineage).toEqual([]);
    expect(head.revision.generation.kind).toBe('imported-file');
    expect(head.revision.edit).toEqual({ kind: 'imported' });
  });

  it('writes only a favourite mark and a use, each on its own', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    expect(await preferences.list(athlete)).toEqual({ preferences: [], total: 0 });
    const favourite = await preferences.write(athlete, courseId, { favourite: true });
    expect(favourite).toMatchObject({ courseId, favourite: true, lastUsedAt: null });
    const used = await preferences.write(athlete, courseId, { markUsed: true });
    // Marking a use leaves the favourite alone, and the moment comes from the database.
    expect(used.favourite).toBe(true);
    expect(used.lastUsedAt).not.toBeNull();
    const cleared = await preferences.write(athlete, courseId, { favourite: false });
    expect(cleared.favourite).toBe(false);
    expect(cleared.lastUsedAt).toBe(used.lastUsedAt);
  });

  it('never appends a revision or moves the head', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true, markUsed: true });
    const read = await courses.read(athlete, courseId);
    expect(read.status).toBe('available');
    if (read.status !== 'available') throw new Error('unreachable');
    expect(read.course.headRevision).toBe(1);
    const rows = await admin.query(
      'SELECT count(*)::integer AS total FROM course_revision WHERE athlete_id=$1',
      [athlete],
    );
    expect(rows.rows[0]?.['total']).toBe(1);
  });

  it('refuses a preference for a course that is not the owner', async () => {
    const mine = await athleteWithImportedCourse();
    const theirs = await athleteWithImportedCourse('다른 사람 코스');
    await expect(
      preferences.write(mine.athlete, theirs.courseId, { favourite: true }),
    ).rejects.toBeInstanceOf(CoursePreferenceError);
    expect(await preferences.list(theirs.athlete)).toEqual({ preferences: [], total: 0 });
  });

  it('keeps one tenant out of another tenant preferences, through RLS', async () => {
    const mine = await athleteWithImportedCourse();
    const theirs = await athleteWithImportedCourse('다른 사람 코스');
    await preferences.write(mine.athlete, mine.courseId, { favourite: true });
    const seen = await preferences.list(theirs.athlete);
    expect(seen.preferences).toEqual([]);
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', theirs.athlete]);
      const rows = await runtime.query('SELECT athlete_id FROM course_preference');
      expect(rows.rows.map((row) => row['athlete_id'])).toEqual([]);
      await runtime.query('COMMIT');
    } finally {
      await runtime.end();
    }
  });

  it('takes the preference with the course it is about', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true });
    await courses.remove(athlete, courseId, 1);
    expect(await preferences.list(athlete)).toEqual({ preferences: [], total: 0 });
  });

  it('gives the runtime role no way to write anything but the two allowlisted columns', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      await expect(
        runtime.query('UPDATE course_preference SET created_at=now() WHERE athlete_id=$1', [
          athlete,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        runtime.query('DELETE FROM course_preference WHERE athlete_id=$1', [athlete]),
      ).rejects.toThrow(/permission denied/i);
      await runtime.query('ROLLBACK');
    } finally {
      await runtime.end();
    }
  });

  /**
   * The protected-area grant is add and remove, and nothing else.
   *
   * There is no path in the product that moves, renames or resizes an area, so there is no
   * UPDATE. That matters beyond least privilege: `privacyZoneSetDigest` covers ids and
   * radii but **not centres**, so a moved centre would leave an acknowledged set matching
   * and slip past the trim guard. A grant for a path nobody wrote is how that would arrive
   * unnoticed.
   */
  it('gives the runtime role no way to move, rename or resize a protected area', async () => {
    const { athlete } = await athleteWithImportedCourse();
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      for (const column of ['center_longitude=0', 'center_latitude=0', 'radius_meters=5000'])
        await expect(
          runtime.query(`UPDATE course_privacy_zone SET ${column} WHERE athlete_id=$1`, [athlete]),
        ).rejects.toThrow(/permission denied/i);
      await expect(
        runtime.query('UPDATE course_privacy_zone SET name=$2 WHERE athlete_id=$1', [
          athlete,
          '다른 이름',
        ]),
      ).rejects.toThrow(/permission denied/i);
      await runtime.query('ROLLBACK');
    } finally {
      await runtime.end();
    }
    // Add and remove still work: this is a narrowed grant, not a removed feature.
    expect(await preferences.listPrivacyZones(athlete)).toHaveLength(1);
  });
});

describe('M2-01j account export v21', () => {
  it('exports the owner preferences and protected areas, centre included', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true, markUsed: true });
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.0212345, 37.5054321],
      radiusMeters: 350,
    });
    const artifact = await operations.exportAccount(athlete);
    expect(artifact.schemaVersion).toBe(22);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.coursePreferences).toHaveLength(1);
    expect(artifact.data.coursePreferences[0]).toMatchObject({
      course_id: courseId,
      favourite: true,
    });
    expect(artifact.data.coursePreferences[0]?.['last_used_at']).toBeTruthy();
    expect(artifact.data.coursePrivacyZones).toHaveLength(1);
    // The centre is here on purpose: it is the owner's own datum, and an export without
    // it cannot restore what they had. Everything else about protected areas stays out of
    // derived records (a revision's conditions carry ids and radii only).
    expect(artifact.data.coursePrivacyZones[0]).toMatchObject({
      name: '집',
      center_longitude: 127.0212345,
      center_latitude: 37.5054321,
      radius_meters: 350,
    });
  });

  it('exports nothing of another tenant preferences or areas', async () => {
    const mine = await athleteWithImportedCourse();
    const theirs = await athleteWithImportedCourse('다른 사람 코스');
    await preferences.write(theirs.athlete, theirs.courseId, { favourite: true });
    await preferences.createPrivacyZone(theirs.athlete, {
      name: '남의 집',
      center: [126.5, 37.1],
      radiusMeters: 500,
    });
    const artifact = await operations.exportAccount(mine.athlete);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.coursePreferences).toEqual([]);
    expect(artifact.data.coursePrivacyZones).toEqual([]);
    expect(JSON.stringify(artifact)).not.toContain('남의 집');
  });

  /**
   * One export, one snapshot — stated so that a different answer could fail it.
   *
   * The previous version raced a protected-area removal and accepted "zero areas or one",
   * which is every possible outcome: it passed whether the collections came from one
   * snapshot or from several. So the race is now against a **course deletion**, which one
   * transaction removes from three export collections at once. Whichever side of it the
   * export landed on, the three have to say the same thing; an artifact that reported a
   * favourite for a course the same artifact says does not exist is exactly what reading
   * collection by collection produces.
   */
  it('answers from one snapshot when a course is deleted while the export runs', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true });
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const [artifact] = await Promise.all([
      operations.exportAccount(athlete),
      courses.remove(athlete, courseId, 1),
    ]);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    const has = (rows: readonly Record<string, unknown>[]) =>
      rows.some((row) => row['course_id'] === courseId);
    const present = has(artifact.data.courses);
    expect(has(artifact.data.coursePreferences)).toBe(present);
    expect(has(artifact.data.courseRevisions)).toBe(present);
    // A protected area belongs to no course, so the deletion cannot have touched it.
    expect(artifact.data.coursePrivacyZones).toHaveLength(1);
    // Whatever the export saw, the deletion stands afterwards.
    expect(await preferences.list(athlete)).toEqual({ preferences: [], total: 0 });
  });

  /**
   * And the property the race rests on, pinned directly: every collection of the export is
   * read by ONE statement. At READ COMMITTED a statement is a snapshot and two statements
   * are two, so this is the difference between "consistent because of the SQL" and
   * "consistent because nothing happened to be writing".
   */
  it('reads every course collection of the export in a single statement', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true });
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const statements: string[] = [];
    const recording: Database = {
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              statements.push(sql);
              return tx.query(sql, values);
            },
          }),
        ),
      exclusiveTenant: (id, operation) => database.exclusiveTenant(id, operation),
      close: () => Promise.resolve(),
    };
    const artifact = await createOperationsRepository(recording).exportAccount(athlete);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.coursePreferences).toHaveLength(1);
    expect(artifact.data.coursePrivacyZones).toHaveLength(1);
    const tables = ['course_preference', 'course_privacy_zone', 'course_revision', 'FROM course '];
    const reading = statements.filter((sql) => tables.some((table) => sql.includes(table)));
    expect(reading).toHaveLength(1);
    for (const table of tables) expect(reading[0]).toContain(table);
  });

  /**
   * Erasure takes the account lock before it takes a row, not after.
   *
   * `erase_account` is granted to the runtime role, so a direct call is part of the
   * surface this has to be safe on — `operations.eraseAccount` happening to take the
   * exclusive lock in the application first is not a defence. Before migration 037 took
   * the lock itself, this deleted the protected areas, then waited for the account lock an
   * ordinary transaction was holding shared, while that transaction took the tenant lock
   * and waited for the row erasure was sitting on: `40P01 deadlock detected`, observed.
   */
  it('erases without deadlocking against a protected-area removal holding the account', async () => {
    const { athlete } = await athleteWithImportedCourse();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const zoneId = zones[0]?.zoneId ?? '';
    let erase: Promise<unknown> = Promise.resolve();
    await database.tenant(athlete, async (tx) => {
      // This transaction already holds the account lock SHARED, which is what
      // `database.tenant` takes before anything else.
      erase = database.tenant(athlete, (inner) =>
        inner.query('SELECT public.erase_account($1)', [athlete]),
      );
      // Long enough for the erasure to reach its first lock or its first DELETE.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      await tx.query('DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2', [
        athlete,
        zoneId,
      ]);
    });
    // Neither side may be the loser of a deadlock.
    await expect(erase).resolves.toBeDefined();
  });

  /**
   * A preference write and a course deletion are one queue, not two.
   *
   * `write()` checks that the course exists and then inserts against a foreign key that
   * points at it. Without the tenant lock those are two decisions: a deletion committing
   * in between turns the promised `COURSE_NOT_FOUND` into a raw foreign-key violation,
   * which reaches the route as an unexpected error rather than as "there is no such
   * course". Observed in 198 of 200 rounds of the two racing; this pins it without a race
   * by holding the lock the deletion holds and deleting inside it.
   */
  it('answers a preference write for a course being deleted with a missing course', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    let write: Promise<unknown> = Promise.resolve();
    const order: string[] = [];
    await database.tenant(athlete, async (tx) => {
      // What `courses.remove` does: the tenant advisory lock, then the deletion.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      write = preferences
        .write(athlete, courseId, { favourite: true })
        .then(() => order.push('written'))
        .catch((error: unknown) => {
          order.push(error instanceof CoursePreferenceError ? 'missing-course' : 'raw-error');
          return error;
        });
      // Long enough for an unlocked write to read the course and reach its insert.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(order).toEqual([]);
      await tx.query('SELECT public.delete_course($1,$2) AS deleted', [courseId, 1]);
    });
    await write;
    // Not a foreign-key violation, and not a preference for a course that is gone.
    expect(order).toEqual(['missing-course']);
    expect(await preferences.list(athlete)).toEqual({ preferences: [], total: 0 });
  });

  it('carries no preference row for a course that has been deleted', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true });
    await courses.remove(athlete, courseId, 1);
    const artifact = await operations.exportAccount(athlete);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.coursePreferences).toEqual([]);
  });
});

describe('M2-01j privacy trim guarded inside its own transaction', () => {
  /** The trimmed content a course write would carry. The geometry is beside the point. */
  function trimmedContent(name: string): PreparedCourseContent {
    const trimStart: [number, number] = [127.05, 37.55];
    const trimFinish: [number, number] = [127.06, 37.56];
    const coordinates: [number, number][] = [trimStart, trimFinish];
    const generation = {
      kind: 'privacy-trimmed',
      sourceRevision: 1,
      sourceGenerationKind: 'imported-file',
      sourceGraphBuildId: null,
      policyVersion: 1,
      zoneSetDigest: 'a'.repeat(64),
      appliedZoneCount: 1,
      removedVertexCount: 1,
      removedLeadingVertexCount: 1,
      removedTrailingVertexCount: 0,
      removedWaypointCount: 0,
      vertexCount: 2,
    } as const;
    return {
      name,
      coordinates,
      waypoints: [
        { role: 'start', position: trimStart, name: null, sourceSampleId: null, locked: false },
        { role: 'finish', position: trimFinish, name: null, sourceSampleId: null, locked: false },
      ],
      generation,
      edit: { kind: 'privacy-trimmed' },
      lineage: [],
      distanceMeters: 1_400,
      contentDigest: hashOf(`${name}-trimmed`),
    };
  }

  it('refuses a trim whose area set changed after the application checked it', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    // What the application saw and computed against.
    const acknowledged = zoneSetDigest(await preferences.listPrivacyZones(athlete));
    // …and an area added after that check, before the write. The application's own check
    // has already passed at this point; only the guard inside the transaction can see it.
    await preferences.createPrivacyZone(athlete, {
      name: '직장',
      center: [127.1, 37.6],
      radiusMeters: 300,
    });
    await expect(
      courses.update(
        athlete,
        courseId,
        1,
        trimmedContent('트림 시도'),
        `trim-${randomUUID()}`,
        undefined,
        { requireZoneSet: { expectedDigest: acknowledged, digestOf: zoneSetDigest } },
      ),
    ).rejects.toMatchObject({ code: 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE' });
    // Nothing was written: the course is still at revision 1 with its original name.
    const read = await courses.read(athlete, courseId);
    if (read.status !== 'available') throw new Error('unreachable');
    expect(read.course.headRevision).toBe(1);
    expect(read.revision.name).toBe('가져온 코스');
  });

  it('removing an area invalidates an acknowledged set just as adding one does', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const acknowledged = zoneSetDigest(zones);
    await preferences.removePrivacyZone(athlete, zones[0]?.zoneId ?? '');
    await expect(
      courses.update(
        athlete,
        courseId,
        1,
        trimmedContent('트림 시도 2'),
        `trim-${randomUUID()}`,
        undefined,
        { requireZoneSet: { expectedDigest: acknowledged, digestOf: zoneSetDigest } },
      ),
    ).rejects.toBeInstanceOf(CourseStateError);
  });

  /**
   * The advisory lock a removal takes, exercised as a lock rather than as a comment.
   *
   * Both tests above run the removal to completion and only then write, which the
   * repository would pass with no lock at all — reverting it failed nothing. The fact
   * worth a real database is that a removal **cannot complete** while a course write is
   * between re-reading the protected areas and storing the revision guarded against them.
   * So this test holds exactly the lock a course write holds at that point, asks for a
   * removal, and gives it every chance to finish.
   */
  it('makes a removal wait for the course write that is deciding against the set', async () => {
    const { athlete } = await athleteWithImportedCourse();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const zoneId = zones[0]?.zoneId ?? '';
    const order: string[] = [];
    let removal: Promise<unknown> = Promise.resolve();
    await database.tenant(athlete, async (tx) => {
      // What `courses.update` does first: the tenant advisory lock, then the re-read of
      // the areas the revision will be guarded against.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      const seen = await tx.query('SELECT zone_id FROM course_privacy_zone WHERE athlete_id=$1', [
        athlete,
      ]);
      expect(seen.rows).toHaveLength(1);
      removal = preferences
        .removePrivacyZone(athlete, zoneId)
        .then(() => order.push('removed'))
        .catch((error: unknown) => {
          order.push('removal-failed');
          throw error;
        });
      // Long enough for an unguarded removal to finish several times over, and well
      // inside the 3s lock timeout the tenant transaction sets.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(order).toEqual([]);
      // The set this transaction decided against is still the set it read.
      const again = await tx.query('SELECT zone_id FROM course_privacy_zone WHERE athlete_id=$1', [
        athlete,
      ]);
      expect(again.rows).toHaveLength(1);
      order.push('write-committed');
    });
    await removal;
    expect(order).toEqual(['write-committed', 'removed']);
    expect(await preferences.listPrivacyZones(athlete)).toEqual([]);
  });

  it('writes the revision when the area set is still the one that was acknowledged', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const result = await courses.update(
      athlete,
      courseId,
      1,
      trimmedContent('트림 성공'),
      `trim-${randomUUID()}`,
      undefined,
      {
        requireZoneSet: {
          expectedDigest: zoneSetDigest(zones),
          digestOf: zoneSetDigest,
        },
      },
    );
    if (result.status !== 'available') throw new Error('unreachable');
    expect(result.course.headRevision).toBe(2);
    expect(result.revision.generation.kind).toBe('privacy-trimmed');
  });
});

describe('M2-01j protected areas', () => {
  it('keeps a private centre and an identity that does not cover it', async () => {
    const athlete = randomUUID();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    expect(zones).toHaveLength(1);
    expect(zones[0]?.center).toEqual([127.02, 37.5]);
    expect(zones[0]?.radiusMeters).toBe(300);
    const again = await preferences.listPrivacyZones(athlete);
    expect(again[0]?.zoneId).toBe(zones[0]?.zoneId);
  });

  it('bounds how many areas one owner may keep', async () => {
    const athlete = randomUUID();
    for (let index = 0; index < courseLimits.privacyZonesPerTenant; index += 1)
      await preferences.createPrivacyZone(athlete, {
        name: `구역 ${index}`,
        center: [127.02 + index / 1000, 37.5],
        radiusMeters: 100,
      });
    await expect(
      preferences.createPrivacyZone(athlete, {
        name: '하나 더',
        center: [127.05, 37.5],
        radiusMeters: 100,
      }),
    ).rejects.toBeInstanceOf(PrivacyZoneStateError);
  });

  it('keeps one tenant out of another tenant areas', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await preferences.createPrivacyZone(mine, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    expect(await preferences.listPrivacyZones(theirs)).toEqual([]);
    await expect(
      preferences.removePrivacyZone(
        theirs,
        (await preferences.listPrivacyZones(mine))[0]?.zoneId ?? '',
      ),
    ).rejects.toBeInstanceOf(PrivacyZoneStateError);
    expect(await preferences.listPrivacyZones(mine)).toHaveLength(1);
  });

  it('removes one area and refuses one that is not there', async () => {
    const athlete = randomUUID();
    const zones = await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const zoneId = zones[0]?.zoneId ?? '';
    expect(await preferences.removePrivacyZone(athlete, zoneId)).toEqual([]);
    await expect(preferences.removePrivacyZone(athlete, zoneId)).rejects.toBeInstanceOf(
      PrivacyZoneStateError,
    );
  });

  it('erases every protected area and preference with the account', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.write(athlete, courseId, { favourite: true, markUsed: true });
    await preferences.createPrivacyZone(athlete, {
      name: '집',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      await runtime.query('SELECT public.erase_account($1)', [athlete]);
      await runtime.query('COMMIT');
    } finally {
      await runtime.end();
    }
    const left = await admin.query(
      `SELECT
         (SELECT count(*)::integer FROM course_preference WHERE athlete_id=$1) AS preferences,
         (SELECT count(*)::integer FROM course_privacy_zone WHERE athlete_id=$1) AS zones,
         (SELECT count(*)::integer FROM course WHERE athlete_id=$1) AS courses`,
      [athlete],
    );
    expect(left.rows[0]).toEqual({ preferences: 0, zones: 0, courses: 0 });
  });
});

/**
 * The owner's accessibility note (M2-01r, S13 "접근성 메모") against real PostgreSQL: the
 * facts a repository fake cannot show — row-level security between tenants, the grant that
 * limits what an UPDATE may touch, the foreign key that takes a note with its course,
 * erasure, the export, and that writing one is not an edit of the course.
 */
describe('M2-01r accessibility notes', () => {
  it('writes, rewrites and clears a note against the head the caller showed', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    expect(await preferences.listAccessibilityNotes(athlete)).toEqual({ notes: [], total: 0 });
    const first = await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단 12개, 난간 있음',
    });
    expect(first).toMatchObject({ courseId, note: '계단 12개, 난간 있음', writtenAtRevision: 1 });
    const second = await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '경사로 1곳',
    });
    expect(second?.note).toBe('경사로 1곳');
    expect((await preferences.listAccessibilityNotes(athlete)).notes).toEqual([second]);
    expect(
      await preferences.writeAccessibilityNote(athlete, courseId, {
        expectedRevision: 1,
        note: null,
      }),
    ).toBeNull();
    expect(await preferences.listAccessibilityNotes(athlete)).toEqual({ notes: [], total: 0 });
  });

  it('refuses a note written while looking at a head that is no longer the head', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await courses.update(
      athlete,
      courseId,
      1,
      { ...importedContent('새 이름'), edit: { kind: 'renamed' } },
      `rename-${randomUUID()}`,
    );
    await expect(
      preferences.writeAccessibilityNote(athlete, courseId, { expectedRevision: 1, note: '계단' }),
    ).rejects.toMatchObject({ code: 'COURSE_REVISION_CONFLICT' });
    const written = await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 2,
      note: '계단',
    });
    expect(written?.writtenAtRevision).toBe(2);
  });

  it('is not an edit of the course: no revision, no head move, no digest change', async () => {
    const { athlete, courseId, head } = await athleteWithImportedCourse();
    if (head.status !== 'available') throw new Error('unreachable');
    await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단',
    });
    const read = await courses.read(athlete, courseId);
    if (read.status !== 'available') throw new Error('unreachable');
    expect(read.course.headRevision).toBe(1);
    expect(read.revision.contentDigest).toBe(head.revision.contentDigest);
    expect(JSON.stringify(read)).not.toContain('계단');
  });

  it('keeps one tenant out of another tenant notes, through the repository and RLS', async () => {
    const mine = await athleteWithImportedCourse();
    const theirs = await athleteWithImportedCourse('다른 사람 코스');
    await preferences.writeAccessibilityNote(mine.athlete, mine.courseId, {
      expectedRevision: 1,
      note: '내 메모',
    });
    // Writing to someone else's course is "no such course", not a write.
    await expect(
      preferences.writeAccessibilityNote(theirs.athlete, mine.courseId, {
        expectedRevision: 1,
        note: '남의 코스에 쓰기',
      }),
    ).rejects.toBeInstanceOf(CoursePreferenceError);
    expect((await preferences.listAccessibilityNotes(theirs.athlete)).notes).toEqual([]);
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', theirs.athlete]);
      expect((await runtime.query('SELECT note FROM course_accessibility_note')).rows).toEqual([]);
      // Inserting a row for another tenant is refused by the policy's WITH CHECK.
      await expect(
        runtime.query(
          `INSERT INTO course_accessibility_note(athlete_id,course_id,note,written_at_revision,
             created_at,updated_at) VALUES($1,$2,'끼워 넣기',1,now(),now())`,
          [mine.athlete, mine.courseId],
        ),
      ).rejects.toThrow(/row-level security/i);
      await runtime.query('ROLLBACK');
    } finally {
      await runtime.end();
    }
    const policy = await admin.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='public.course_accessibility_note'::regclass`,
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('lets the runtime role update the text and its revision and nothing else', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    const other = await athleteWithImportedCourse('두 번째 코스');
    await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단',
    });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      for (const assignment of [
        `course_id='${other.courseId}'`,
        `athlete_id='${other.athlete}'`,
        'created_at=now()',
      ]) {
        await runtime.query('BEGIN');
        await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
        await expect(
          runtime.query(`UPDATE course_accessibility_note SET ${assignment} WHERE athlete_id=$1`, [
            athlete,
          ]),
        ).rejects.toThrow(/permission denied/i);
        await runtime.query('ROLLBACK');
      }
    } finally {
      await runtime.end();
    }
    expect((await preferences.listAccessibilityNotes(athlete)).notes).toMatchObject([
      { courseId, note: '계단' },
    ]);
  });

  it('refuses text the contract refuses, in the database too', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await expect(
      preferences.writeAccessibilityNote(athlete, courseId, {
        expectedRevision: 1,
        note: '<b>계단</b>',
      }),
    ).rejects.toThrow();
    // Whitespace padding is refused by the table even from a direct write.
    await expect(
      admin.query(
        `INSERT INTO course_accessibility_note(athlete_id,course_id,note,written_at_revision,
           created_at,updated_at) VALUES($1,$2,' 계단',1,now(),now())`,
        [athlete, courseId],
      ),
    ).rejects.toThrow(/check constraint/i);
    expect((await preferences.listAccessibilityNotes(athlete)).notes).toEqual([]);
  });

  it('takes the note with the course it is about', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단',
    });
    await courses.remove(athlete, courseId, 1);
    expect(await preferences.listAccessibilityNotes(athlete)).toEqual({ notes: [], total: 0 });
  });

  it('erases every note with the account', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단',
    });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.athlete_id', athlete]);
      await runtime.query('SELECT public.erase_account($1)', [athlete]);
      await runtime.query('COMMIT');
    } finally {
      await runtime.end();
    }
    const left = await admin.query(
      'SELECT count(*)::integer AS notes FROM course_accessibility_note WHERE athlete_id=$1',
      [athlete],
    );
    expect(left.rows[0]).toEqual({ notes: 0 });
  });

  /**
   * Erasure and a note write, racing on the same account. The note write takes the account
   * lock shared and then the tenant lock, like every writer; erasure takes the account lock
   * exclusive first (migration 037). Neither may lose a deadlock (40P01 has been observed
   * around `erase_account` in this repository more than once).
   */
  it('erases without deadlocking against a note write holding the account', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    let erase: Promise<unknown> = Promise.resolve();
    await database.tenant(athlete, async (tx) => {
      erase = database.tenant(athlete, (inner) =>
        inner.query('SELECT public.erase_account($1)', [athlete]),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      await tx.query(
        `INSERT INTO course_accessibility_note(athlete_id,course_id,note,written_at_revision,
           created_at,updated_at) VALUES($1,$2,'계단',1,now(),now())`,
        [athlete, courseId],
      );
    });
    await expect(erase).resolves.toBeDefined();
    const left = await admin.query(
      'SELECT count(*)::integer AS notes FROM course_accessibility_note WHERE athlete_id=$1',
      [athlete],
    );
    expect(left.rows[0]).toEqual({ notes: 0 });
  });

  it('exports the note, and nothing of another tenant, in export v22', async () => {
    const { athlete, courseId } = await athleteWithImportedCourse();
    const theirs = await athleteWithImportedCourse('다른 사람 코스');
    await preferences.writeAccessibilityNote(athlete, courseId, {
      expectedRevision: 1,
      note: '계단 12개',
    });
    await preferences.writeAccessibilityNote(theirs.athlete, theirs.courseId, {
      expectedRevision: 1,
      note: '남의 메모',
    });
    const artifact = await operations.exportAccount(athlete);
    expect(artifact.schemaVersion).toBe(22);
    if (artifact.schemaVersion !== 22) throw new Error('expected v22');
    expect(artifact.data.courseAccessibilityNotes).toEqual([
      expect.objectContaining({ course_id: courseId, note: '계단 12개', written_at_revision: 1 }),
    ]);
    expect(Object.keys(artifact.data.courseAccessibilityNotes[0] ?? {}).sort()).toEqual([
      'course_id',
      'created_at',
      'note',
      'updated_at',
      'written_at_revision',
    ]);
    expect(JSON.stringify(artifact)).not.toContain('남의 메모');
  });
});
