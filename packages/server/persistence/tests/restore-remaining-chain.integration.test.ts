import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { migrate } from '../src/migrate.js';
import type { LocalReplayRecordEnvelope } from '../src/restore-suppression-pgoutput.js';
import type { SuppressionRecord } from '../src/restore-suppression-records.js';
import {
  replayVerifiedSuppressionChain,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import { encryptReplaySegment } from '../src/restore-suppression-segment.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with an isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databaseName = `remaining_chain_${suffix}`;
const ownerRole = `remaining_chain_owner_${suffix}`;
const key = Buffer.alloc(32, 76);
const keyId = 'remaining-chain-test';
const clusterId = '123456789';
const oldTime = '2026-09-29 00:00:00+00';
const eventTime = '2026-09-30 12:00:00+00';
let owner: Pool;

type Fixture = {
  athleteId: string;
  courseId: string;
  shareId: string;
  courseEventId: string;
  auditId: string;
  intakeId: string;
  intakeOriginId: string;
  intakePreviousId: string;
  intakeDeletedId: string;
  intakeEventId: string;
  actionId: string;
  actionPreviousId: string;
  actionDeletedId: string;
  actionEventId: string;
};

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}

async function tenant<T>(athleteId: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
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

async function fixture(): Promise<Fixture> {
  const item: Fixture = {
    athleteId: randomUUID(),
    courseId: randomUUID(),
    shareId: randomUUID(),
    courseEventId: randomUUID(),
    auditId: randomUUID(),
    intakeId: `private-meal-${randomUUID()}`,
    intakeOriginId: randomUUID(),
    intakePreviousId: randomUUID(),
    intakeDeletedId: randomUUID(),
    intakeEventId: randomUUID(),
    actionId: randomUUID(),
    actionPreviousId: randomUUID(),
    actionDeletedId: randomUUID(),
    actionEventId: randomUUID(),
  };
  await owner.query(
    `INSERT INTO identity_private.account(athlete_id,issuer,subject)
     VALUES($1,'https://issuer.test',$2)`,
    [item.athleteId, randomUUID()],
  );
  await tenant(item.athleteId, async (client) => {
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,
         revision_id,created_at,updated_at)
       VALUES($1,$2,'Synthetic course','private','available',2,$3,$4,$4)`,
      [item.athleteId, item.courseId, revisionId, oldTime],
    );
    await client.query(
      `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,
         geometry,waypoints,generation,edit,vertex_count,distance_meters,content_digest,
         created_at)
       VALUES($1,$2,2,$3,'Synthetic course','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,2,10,repeat('a',64),$4)`,
      [item.athleteId, item.courseId, revisionId, oldTime],
    );
    await client.query(
      `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
         token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
       VALUES($1,$2,$3,2,$4,$5,3,'active',false,ARRAY[$6::uuid],
         '{"coordinates":[]}'::jsonb,$7::timestamptz,$7::timestamptz+interval '30 days')`,
      [
        item.athleteId,
        item.shareId,
        item.courseId,
        randomUUID(),
        createHash('sha256').update(item.shareId).digest('hex'),
        randomUUID(),
        oldTime,
      ],
    );
    await client.query(
      `INSERT INTO intake_entry(athlete_id,id,current_revision,current_revision_id,status)
       VALUES($1,$2,1,$3,'active')`,
      [item.athleteId, item.intakeId, item.intakeOriginId],
    );
    await client.query(
      `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         occurred_at,recorded_at,record_json)
       VALUES($1,$2,1,$3,'active',$4,$4,$5::jsonb)`,
      [
        item.athleteId,
        item.intakeId,
        item.intakeOriginId,
        oldTime,
        JSON.stringify({
          intakeId: item.intakeId,
          revisionId: item.intakeOriginId,
          revision: 1,
          status: 'active',
          occurredAt: oldTime,
          recordedAt: oldTime,
          notes: 'private meal',
        }),
      ],
    );
    await client.query(
      `INSERT INTO intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,
         occurred_at,recorded_at,record_json)
       VALUES($1,$2,2,$3,'active',$4,$4,$5::jsonb)`,
      [
        item.athleteId,
        item.intakeId,
        item.intakePreviousId,
        oldTime,
        JSON.stringify({
          intakeId: item.intakeId,
          revisionId: item.intakePreviousId,
          revision: 2,
          status: 'active',
          occurredAt: oldTime,
          recordedAt: oldTime,
          notes: 'private correction',
        }),
      ],
    );
    await client.query(
      `UPDATE intake_entry SET current_revision=2,current_revision_id=$3
       WHERE athlete_id=$1 AND id=$2`,
      [item.athleteId, item.intakeId, item.intakePreviousId],
    );
    await client.query(
      `INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status)
       VALUES($1,$2,1,$3,'active')`,
      [item.athleteId, item.actionId, item.actionPreviousId],
    );
    await client.query(
      `INSERT INTO recovery_action_revision(athlete_id,action_id,revision,revision_id,status,
         record_json) VALUES($1,$2,1,$3,'active',$4::jsonb)`,
      [
        item.athleteId,
        item.actionId,
        item.actionPreviousId,
        JSON.stringify({
          schemaVersion: 1,
          actionId: item.actionId,
          revisionId: item.actionPreviousId,
          revision: 1,
          status: 'active',
          userNotes: 'private recovery',
        }),
      ],
    );
  });
  return item;
}

