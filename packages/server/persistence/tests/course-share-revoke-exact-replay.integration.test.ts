import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantCourses, grantOperations, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `course_share_replay_${suffix}`;
const ownerRole = `course_share_replay_owner_${suffix}`;
const runtimeRole = `course_share_replay_rt_${suffix}`;
let owner: Pool;
let runtime: Pool;

type Entry = {
  athleteId: string;
  courseId: string;
  shareId: string;
  eventId: string;
  occurredAt: string;
  epoch: number;
  courseRevision: number;
  reason: 'owner' | 'owner_all' | 'zone_added' | 'zone_removed';
  auditId: string;
  auditOccurredAt: string;
};

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenant<T>(
  pool: Pool,
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function account(): Promise<string> {
  const result = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
     VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const id = result.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
}

async function liveShare(athleteId: string, options?: { shareId?: string }): Promise<Entry> {
  const courseId = randomUUID();
  const shareId = options?.shareId ?? randomUUID();
  await tenant(owner, athleteId, async (client) => {
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
         revision_id,created_at,updated_at)
       VALUES($1,$2,'Synthetic course','private','available',2,$3,now(),now())`,
      [athleteId, courseId, revisionId],
    );
    await client.query(
      `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
         geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
         created_at)
       VALUES($1,$2,2,$3,'Synthetic course','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,2,10,$4,now())`,
      [athleteId, courseId, revisionId, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
         token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
       VALUES($1,$2,$3,2,$4,$5,3,'active',false,ARRAY[$6::uuid],
         '{"coordinates":[]}'::jsonb,now(),now()+interval '1 day')`,
      [
        athleteId,
        shareId,
        courseId,
        randomUUID(),
        createHash('sha256').update(`${shareId}:${courseId}`).digest('hex'),
        randomUUID(),
      ],
    );
  });
  const time = await owner.query<{ occurred_at: string }>(
    'SELECT clock_timestamp()::text AS occurred_at',
  );
  const occurredAt = time.rows[0]?.occurred_at;
  if (!occurredAt) throw new Error('missing replay time');
  return {
    athleteId,
    courseId,
    shareId,
    eventId: randomUUID(),
    occurredAt,
    epoch: 3,
    courseRevision: 2,
    reason: 'zone_removed',
    auditId: randomUUID(),
    auditOccurredAt: occurredAt,
  };
}

function args(item: Entry): unknown[] {
  return [
    item.athleteId,
    item.courseId,
    item.shareId,
    item.eventId,
    item.occurredAt,
    item.epoch,
    item.courseRevision,
    item.reason,
    item.auditId,
    item.auditOccurredAt,
  ];
}

async function execute(client: PoolClient, item: Entry): Promise<string> {
  const result = await client.query<{ replay_course_share_revoke_exact: string }>(
    'SELECT public.replay_course_share_revoke_exact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    args(item),
  );
  return result.rows[0]?.replay_course_share_revoke_exact ?? '';
}

async function replay(pool: Pool, item: Entry): Promise<string> {
  return tenant(pool, item.athleteId, (client) => execute(client, item));
}

async function state(item: Entry) {
  return tenant(owner, item.athleteId, async (client) => {
    const result = await client.query<{
      state: string | null;
      revoke_reason: string | null;
      revoked_at: Date | null;
      audit_count: string;
      event_count: string;
      receipt_count: string;
      context_count: string;
    }>(
      `SELECT s.state,s.revoke_reason,s.revoked_at,
         (SELECT count(*)::text FROM course_share_audit a
          WHERE a.athlete_id=$1 AND a.share_id=$2 AND a.action='revoked') AS audit_count,
         (SELECT count(*)::text FROM restore_suppression_event e
          WHERE e.athlete_id=$1 AND e.kind='course_share_revoked'
            AND e.course_share_id=$2) AS event_count,
         (SELECT count(*)::text FROM restore_course_share_replay_receipt r
          WHERE r.athlete_id=$1 AND r.share_id=$2) AS receipt_count,
         (SELECT count(*)::text FROM restore_course_share_replay_context c
          WHERE c.athlete_id=$1 AND c.share_id=$2) AS context_count
       FROM course_share s WHERE s.athlete_id=$1 AND s.share_id=$2`,
      [item.athleteId, item.shareId],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await migrate(urlFor(ownerRole));
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantCourses(urlFor(ownerRole), runtimeRole);
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('exact v2 course-share revoke replay under a plain owner', () => {
  it('preserves event and audit identity, then accepts only the exact receipt retry', async () => {
    const item = await liveShare(await account());
    expect(await replay(owner, item)).toBe('revoked');
    const result = await tenant(owner, item.athleteId, (client) =>
      client.query(
        `SELECT e.event_id,e.record_version,e.occurred_at,e.target_id,
           e.course_share_id,e.course_share_epoch,e.course_share_course_revision,
           e.course_share_revoke_reason,e.course_share_audit_id,
           e.course_share_audit_occurred_at,a.audit_id,a.reason,a.occurred_at AS audit_at
         FROM restore_suppression_event e
         JOIN course_share_audit a ON a.athlete_id=e.athlete_id
           AND a.audit_id=e.course_share_audit_id WHERE e.event_id=$1`,
        [item.eventId],
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      event_id: item.eventId,
      record_version: 2,
      target_id: item.courseId,
      course_share_id: item.shareId,
      course_share_epoch: 3,
      course_share_course_revision: 2,
      course_share_revoke_reason: item.reason,
      course_share_audit_id: item.auditId,
      audit_id: item.auditId,
      reason: item.reason,
    });
    expect(result.rows[0]?.occurred_at).toEqual(new Date(item.occurredAt));
    expect(result.rows[0]?.course_share_audit_occurred_at).toEqual(new Date(item.auditOccurredAt));
    expect(result.rows[0]?.audit_at).toEqual(new Date(item.auditOccurredAt));
    expect(await replay(owner, item)).toBe('already_applied');
    expect(await state(item)).toMatchObject({
      state: 'revoked',
      revoke_reason: item.reason,
      audit_count: '1',
      event_count: '1',
      receipt_count: '1',
      context_count: '0',
    });
    await expect(replay(owner, { ...item, reason: 'owner' })).rejects.toThrow(
      'RESTORE_COURSE_SHARE_EVENT_CONFLICT',
    );
  });

  it('rolls back the first revoke if a later event conflicts', async () => {
    const athleteId = await account();
    const first = await liveShare(athleteId);
    const second = await liveShare(athleteId);
    await expect(
      tenant(owner, athleteId, async (client) => {
        expect(await execute(client, first)).toBe('revoked');
        await execute(client, { ...second, eventId: first.eventId });
      }),
    ).rejects.toThrow('RESTORE_COURSE_SHARE_EVENT_CONFLICT');
    expect(await state(first)).toMatchObject({
      state: 'active',
      audit_count: '0',
      event_count: '0',
      receipt_count: '0',
      context_count: '0',
    });
  });

  it('rejects legacy v1, absent and foreign share targets', async () => {
    const ownerId = await account();
    const legacy = await liveShare(ownerId);
    await tenant(owner, ownerId, (client) =>
      client.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,
           course_share_id,course_share_epoch,course_share_course_revision,
           occurred_at) VALUES($1,'course_share_revoked',$2,$3,$4,$5,$6)`,
        [ownerId, legacy.courseId, legacy.shareId, 3, 2, legacy.occurredAt],
      ),
    );
    await expect(replay(owner, legacy)).rejects.toThrow('RESTORE_COURSE_SHARE_EVENT_CONFLICT');
    const absent = await liveShare(await account());
    await expect(replay(owner, { ...absent, shareId: randomUUID() })).rejects.toThrow(
      'RESTORE_COURSE_SHARE_ABSENT_UNSUPPORTED',
    );
    const foreignOwner = await account();
    await liveShare(foreignOwner, { shareId: absent.shareId });
    await expect(replay(owner, absent)).rejects.toThrow('RESTORE_COURSE_SHARE_FOREIGN_TARGET');
  });

  it('denies runtime invocation and a spoofed replay marker in source triggers', async () => {
    const item = await liveShare(await account());
    await expect(replay(runtime, item)).rejects.toThrow(/permission denied/);
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_course_share_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `UPDATE course_share SET state='revoked',revoked_at=clock_timestamp(),
             revoke_reason='owner' WHERE athlete_id=$1 AND share_id=$2`,
          [item.athleteId, item.shareId],
        );
      }),
    ).rejects.toThrow('RESTORE_COURSE_SHARE_OWNER_REQUIRED');
    await expect(
      tenant(runtime, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_course_share_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `INSERT INTO course_share_audit(athlete_id,audit_id,share_id,course_id,
             action,reason,occurred_at)
           VALUES($1,$2,$3,$4,'revoked','owner',clock_timestamp())`,
          [item.athleteId, item.auditId, item.shareId, item.courseId],
        );
      }),
    ).rejects.toThrow('RESTORE_COURSE_SHARE_OWNER_REQUIRED');
    expect(await state(item)).toMatchObject({
      state: 'active',
      event_count: '0',
      audit_count: '0',
    });
    await expect(
      tenant(owner, item.athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_course_share_event_id',$1,true)", [
          item.eventId,
        ]);
        await client.query(
          `UPDATE course_share SET state='revoked',revoked_at=clock_timestamp(),
             revoke_reason='owner' WHERE athlete_id=$1 AND share_id=$2`,
          [item.athleteId, item.shareId],
        );
      }),
    ).rejects.toThrow('RESTORE_COURSE_SHARE_OWNER_REQUIRED');
  });

  it('retries an exact revoke after exact tenant erasure without recreating the share', async () => {
    const item = await liveShare(await account());
    expect(await replay(owner, item)).toBe('revoked');
    await tenant(owner, item.athleteId, (client) =>
      client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        item.athleteId,
        randomUUID(),
        new Date().toISOString(),
      ]),
    );
    expect(await replay(owner, item)).toBe('already_applied_by_erasure');
    const missing = {
      ...item,
      shareId: randomUUID(),
      eventId: randomUUID(),
      auditId: randomUUID(),
    };
    await expect(replay(owner, missing)).rejects.toThrow('RESTORE_COURSE_SHARE_TENANT_ERASED');
  });
});
