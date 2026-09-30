import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCourseSharingRepository } from '../src/course-sharing.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `course_share_event_${suffix}`;
const ownerRole = `course_share_owner_${suffix}`;
const runtimeRole = `course_share_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^\d+_course_share_revoke_suppression_event\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Course share event migration is missing');

let owner: Pool;
let database: Database;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole), migrationIndex);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantCourses(urlFor(ownerRole), runtimeRole);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('course share revocation event upgrade under a plain PostgreSQL owner', () => {
  it('does not infer old revokes and records later transitions under FORCE RLS', async () => {
    const tenant = randomUUID();
    const courseId = randomUUID();
    const revisionId = randomUUID();
    const oldShare = randomUUID();
    const liveShare = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await client.query(
        `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
           revision_id,created_at,updated_at)
         VALUES($1,$2,'Synthetic course','private','available',2,$3,now(),now())`,
        [tenant, courseId, revisionId],
      );
      await client.query(
        `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
           geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
           created_at)
         VALUES($1,$2,2,$3,'Synthetic course','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
           '{}'::jsonb,2,10,$4,now())`,
        [tenant, courseId, revisionId, 'a'.repeat(64)],
      );
      for (const [shareId, state] of [
        [oldShare, 'revoked'],
        [liveShare, 'active'],
      ] as const)
        await client.query(
          `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
             token_digest,epoch,state,revoke_reason,include_names,zone_ids,snapshot,
             created_at,expires_at,revoked_at)
           VALUES($1,$2,$3,2,$4,$5,3,$6,$7,false,ARRAY[$8::uuid],
             '{"coordinates":[]}'::jsonb,now(),now()+interval '1 day',$9)`,
          [
            tenant,
            shareId,
            courseId,
            randomUUID(),
            createHash('sha256').update(shareId).digest('hex'),
            state,
            state === 'revoked' ? 'owner' : null,
            randomUUID(),
            state === 'revoked' ? new Date() : null,
          ],
        );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await migrate(urlFor(ownerRole));
    const events = () =>
      owner.query<{
        event_id: string;
        course_share_id: string;
        target_id: string;
        course_share_epoch: number;
        course_share_course_revision: number;
      }>(
        `SELECT event_id,course_share_id::text,target_id::text,course_share_epoch,
           course_share_course_revision FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='course_share_revoked'`,
        [tenant],
      );
    expect((await events()).rows).toEqual([]);
    const sharing = createCourseSharingRepository(database);
    const otherTenant = randomUUID();
    await expect(sharing.revokeShare(otherTenant, liveShare, 3)).rejects.toThrow(
      'COURSE_SHARE_NOT_FOUND',
    );
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO course_share_audit'))
                throw new Error('injected late audit failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      createCourseSharingRepository(broken).revokeShare(tenant, liveShare, 3),
    ).rejects.toThrow('injected late audit failure');
    expect((await events()).rows).toEqual([]);
    await sharing.revokeShare(tenant, liveShare, 3);
    expect((await events()).rows).toEqual([
      {
        event_id: expect.any(String),
        course_share_id: liveShare,
        target_id: courseId,
        course_share_epoch: 3,
        course_share_course_revision: 2,
      },
    ]);
    const firstEvent = (await events()).rows;
    const serialized = JSON.stringify(
      (
        await owner.query(
          `SELECT to_jsonb(e) AS value FROM restore_suppression_event e
           WHERE athlete_id=$1 AND kind='course_share_revoked'`,
          [tenant],
        )
      ).rows,
    );
    expect(serialized).not.toContain(createHash('sha256').update(liveShare).digest('hex'));
    expect(serialized).not.toContain('coordinates');
    await sharing.revokeShare(tenant, liveShare, 3);
    expect((await events()).rows).toEqual(firstEvent);
    const policy = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_suppression_event'::regclass",
    );
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await expect(
      database.tenant(tenant, (tx) => tx.query('SELECT * FROM restore_suppression_event')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,course_share_id,
           course_share_epoch,course_share_course_revision,occurred_at)
         VALUES($1,'course_share_revoked',$2,$3,NULL,2,now())`,
        [tenant, courseId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await createOperationsRepository(database).eraseAccount(tenant);
    expect((await events()).rows).toEqual(firstEvent);
    expect(
      (await owner.query('SELECT 1 FROM course_share WHERE athlete_id=$1', [tenant])).rows,
    ).toEqual([]);
  });
});
