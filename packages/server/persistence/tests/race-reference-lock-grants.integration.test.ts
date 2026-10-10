import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantCorePlanning,
  grantCourses,
  grantOperations,
  grantRaces,
  migrate,
} from '../src/migrate.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const fixtureOwner = new Pool({
  connectionString: z.string().parse(process.env['TEST_DATABASE_OWNER_URL']),
});
// A dedicated login role: the shared harness runtime role may already hold the activity
// service's DML from other files, which this helper deliberately leaves alone.
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const runtime = `race_lock_app_${suffix}`;
const fixedTime = '2026-10-06T10:00:00.000Z';
let database: Database;
let repository: RaceRepository;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query(
    `CREATE ROLE ${runtime} LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  await grantOperations(adminUrl, runtime);
  await grantRaces(adminUrl, runtime);
  await grantCourses(adminUrl, runtime);
  await grantCorePlanning(adminUrl, runtime);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO ${runtime}`);
  const url = new URL(runtimeUrl);
  url.username = runtime;
  url.password = 'isolated';
  database = createDatabase({ connectionString: url.toString(), max: 4 });
  repository = createRaceRepository(database, { now: () => new Date(fixedTime) });
});
afterAll(async () => {
  await database?.close();
  await admin.query(`DROP OWNED BY ${runtime}`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${runtime}`);
  await fixtureOwner.end();
  await admin.end();
});

async function tenantLocked<T>(
  pool: Pool,
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seed(athlete: string) {
  const activityId = randomUUID(),
    courseId = randomUUID(),
    revisionId = randomUUID();
  await tenantLocked(admin, athlete, (client) =>
    client.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1) ON CONFLICT DO NOTHING",
      [athlete],
    ),
  );
  await tenantLocked(fixtureOwner, athlete, async (client) => {
    await client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, activityId, JSON.stringify({ title: 'Synthetic activity', distanceMeters: 0 })],
    );
    await client.query(
      "INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,created_at,updated_at) VALUES($1,$2,'Synthetic course','private','available',1,$3,$4,$4)",
      [athlete, courseId, revisionId, fixedTime],
    );
    await client.query(
      "INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,created_at) VALUES($1,$2,1,$3,'Synthetic course','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,2,10000,$4,$5)",
      [athlete, courseId, revisionId, 'a'.repeat(64), fixedTime],
    );
  });
  return { activityId, course: { courseId, courseRevision: 1, revisionId } };
}

async function saveReferencingRaces(athlete: string, refs: Awaited<ReturnType<typeof seed>>) {
  const event = await repository.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
      localDate: '2026-10-04',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: refs.course,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  const result = await repository.createRaceResult(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      kind: 'race-result',
      raceEventId: event.id,
      localDate: '2026-10-04',
      timezone: 'Asia/Seoul',
      source: {
        kind: 'official',
        authority: 'Synthetic authority',
        resultUrl: 'https://example.org/result',
      },
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: null,
      deviceDistanceMeters: null,
      linkedActivityId: refs.activityId,
      weatherNote: null,
    },
  });
  const best = await repository.createTrainingBest(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      kind: 'training-best',
      observedAt: '2026-10-03T08:00:00+09:00',
      source: { kind: 'activity', activityId: refs.activityId },
      basis: 'device-estimated-split',
      distanceMeters: null,
      elapsedSeconds: 0,
    },
  });
  return { event, result, best };
}

async function privileges(role: string) {
  const result = await admin.query(
    `SELECT EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(c.relacl) a
        WHERE c.oid='public.activity_canonical'::regclass AND a.grantee=r.oid
          AND a.privilege_type='UPDATE') AS activity_table_update,
      EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(c.relacl) a
        WHERE c.oid='public.course'::regclass AND a.grantee=r.oid
          AND a.privilege_type='UPDATE') AS course_table_update,
      has_column_privilege(r.oid,'public.activity_canonical','original','UPDATE') AS original,
      has_column_privilege(r.oid,'public.activity_canonical','deleted','UPDATE') AS deleted,
      has_column_privilege(r.oid,'public.activity_canonical','athlete_id','UPDATE') AS activity_lock,
      has_column_privilege(r.oid,'public.course','status','UPDATE') AS course_status,
      has_column_privilege(r.oid,'public.course','name','UPDATE') AS course_name,
      has_column_privilege(r.oid,'public.course','athlete_id','UPDATE') AS course_lock
     FROM pg_roles r WHERE r.rolname=$1`,
    [role],
  );
  return result.rows[0];
}

// M202-P1-01: the race reference lock must not hand the runtime role whole-table UPDATE.
describe('race reference row-lock grants', () => {
  it('refuses a direct original/course UPDATE while referenced race saves still succeed', async () => {
    expect(await privileges(runtime)).toEqual({
      activity_table_update: false,
      course_table_update: false,
      original: false,
      deleted: false,
      activity_lock: true,
      course_status: false,
      course_name: true,
      course_lock: true,
    });
    const athlete = randomUUID(),
      refs = await seed(athlete);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `UPDATE activity_canonical SET original='{"title":"tampered"}'::jsonb WHERE athlete_id=$1 AND id=$2`,
          [athlete, refs.activityId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE activity_canonical SET deleted=true WHERE athlete_id=$1 AND id=$2', [
          athlete,
          refs.activityId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query("UPDATE course SET status='unavailable' WHERE athlete_id=$1 AND course_id=$2", [
          athlete,
          refs.course.courseId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // The only lock column cannot move: tenant RLS pins activity_canonical, the head
    // transition trigger refuses any course update that does not advance its head.
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query("UPDATE activity_canonical SET athlete_id='other' WHERE id=$1", [refs.activityId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE course SET athlete_id=athlete_id WHERE course_id=$1', [
          refs.course.courseId,
        ]),
      ),
    ).rejects.toThrow('INVALID_COURSE_TRANSITION');

    const saved = await saveReferencingRaces(athlete, refs);
    expect(saved.event.revision).toBe(1);
    expect(saved.result.revision).toBe(1);
    expect(saved.best.revision).toBe(1);
    const activity = await tenantLocked(fixtureOwner, athlete, (client) =>
      client.query('SELECT revision,original FROM activity_canonical WHERE id=$1', [
        refs.activityId,
      ]),
    );
    expect(activity.rows).toEqual([
      { revision: 1, original: { title: 'Synthetic activity', distanceMeters: 0 } },
    ]);
  });

  it('re-running the helper atomically removes the old whole-table UPDATE and keeps column grants', async () => {
    await admin.query(`GRANT SELECT,UPDATE ON course,activity_canonical TO ${runtime}`);
    expect(await privileges(runtime)).toMatchObject({
      activity_table_update: true,
      course_table_update: true,
      original: true,
      course_status: true,
    });
    await grantRaces(adminUrl, runtime);
    expect(await privileges(runtime)).toEqual({
      activity_table_update: false,
      course_table_update: false,
      original: false,
      deleted: false,
      activity_lock: true,
      course_status: false,
      course_name: true,
      course_lock: true,
    });
    const athlete = randomUUID(),
      refs = await seed(athlete);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(`UPDATE activity_canonical SET original='{}'::jsonb WHERE id=$1`, [
          refs.activityId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await saveReferencingRaces(athlete, refs)).result.revision).toBe(1);
  });

  it('leaves an activity writer role its own activity_canonical DML grant', async () => {
    const writer = `race_lock_writer_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE ROLE ${writer} NOLOGIN`);
    try {
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical TO ${writer}`);
      await admin.query(`GRANT SELECT,UPDATE ON course TO ${writer}`);
      await grantRaces(adminUrl, writer);
      expect(await privileges(writer)).toEqual({
        activity_table_update: true,
        course_table_update: false,
        original: true,
        deleted: true,
        activity_lock: true,
        course_status: false,
        course_name: false,
        course_lock: true,
      });
    } finally {
      await admin.query(`DROP OWNED BY ${writer}`);
      await admin.query(`DROP ROLE ${writer}`);
    }
  });
});
