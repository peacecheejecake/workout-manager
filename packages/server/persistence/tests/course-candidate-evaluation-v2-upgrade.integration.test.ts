import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The evaluation-v2 migration (M2-01ap) on a database every earlier migration already built,
 * holding a version-1 search and a revision written before it.
 *
 * It widens two CHECKs and must do nothing else: a search may now record evaluation version
 * 2 (and still 1, never 3), and a revision's generation may hold 8192 bytes instead of 4096.
 * Every earlier checksum, every function body and every stored row stays as it was.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `eval_v2_up_${suffix}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
let versionsBefore = 0;

const athlete = randomUUID();
const courseId = randomUUID();
const setBefore = randomUUID();
const bounds = {
  maxCandidates: 4,
  maxAttempts: 8,
  searchBudgetMilliseconds: 30_000,
  maxSearchRadiusMeters: 2_500,
  distanceToleranceRatio: 0.25,
};

async function asTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await upgraded.connect();
  try {
    await client.query('SELECT set_config($1,$2,false)', ['app.athlete_id', athlete]);
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
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

function insertSet(client: PoolClient, setId: string, evaluationVersion: number) {
  return client.query(
    `INSERT INTO course_route_candidate_set(athlete_id,candidate_set_id,course_id,
       draft_revision,request_id,target_distance_meters,search_seed,generator_version,
       evaluation_version,bounds,search,created_at,expires_at)
     VALUES($1,$2,$3,1,'req',5000,'feedfacefeedface','target-distance-loop-v1',$4,
       $5::jsonb,'{}'::jsonb,statement_timestamp(),statement_timestamp()+interval '30 minutes')`,
    [athlete, setId, courseId, evaluationVersion, JSON.stringify(bounds)],
  );
}

/** A revision whose generation serialises to about `bytes` bytes. */
function insertRevision(client: PoolClient, revision: number, bytes: number) {
  return client.query(
    `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
       geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
       created_at)
     VALUES($1,$2,$3,$4,'Evaluation v2','{}'::jsonb,'[]'::jsonb,$5::jsonb,'{}'::jsonb,2,10,
       $6,clock_timestamp())`,
    [
      athlete,
      courseId,
      revision,
      randomUUID(),
      JSON.stringify({ kind: 'padding', text: 'x'.repeat(bytes - 30) }),
      'a'.repeat(64),
    ],
  );
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
  // Found by name, not by number: renumbering at merge time must not move the starting point.
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_candidate_evaluation_v2\.sql$/.test(file),
  );
  expect(index).toBeGreaterThan(0);
  expect(migrationFileNames[index - 1]).toMatch(/^\d+_queue_state_plain_owner\.sql$/);
  versionsBefore = index;
  await migrate(upgradeUrl(), versionsBefore);
  // What was there before: a course with one revision and a version-1 search.
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
         revision_id,created_at,updated_at)
       VALUES($1,$2,'Evaluation v2','private','available',1,$3,clock_timestamp(),
         clock_timestamp())`,
      [athlete, courseId, randomUUID()],
    );
    await insertRevision(client, 1, 1_000);
    await insertSet(client, setBefore, 1);
  });
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.end();
});

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

async function functionBodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace`,
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}

async function storedRows(): Promise<unknown[]> {
  const sets = await upgraded.query(
    `SELECT candidate_set_id,evaluation_version,bounds FROM course_route_candidate_set
     WHERE candidate_set_id=$1`,
    [setBefore],
  );
  const revisions = await upgraded.query(
    `SELECT course_revision,generation,content_digest FROM course_revision
     WHERE course_id=$1 AND course_revision=1`,
    [courseId],
  );
  return [...sets.rows, ...revisions.rows];
}

describe('evaluation-v2 migration upgrade of a database built by every earlier one', () => {
  it('refuses version 2 and a 5 kB generation before, accepts them after, and changes nothing else', async () => {
    await expect(asTenant((client) => insertSet(client, randomUUID(), 2))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(asTenant((client) => insertRevision(client, 2, 5_000))).rejects.toMatchObject({
      code: '23514',
    });
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await functionBodies();
    const rowsBefore = await storedRows();
    expect(rowsBefore).toHaveLength(2);

    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    expect(await functionBodies()).toEqual(bodiesBefore);
    expect(await storedRows()).toEqual(rowsBefore);

    // Version 2 is accepted, version 1 still is, anything else is not.
    await expect(asTenant((client) => insertSet(client, randomUUID(), 2))).resolves.toBeDefined();
    await expect(asTenant((client) => insertSet(client, randomUUID(), 1))).resolves.toBeDefined();
    for (const version of [0, 3])
      await expect(
        asTenant((client) => insertSet(client, randomUUID(), version)),
      ).rejects.toMatchObject({ code: '23514' });
    // A generation up to 8192 bytes is accepted, one over it is not.
    await expect(asTenant((client) => insertRevision(client, 2, 5_000))).resolves.toBeDefined();
    await expect(asTenant((client) => insertRevision(client, 3, 9_000))).rejects.toMatchObject({
      code: '23514',
    });
  });
});