function records(item: Fixture): SuppressionRecord[] {
  return [
    {
      schemaVersion: 2,
      eventId: item.courseEventId,
      athleteId: item.athleteId,
      occurredAt: eventTime,
      kind: 'course_share_revoked',
      targetId: item.courseId,
      courseShareId: item.shareId,
      courseShareEpoch: 3,
      courseShareCourseRevision: 2,
      courseShareRevokeReason: 'zone_removed',
      courseShareAuditId: item.auditId,
      courseShareAuditOccurredAt: eventTime,
    },
    {
      schemaVersion: 2,
      eventId: item.intakeEventId,
      athleteId: item.athleteId,
      occurredAt: eventTime,
      kind: 'intake_entry_deleted',
      targetId: item.intakeOriginId,
      actualDeletionRevision: 3,
      actualPreviousRevisionId: item.intakePreviousId,
      actualDeletedRevisionId: item.intakeDeletedId,
    },
    {
      schemaVersion: 2,
      eventId: item.actionEventId,
      athleteId: item.athleteId,
      occurredAt: eventTime,
      kind: 'recovery_action_deleted',
      targetId: item.actionId,
      actualDeletionRevision: 2,
      actualPreviousRevisionId: item.actionPreviousId,
      actualDeletedRevisionId: item.actionDeletedId,
    },
  ];
}

