import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCourseSharingRepository, revokeSharesIn } from '../src/course-sharing.js';
import { createDatabase, type Database } from '../src/database.js';
import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `course_share_v2_${suffix}`;
const ownerRole = `course_share_v2_owner_${suffix}`;
const runtimeRole = `course_share_v2_rt_${suffix}`;
const migrationIndex = migrationFileNames.findIndex((file) =>
  /^090_course_share_replay_provenance\.sql$/.test(file),
);
if (migrationIndex < 0) throw new Error('Course share v2 provenance migration is missing');

let owner: Pool;
let database: Database;
const legacyTenant = randomUUID();
const legacyCourse = randomUUID();
const legacyShare = randomUUID();
const resourceCauseEvent = randomUUID();
const resourceShareEvent = randomUUID();

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function seedCourse(tenant: string, courseId: string, shareIds: readonly string[]) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const revisionId = randomUUID();
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
    for (const shareId of shareIds) {
      await client.query(
        `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
           token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
         VALUES($1,$2,$3,2,$4,$5,3,'active',false,ARRAY[$6::uuid],
           '{"coordinates":[]}'::jsonb,now(),now()+interval '1 day')`,
        [
          tenant,
          shareId,
          courseId,
          randomUUID(),
          createHash('sha256').update(shareId).digest('hex'),
          randomUUID(),
        ],
      );
    }
    await client.query('COMMIT');
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
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole), migrationIndex - 1);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantCourses(urlFor(ownerRole), runtimeRole);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 2 });
  await seedCourse(legacyTenant, legacyCourse, [legacyShare]);
  await createCourseSharingRepository(database).revokeShare(legacyTenant, legacyShare, 3);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [legacyTenant]);
    const resourceId = randomUUID();
    const occurredAt = new Date();
    await client.query(
      `INSERT INTO restore_suppression_event(event_id,athlete_id,kind,target_id,
         resource_access_revision,occurred_at)
       VALUES($1,$2,'resource_deleted',$3,3,$4)`,
      [resourceCauseEvent, legacyTenant, resourceId, occurredAt],
    );
    await client.query(
      `INSERT INTO restore_suppression_event(event_id,record_version,athlete_id,kind,
         target_id,share_id,share_granted_access_revision,
         share_revoked_access_revision,share_cause_kind,share_cause_event_id,occurred_at)
       VALUES($1,2,$2,'resource_share_revoked',$3,$4,1,3,
         'resource_deleted',$5,$6)`,
      [resourceShareEvent, legacyTenant, resourceId, randomUUID(), resourceCauseEvent, occurredAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await migrate(urlFor(ownerRole));
});

afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('future-only course-share revoke provenance under a plain owner', () => {
  it('leaves the pre-upgrade event as v1 without fabricated audit provenance', async () => {
    const result = await owner.query(
      `SELECT record_version,course_share_revoke_reason,course_share_audit_id,
         course_share_audit_occurred_at FROM restore_suppression_event
       WHERE athlete_id=$1 AND course_share_id=$2`,
      [legacyTenant, legacyShare],
    );
    expect(result.rows).toEqual([
      {
        record_version: 1,
        course_share_revoke_reason: null,
        course_share_audit_id: null,
        course_share_audit_occurred_at: null,
      },
    ]);
  });

  it('keeps an existing v2 resource-share cause valid through the upgrade', async () => {
    const result = await owner.query(
      `SELECT record_version,kind,share_cause_kind,share_cause_event_id,
         course_share_revoke_reason,course_share_audit_id,
         course_share_audit_occurred_at
       FROM restore_suppression_event WHERE event_id=$1`,
      [resourceShareEvent],
    );
    expect(result.rows).toEqual([
      {
        record_version: 2,
        kind: 'resource_share_revoked',
        share_cause_kind: 'resource_deleted',
        share_cause_event_id: resourceCauseEvent,
        course_share_revoke_reason: null,
        course_share_audit_id: null,
        course_share_audit_occurred_at: null,
      },
    ]);
  });

  it('captures one exact v2 event per share in a multi-row revoke transaction', async () => {
    const tenant = randomUUID();
    const courseId = randomUUID();
    const shares = [randomUUID(), randomUUID()];
    await seedCourse(tenant, courseId, shares);
    const revoked = await database.tenant(tenant, (tx) => revokeSharesIn(tx, shares, 'owner_all'));
    expect(revoked).toBe(2);
    const result = await (async () => {
      const ownerClient = await owner.connect();
      try {
        await ownerClient.query('BEGIN');
        await ownerClient.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        const rows = await ownerClient.query(
          `SELECT e.event_id,e.record_version,e.athlete_id,e.target_id,e.course_share_id,
         e.course_share_epoch,e.course_share_course_revision,e.occurred_at,
         e.course_share_revoke_reason,e.course_share_audit_id,
         e.course_share_audit_occurred_at,a.reason,a.occurred_at AS audit_at,
         s.revoked_at,s.revoke_reason
       FROM restore_suppression_event e
       JOIN course_share_audit a ON a.athlete_id=e.athlete_id
         AND a.audit_id=e.course_share_audit_id
       JOIN course_share s ON s.athlete_id=e.athlete_id
         AND s.share_id=e.course_share_id
       WHERE e.athlete_id=$1 AND e.kind='course_share_revoked'
       ORDER BY e.course_share_id`,
          [tenant],
        );
        await ownerClient.query('COMMIT');
        return rows;
      } finally {
        ownerClient.release();
      }
    })();
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.course_share_id).sort()).toEqual([...shares].sort());
    for (const row of result.rows) {
      expect(row).toMatchObject({
        event_id: expect.any(String),
        record_version: 2,
        athlete_id: tenant,
        target_id: courseId,
        course_share_epoch: 3,
        course_share_course_revision: 2,
        course_share_revoke_reason: 'owner_all',
        reason: 'owner_all',
        revoke_reason: 'owner_all',
      });
      expect(row.occurred_at).toEqual(row.revoked_at);
      expect(row.course_share_audit_occurred_at).toEqual(row.audit_at);
    }
    const before = result.rows.map((row) => row.event_id);
    await database.tenant(tenant, (tx) => revokeSharesIn(tx, shares, 'owner_all'));
    const after = await owner.query(
      `SELECT event_id FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='course_share_revoked' ORDER BY course_share_id`,
      [tenant],
    );
    expect(after.rows.map((row) => row.event_id)).toEqual(before);
  });

  it('rolls back a state transition when its audit is missing or mismatched', async () => {
    const tenant = randomUUID();
    const courseId = randomUUID();
    const shareId = randomUUID();
    await seedCourse(tenant, courseId, [shareId]);
    await expect(
      database.tenant(tenant, (tx) =>
        tx.query(
          `UPDATE course_share SET state='revoked',revoked_at=clock_timestamp(),
             revoke_reason='owner' WHERE athlete_id=$1 AND share_id=$2`,
          [tenant, shareId],
        ),
      ),
    ).rejects.toThrow('COURSE_SHARE_REVOKE_PROVENANCE_MISSING');
    await expect(
      database.tenant(tenant, async (tx) => {
        await tx.query(
          `UPDATE course_share SET state='revoked',revoked_at=clock_timestamp(),
             revoke_reason='owner' WHERE athlete_id=$1 AND share_id=$2`,
          [tenant, shareId],
        );
        await tx.query(
          `INSERT INTO course_share_audit(athlete_id,audit_id,share_id,course_id,
             action,reason,occurred_at)
           VALUES($1,$2,$3,$4,'revoked','owner_all',clock_timestamp())`,
          [tenant, randomUUID(), shareId, courseId],
        );
      }),
    ).rejects.toThrow('COURSE_SHARE_AUDIT_SOURCE_MISMATCH');
    expect(
      (
        await owner.query(`SELECT state FROM course_share WHERE athlete_id=$1 AND share_id=$2`, [
          tenant,
          shareId,
        ])
      ).rows[0],
    ).toEqual({ state: 'active' });
    expect(
      (
        await owner.query(
          `SELECT event_id FROM restore_suppression_event
           WHERE athlete_id=$1 AND course_share_id=$2`,
          [tenant, shareId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await owner.query(
          `SELECT event_id FROM restore_course_share_revoke_pending
           WHERE athlete_id=$1 AND share_id=$2`,
          [tenant, shareId],
        )
      ).rows,
    ).toEqual([]);
  });

  it('denies direct runtime access even with a forged tenant setting', async () => {
    await expect(
      database.tenant(legacyTenant, (tx) =>
        tx.query('SELECT * FROM restore_course_share_revoke_pending'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.tenant(legacyTenant, (tx) => tx.query('SELECT * FROM restore_suppression_event')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
