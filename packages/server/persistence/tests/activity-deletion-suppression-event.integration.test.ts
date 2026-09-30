import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';

import {
  createActivityRepository,
  ActivityNotFound,
  type ActivityRepository,
} from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run with isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let runtime: Pool;
let database: Database;
let activities: ActivityRepository;
let operations: OperationsRepository;

type ActivityEvent = {
  event_id: string;
  athlete_id: string;
  target_id: string;
  activity_revision: number;
  source_kind: string;
  source_id: string;
  source_revision: number;
  source_content_hash: string;
};

async function events(tenant: string): Promise<ActivityEvent[]> {
  const rows = await admin.query<ActivityEvent>(
    `SELECT event_id,athlete_id,target_id::text,activity_revision,source_kind,source_id,
       source_revision,source_content_hash FROM restore_suppression_event
     WHERE athlete_id=$1 AND kind='activity_deleted' ORDER BY target_id`,
    [tenant],
  );
  return rows.rows;
}

function input(sourceId = randomUUID()): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Synthetic run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'Asia/Seoul',
      distanceMeters: 0,
    },
  };
}

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
      activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
      activity_import_receipt,outbox,command_receipt TO workout_runtime`,
  );
  runtime = new Pool({ connectionString: runtimeUrl });
  database = createDatabase({ connectionString: runtimeUrl, max: 5 });
  activities = createActivityRepository(database);
  operations = createOperationsRepository(database);
});

afterAll(async () => {
  await runtime?.end();
  await database?.close();
  await admin.end();
});

describe('transaction-local canonical activity deletion events', () => {
  it('records canonical and source revisions separately, once, and retains the event after erasure', async () => {
    const tenant = randomUUID();
    const command = input();
    const first = await activities.importActivity(tenant, command);
    await activities.updateOverlay(tenant, first.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Correction',
      title: 'User title',
    });
    const corrected = await activities.importActivity(tenant, {
      ...command,
      idempotencyKey: randomUUID(),
      source: { ...command.source, revision: 3, contentHash: 'c'.repeat(64) },
      activity: { ...command.activity, title: 'Provider revision' },
    });
    expect(corrected.revision).toBe(3);
    await activities.deleteActivity(tenant, first.activityId, { expectedRevision: 3 });
    const once = await events(tenant);
    expect(once).toEqual([
      {
        event_id: expect.any(String),
        athlete_id: tenant,
        target_id: first.activityId,
        activity_revision: 4,
        source_kind: 'fixture',
        source_id: command.source.sourceId,
        source_revision: 3,
        source_content_hash: 'c'.repeat(64),
      },
    ]);
    await activities.deleteActivity(tenant, first.activityId, { expectedRevision: 1 });
    expect(await events(tenant)).toEqual(once);
    await expect(runtime.query('SELECT * FROM restore_suppression_event')).rejects.toMatchObject({
      code: '42501',
    });
    await operations.eraseAccount(tenant);
    expect(await events(tenant)).toEqual(once);
    expect(
      (await admin.query('SELECT 1 FROM activity_canonical WHERE athlete_id=$1', [tenant])).rows,
    ).toEqual([]);
  });

  it('rolls back suppression and event, and keeps source and canonical identities tenant scoped', async () => {
    const firstTenant = randomUUID();
    const secondTenant = randomUUID();
    const sharedSource = randomUUID();
    const first = await activities.importActivity(firstTenant, input(sharedSource));
    const second = await activities.importActivity(secondTenant, input(sharedSource));
    expect(first.activityId).not.toBe(second.activityId);
    await expect(
      activities.deleteActivity(secondTenant, first.activityId, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ActivityNotFound);
    expect(await events(secondTenant)).toEqual([]);

    await expect(
      database.tenant(firstTenant, async (tx) => {
        await tx.query(
          `INSERT INTO activity_suppression(athlete_id,kind,source_id)
         SELECT athlete_id,kind,source_id FROM activity_source_head
         WHERE athlete_id=$1 AND activity_id=$2`,
          [firstTenant, first.activityId],
        );
        await tx.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [firstTenant, first.activityId],
        );
        throw new Error('rollback deletion');
      }),
    ).rejects.toThrow('rollback deletion');
    expect(await events(firstTenant)).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT deleted,revision FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
          [firstTenant, first.activityId],
        )
      ).rows,
    ).toEqual([{ deleted: false, revision: 1 }]);
    expect(
      (await admin.query('SELECT 1 FROM activity_suppression WHERE athlete_id=$1', [firstTenant]))
        .rows,
    ).toEqual([]);

    await activities.deleteActivity(firstTenant, first.activityId, { expectedRevision: 1 });
    await activities.deleteActivity(secondTenant, second.activityId, { expectedRevision: 1 });
    expect((await events(firstTenant))[0]).toMatchObject({
      target_id: first.activityId,
      source_id: sharedSource,
    });
    expect((await events(secondTenant))[0]).toMatchObject({
      target_id: second.activityId,
      source_id: sharedSource,
    });
  });

  it('refuses to commit a deletion whose source identity is missing', async () => {
    const tenant = randomUUID();
    const activityId = randomUUID();
    await database.tenant(tenant, (tx) =>
      tx.query(
        "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
        [tenant, activityId],
      ),
    );
    await expect(
      activities.deleteActivity(tenant, activityId, { expectedRevision: 1 }),
    ).rejects.toThrow('ACTIVITY_EVENT_SOURCE_MISSING');
    expect(await events(tenant)).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT deleted,revision FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
          [tenant, activityId],
        )
      ).rows,
    ).toEqual([{ deleted: false, revision: 1 }]);
    await expect(
      admin.query(
        `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at)
       VALUES($1,'activity_deleted',$2,now())`,
        [tenant, activityId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // PostgreSQL CHECK treats UNKNOWN as accepted, so every required nullable
    // activity field must be explicitly tested as present.
    for (const missing of [
      'activity_revision',
      'source_kind',
      'source_id',
      'source_revision',
      'source_content_hash',
    ] as const) {
      const values: Record<typeof missing, number | string | null> = {
        activity_revision: 2,
        source_kind: 'fixture',
        source_id: randomUUID(),
        source_revision: 1,
        source_content_hash: 'a'.repeat(64),
      };
      values[missing] = null;
      await expect(
        admin.query(
          `INSERT INTO restore_suppression_event(athlete_id,kind,target_id,occurred_at,
             activity_revision,source_kind,source_id,source_revision,source_content_hash)
           VALUES($1,'activity_deleted',$2,now(),$3,$4,$5,$6,$7)`,
          [
            tenant,
            randomUUID(),
            values.activity_revision,
            values.source_kind,
            values.source_id,
            values.source_revision,
            values.source_content_hash,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});