function chain(sourceRecords: readonly SuppressionRecord[]): {
  segments: Buffer[];
  anchor: TrustedReplayAnchor;
  key: Buffer;
  keyId: string;
} {
  const body = {
    localRecordVersion: 1 as const,
    clusterId,
    fromLsn: '0/100',
    throughLsn: '0/120',
    previousHash: null,
    transactions: [{ commitLsn: '0/110', endLsn: '0/120', records: [...sourceRecords] }],
  };
  const envelope: LocalReplayRecordEnvelope = {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const bytes = encryptReplaySegment({ envelope, key, keyId }).bytes;
  return {
    segments: [bytes],
    key,
    keyId,
    anchor: {
      clusterId,
      fromLsn: '0/100',
      previousHash: null,
      throughLsn: '0/120',
      finalLocalHash: envelope.sha256,
      ciphertextHashes: [createHash('sha256').update(bytes).digest('hex')],
    },
  };
}

async function state(item: Fixture) {
  return tenant(item.athleteId, async (client) => {
    const result = await client.query<{
      share_state: string;
      intake_status: string;
      intake_revision: number;
      action_status: string;
      action_revision: number;
      audit_count: string;
      event_count: string;
      actual_receipts: string;
      course_receipts: string;
      outbox_count: string;
    }>(
      `SELECT
         (SELECT state FROM course_share WHERE athlete_id=$1 AND share_id=$2) share_state,
         (SELECT status FROM intake_entry WHERE athlete_id=$1 AND id=$3) intake_status,
         (SELECT current_revision FROM intake_entry WHERE athlete_id=$1 AND id=$3) intake_revision,
         (SELECT status FROM recovery_action_log WHERE athlete_id=$1 AND action_id=$4) action_status,
         (SELECT revision FROM recovery_action_log WHERE athlete_id=$1 AND action_id=$4) action_revision,
         (SELECT count(*)::text FROM course_share_audit WHERE athlete_id=$1
           AND share_id=$2 AND action='revoked') audit_count,
         (SELECT count(*)::text FROM restore_suppression_event
           WHERE event_id IN ($5,$6,$7)) event_count,
         (SELECT count(*)::text FROM restore_actual_deletion_replay_receipt
           WHERE event_id IN ($6,$7)) actual_receipts,
         (SELECT count(*)::text FROM restore_course_share_replay_receipt
           WHERE event_id=$5) course_receipts,
         (SELECT count(*)::text FROM outbox WHERE athlete_id=$1 AND id IN ($6,$7)) outbox_count`,
      [
        item.athleteId,
        item.shareId,
        item.intakeId,
        item.actionId,
        item.courseEventId,
        item.intakeEventId,
        item.actionEventId,
      ],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${ownerRole}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  await migrate(urlFor(ownerRole));
});
afterAll(async () => {
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  await admin.end();
});

describe('authenticated future-v2 remaining suppression chain on PostgreSQL', () => {
  it('replays all three kinds exactly and retries after worker-consumed outbox rows', async () => {
    const item = await fixture();
    const input = chain(records(item));
    const summary = await replayVerifiedSuppressionChain({ ...input, ownerPool: owner });
    expect(summary.eventCount).toBe(3);
    expect(JSON.stringify(summary)).not.toContain(item.athleteId);
    expect(JSON.stringify(summary)).not.toContain(item.intakeId);
    expect(await state(item)).toMatchObject({
      share_state: 'revoked',
      intake_status: 'deleted',
      intake_revision: 3,
      action_status: 'deleted',
      action_revision: 2,
      audit_count: '1',
      event_count: '3',
      actual_receipts: '2',
      course_receipts: '1',
      outbox_count: '2',
    });
    const source = await tenant(item.athleteId, (client) =>
      client.query<{
        event_id: string;
        target_id: string;
        occurred_at: Date;
        course_share_audit_id: string | null;
        course_share_audit_occurred_at: Date | null;
        course_share_epoch: number | null;
        course_share_course_revision: number | null;
        course_share_revoke_reason: string | null;
        audit_at: Date | null;
        actual_deletion_revision: number | null;
        actual_previous_revision_id: string | null;
        actual_deleted_revision_id: string | null;
      }>(
        `SELECT e.event_id,e.target_id::text,e.occurred_at,
           e.course_share_audit_id::text,e.course_share_audit_occurred_at,
           e.course_share_epoch,e.course_share_course_revision,
           e.course_share_revoke_reason,a.occurred_at AS audit_at,
           e.actual_deletion_revision,e.actual_previous_revision_id::text,
           e.actual_deleted_revision_id::text
         FROM restore_suppression_event e
         LEFT JOIN course_share_audit a ON a.athlete_id=e.athlete_id
           AND a.audit_id=e.course_share_audit_id
         WHERE e.event_id IN ($1,$2,$3) ORDER BY e.event_id`,
        [item.courseEventId, item.intakeEventId, item.actionEventId],
      ),
    );
    expect(source.rows).toHaveLength(3);
    expect(source.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: item.courseEventId,
          target_id: item.courseId,
          course_share_audit_id: item.auditId,
          course_share_audit_occurred_at: new Date(eventTime),
          course_share_epoch: 3,
          course_share_course_revision: 2,
          course_share_revoke_reason: 'zone_removed',
          audit_at: new Date(eventTime),
        }),
        expect.objectContaining({
          event_id: item.intakeEventId,
          target_id: item.intakeOriginId,
          actual_deletion_revision: 3,
          actual_previous_revision_id: item.intakePreviousId,
          actual_deleted_revision_id: item.intakeDeletedId,
        }),
        expect.objectContaining({
          event_id: item.actionEventId,
          target_id: item.actionId,
          actual_deletion_revision: 2,
          actual_previous_revision_id: item.actionPreviousId,
          actual_deleted_revision_id: item.actionDeletedId,
        }),
      ]),
    );
    for (const row of source.rows) expect(row.occurred_at).toEqual(new Date(eventTime));
    await tenant(item.athleteId, (client) =>
      client.query('DELETE FROM outbox WHERE athlete_id=$1 AND id IN ($2,$3)', [
        item.athleteId,
        item.intakeEventId,
        item.actionEventId,
      ]),
    );
    await replayVerifiedSuppressionChain({ ...input, ownerPool: owner });
    expect(await state(item)).toMatchObject({
      audit_count: '1',
      event_count: '3',
      actual_receipts: '2',
      course_receipts: '1',
      outbox_count: '0',
    });
  });

  it('rejects v1 records before connecting to PostgreSQL', async () => {
    const item = await fixture();
    const old = records(item).map((record) =>
      record.kind === 'course_share_revoked'
        ? {
            schemaVersion: 1 as const,
            eventId: record.eventId,
            athleteId: record.athleteId,
            occurredAt: record.occurredAt,
            kind: record.kind,
            targetId: record.targetId,
            courseShareId: record.courseShareId,
            courseShareEpoch: record.courseShareEpoch,
            courseShareCourseRevision: record.courseShareCourseRevision,
          }
        : record,
    );
    const spy = vi.spyOn(owner, 'connect');
    try {
      await expect(
        replayVerifiedSuppressionChain({ ...chain(old), ownerPool: owner }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await state(item)).toMatchObject({
      share_state: 'active',
      intake_status: 'active',
      action_status: 'active',
      event_count: '0',
    });
  });

  it('rolls back earlier course and intake changes on a late recovery conflict', async () => {
    const item = await fixture();
    await tenant(item.athleteId, (client) =>
      client.query(
        `INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload)
         VALUES($1,$2,$3,'unrelated.topic','{}'::jsonb)`,
        [item.athleteId, item.actionEventId, `unrelated:${item.actionEventId}`],
      ),
    );
    await expect(
      replayVerifiedSuppressionChain({ ...chain(records(item)), ownerPool: owner }),
    ).rejects.toThrow();
    expect(await state(item)).toMatchObject({
      share_state: 'active',
      intake_status: 'active',
      intake_revision: 2,
      action_status: 'active',
      action_revision: 1,
      audit_count: '0',
      event_count: '0',
      actual_receipts: '0',
      course_receipts: '0',
      outbox_count: '1',
    });
  });
});
