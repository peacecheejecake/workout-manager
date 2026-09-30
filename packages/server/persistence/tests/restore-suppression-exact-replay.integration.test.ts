import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantOperations, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `exact_replay_${suffix}`;
const ownerRole = `exact_owner_${suffix}`;
const runtimeRole = `exact_app_${suffix}`;

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

let owner: Pool;
let runtime: Pool;

async function tenant<T>(
  pool: Pool,
  athleteId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
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
  const value = result.rows[0]?.athlete_id;
  if (!value) throw new Error('missing account');
  return value;
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
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

describe('owner-only exact restore suppression replay', () => {
  it('preserves erasure event ID/time and removes a restored identity account exactly once', async () => {
    const athleteId = await account();
    const eventId = randomUUID();
    const when = new Date(Date.now() - 60_000).toISOString();
    await tenant(owner, athleteId, async (client) => {
      const result = await client.query<{ replay_tenant_erasure_exact: string }>(
        'SELECT public.replay_tenant_erasure_exact($1,$2,$3)',
        [athleteId, eventId, when],
      );
      expect(result.rows[0]?.replay_tenant_erasure_exact).toBe('erased');
      const context = await client.query<{ id: string | null; occurred_at: string | null }>(
        `SELECT current_setting('app.restore_replay_event_id',true) AS id,
          current_setting('app.restore_replay_occurred_at',true) AS occurred_at`,
      );
      expect(context.rows[0]?.id).toBe('');
      expect(context.rows[0]?.occurred_at).toBe('');
    });
    const first = await tenant(owner, athleteId, (client) =>
      client.query<{
        event_id: string;
        occurred_at: Date;
        erased_at: Date;
        account_count: string;
      }>(
        `SELECT s.event_id,s.occurred_at,e.erased_at,
        (SELECT count(*)::text FROM identity_private.account a WHERE a.athlete_id::text=$1) AS account_count
       FROM restore_suppression_event s JOIN tenant_erasure e USING(athlete_id)
       WHERE s.athlete_id=$1`,
        [athleteId],
      ),
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ event_id: eventId, account_count: '0' });
    expect(first.rows[0]?.occurred_at.toISOString()).toBe(when);
    expect(first.rows[0]?.erased_at.toISOString()).toBe(when);
    expect(
      (
        await tenant(owner, athleteId, (client) =>
          client.query('SELECT 1 FROM restore_exact_replay_receipt WHERE event_id=$1', [eventId]),
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query(
          'UPDATE restore_exact_replay_receipt SET occurred_at=now() WHERE event_id=$1',
          [eventId],
        ),
      ),
    ).rejects.toThrow('IMMUTABLE_RESTORE_SUPPRESSION_EVENT');
    await tenant(owner, athleteId, async (client) => {
      const result = await client.query<{ replay_tenant_erasure_exact: string }>(
        'SELECT public.replay_tenant_erasure_exact($1,$2,$3)',
        [athleteId, eventId, when],
      );
      expect(result.rows[0]?.replay_tenant_erasure_exact).toBe('already_applied');
    });
    expect(
      (
        await tenant(owner, athleteId, (client) =>
          client.query('SELECT 1 FROM restore_suppression_event WHERE athlete_id=$1', [athleteId]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('preserves a course event, suppresses a restored course, and rejects mismatched retry', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    const eventId = randomUUID();
    const when = new Date(Date.now() - 60_000).toISOString();
    await tenant(owner, athleteId, (client) =>
      client.query(
        `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
           reclaimed_at,created_at,updated_at)
         VALUES($1,$2,'Restored course','private','unavailable','source_activity_deleted',
           now(),now(),now())`,
        [athleteId, courseId],
      ),
    );
    await tenant(owner, athleteId, async (client) => {
      const result = await client.query<{ replay_course_deletion_exact: string }>(
        'SELECT public.replay_course_deletion_exact($1,$2,$3,$4)',
        [athleteId, courseId, eventId, when],
      );
      expect(result.rows[0]?.replay_course_deletion_exact).toBe('deleted');
    });
    const event = await tenant(owner, athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: Date }>(
        `SELECT event_id,occurred_at FROM restore_suppression_event
       WHERE athlete_id=$1 AND kind='course_deleted' AND target_id=$2`,
        [athleteId, courseId],
      ),
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.event_id).toBe(eventId);
    expect(event.rows[0]?.occurred_at.toISOString()).toBe(when);
    await tenant(owner, athleteId, async (client) => {
      const result = await client.query<{ replay_course_deletion_exact: string }>(
        'SELECT public.replay_course_deletion_exact($1,$2,$3,$4)',
        [athleteId, courseId, eventId, when],
      );
      expect(result.rows[0]?.replay_course_deletion_exact).toBe('already_applied');
    });
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
          athleteId,
          courseId,
          randomUUID(),
          when,
        ]),
      ),
    ).rejects.toThrow('RESTORE_REPLAY_EVENT_CONFLICT');
  });

  it('denies runtime execution even when the runtime has normal account erasure permission', async () => {
    const athleteId = await account();
    await expect(
      tenant(runtime, athleteId, (client) =>
        client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          athleteId,
          randomUUID(),
          new Date(Date.now() - 60_000).toISOString(),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.replay_tenant_erasure_exact(text,uuid,timestamptz) TO "${runtimeRole}"`,
    );
    try {
      await expect(
        tenant(runtime, athleteId, (client) =>
          client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
            athleteId,
            randomUUID(),
            new Date(Date.now() - 60_000).toISOString(),
          ]),
        ),
      ).rejects.toThrow('RESTORE_REPLAY_OWNER_REQUIRED');
    } finally {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION public.replay_tenant_erasure_exact(text,uuid,timestamptz) FROM "${runtimeRole}"`,
      );
    }
    await expect(
      tenant(runtime, athleteId, async (client) => {
        await client.query("SELECT set_config('app.restore_replay_event_id',$1,true)", [
          randomUUID(),
        ]);
        await client.query("SELECT set_config('app.restore_replay_occurred_at',$1,true)", [
          new Date(Date.now() - 60_000).toISOString(),
        ]);
        await client.query('SELECT public.erase_account($1)', [athleteId]);
      }),
    ).rejects.toThrow('RESTORE_REPLAY_OWNER_REQUIRED');
    expect(
      (
        await tenant(owner, athleteId, (client) =>
          client.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [athleteId]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it('keeps the normal owner erasure trigger and rejects a live event without a replay receipt', async () => {
    const athleteId = await account();
    const proposedId = randomUUID();
    await tenant(owner, athleteId, (client) =>
      client.query('SELECT public.erase_account($1)', [athleteId]),
    );
    const event = await tenant(owner, athleteId, (client) =>
      client.query<{ event_id: string; occurred_at: Date; occurred_at_text: string }>(
        `SELECT event_id,occurred_at,occurred_at::text AS occurred_at_text FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='tenant_erased'`,
        [athleteId],
      ),
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.event_id).not.toBe(proposedId);
    expect(Math.abs(Date.now() - (event.rows[0]?.occurred_at.getTime() ?? 0))).toBeLessThan(30_000);
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          athleteId,
          event.rows[0]?.event_id,
          event.rows[0]?.occurred_at_text,
        ]),
      ),
    ).rejects.toThrow('RESTORE_REPLAY_RECEIPT_MISSING');
    await expect(
      tenant(owner, athleteId, (client) =>
        client.query(
          `INSERT INTO restore_exact_replay_receipt(event_id,athlete_id,kind,occurred_at)
           VALUES($1,$2,'tenant_erased',$3)`,
          [randomUUID(), athleteId, event.rows[0]?.occurred_at_text],
        ),
      ),
    ).rejects.toThrow('RESTORE_REPLAY_RECEIPT_CONFLICT');
  });

  it('rejects wrong tenant, foreign course and conflicting event identity with rollback', async () => {
    const first = await account();
    const other = await account();
    const courseId = randomUUID();
    const when = new Date(Date.now() - 60_000).toISOString();
    await tenant(owner, other, (client) =>
      client.query(
        `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
           reclaimed_at,created_at,updated_at)
         VALUES($1,$2,'Other course','private','unavailable','source_activity_deleted',
           now(),now(),now())`,
        [other, courseId],
      ),
    );
    await expect(
      tenant(owner, other, (client) =>
        client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
          first,
          courseId,
          randomUUID(),
          when,
        ]),
      ),
    ).rejects.toThrow('RESTORE_REPLAY_INVALID_ENTRY');
    await expect(
      tenant(owner, first, (client) =>
        client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
          first,
          courseId,
          randomUUID(),
          when,
        ]),
      ),
    ).rejects.toThrow('COURSE_REPLAY_FOREIGN_COURSE');
    expect(
      (
        await tenant(owner, other, (client) =>
          client.query('SELECT 1 FROM course WHERE course_id=$1', [courseId]),
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await tenant(owner, other, (client) =>
          client.query('SELECT 1 FROM restore_suppression_event WHERE target_id=$1', [courseId]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it('rolls back event, receipt, deletion and erasure together after a later failure', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    const courseEventId = randomUUID();
    const erasureEventId = randomUUID();
    const when = new Date(Date.now() - 60_000).toISOString();
    await tenant(owner, athleteId, (client) =>
      client.query(
        `INSERT INTO course(athlete_id,course_id,name,visibility,status,unavailable_reason,
           reclaimed_at,created_at,updated_at)
         VALUES($1,$2,'Rollback course','private','unavailable','source_activity_deleted',
           now(),now(),now())`,
        [athleteId, courseId],
      ),
    );
    await expect(
      tenant(owner, athleteId, async (client) => {
        await client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
          athleteId,
          courseId,
          courseEventId,
          when,
        ]);
        await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
          athleteId,
          erasureEventId,
          when,
        ]);
        throw new Error('FORCE_ROLLBACK');
      }),
    ).rejects.toThrow('FORCE_ROLLBACK');
    const state = await tenant(owner, athleteId, (client) =>
      client.query<{
        course_count: string;
        event_count: string;
        receipt_count: string;
        erasure_count: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM course WHERE athlete_id=$1 AND course_id=$2) course_count,
          (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) event_count,
          (SELECT count(*)::text FROM restore_exact_replay_receipt WHERE athlete_id=$1) receipt_count,
          (SELECT count(*)::text FROM tenant_erasure WHERE athlete_id=$1) erasure_count`,
        [athleteId, courseId],
      ),
    );
    expect(state.rows[0]).toMatchObject({
      course_count: '1',
      event_count: '0',
      receipt_count: '0',
      erasure_count: '0',
    });
  });

  it('retries a course event after a later exact tenant erasure subsumed its ledger row', async () => {
    const athleteId = await account();
    const courseId = randomUUID();
    const courseEventId = randomUUID();
    const erasureEventId = randomUUID();
    const firstTime = new Date(Date.now() - 120_000).toISOString();
    const secondTime = new Date(Date.now() - 60_000).toISOString();
    await tenant(owner, athleteId, async (client) => {
      await client.query('SELECT public.replay_course_deletion_exact($1,$2,$3,$4)', [
        athleteId,
        courseId,
        courseEventId,
        firstTime,
      ]);
      await client.query('SELECT public.replay_tenant_erasure_exact($1,$2,$3)', [
        athleteId,
        erasureEventId,
        secondTime,
      ]);
    });
    await tenant(owner, athleteId, async (client) => {
      const course = await client.query<{ replay_course_deletion_exact: string }>(
        'SELECT public.replay_course_deletion_exact($1,$2,$3,$4)',
        [athleteId, courseId, courseEventId, firstTime],
      );
      expect(course.rows[0]?.replay_course_deletion_exact).toBe('already_applied_by_erasure');
      const erasure = await client.query<{ replay_tenant_erasure_exact: string }>(
        'SELECT public.replay_tenant_erasure_exact($1,$2,$3)',
        [athleteId, erasureEventId, secondTime],
      );
      expect(erasure.rows[0]?.replay_tenant_erasure_exact).toBe('already_applied');
    });
  });
});
