import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { createStretchingRepository } from '../src/stretching.js';
import {
  createSupplementaryRepository,
  insertSupplementarySessionLink,
} from '../src/supplementary-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
function ownerDatabase(pool: Pool): Database {
  const tenant: Database['tenant'] = async (athleteId, operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
      const result = await operation({
        athleteId,
        query: (sql, values) => client.query(sql, values),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return { tenant, exclusiveTenant: tenant, close: async () => undefined };
}
const athlete = `stretching-${randomUUID()}`;
const other = `stretching-${randomUUID()}`;
const exerciseId = randomUUID();
const versionId = randomUUID();
const activityId = randomUUID();
const logId = randomUUID();
const now = '2026-09-18T09:20:00.000Z';
const definition = {
  schemaVersion: 2 as const,
  exerciseId,
  versionId,
  name: 'Left reach',
  family: 'stretching' as const,
  equipment: ['bodyweight' as const],
  tags: ['shoulder'],
  countDefinitions: [],
  mediaAssetIds: [],
  resourceVersionIds: [],
  reviewState: 'unreviewed' as const,
  description: 'User described',
  safetyNotes: 'Stop if uncomfortable',
  supportedMetrics: ['duration' as const],
  createdAt: '2026-09-18T09:00:00.000Z',
};
const profile = {
  method: 'static_hold' as const,
  movement: 'active' as const,
  assistance: 'self' as const,
  context: 'cooldown' as const,
  bodyRegions: ['shoulder'],
  sideBasis: 'per_side' as const,
  source: { kind: 'user_authored' as const },
};
const values = {
  activityId,
  exerciseVersionId: versionId,
  plannedTarget: null,
  allocation: { kind: 'standalone' as const },
  side: 'left' as const,
  state: 'performed' as const,
  holdSeconds: 25,
  repetitions: null,
  restSeconds: null,
  comfort: 'unknown' as const,
  discomfortNote: null,
  reason: null,
  occurredAt: '2026-09-18T09:05:00.000Z',
};
beforeAll(async () => {
  await migrate(adminUrl);
  database = ownerDatabase(admin);
  await database.tenant(athlete, async (tx) => {
    await tx.query(
      `INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)`,
      [
        athlete,
        activityId,
        JSON.stringify({
          title: 'Manual stretching',
          kind: 'other',
          startedAt: '2026-09-18T09:00:00.000Z',
          durationSeconds: 600,
          durationKind: 'elapsed',
          timezone: 'Asia/Seoul',
          distanceMeters: null,
        }),
      ],
    );
  });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
describe('stretching catalog extension and Activity actuals', () => {
  it('atomically saves a v2 catalog version plus immutable profile and replays it', async () => {
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    const input = {
      definition,
      profile,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
    };
    const first = await repo.saveExercise(athlete, input);
    expect(first.definition.schemaVersion).toBe(2);
    expect(first.profile.sideBasis).toBe('per_side');
    expect(await repo.saveExercise(athlete, input)).toEqual(first);
    expect((await repo.listExercises(athlete)).items).toEqual([first]);
    expect(await repo.readExercise(other, exerciseId)).toBeNull();
    const rows = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM supplementary_exercise_version WHERE athlete_id=$1 AND exercise_id=$2',
        [athlete, exerciseId],
      ),
    );
    expect(rows.rows[0]?.['total']).toBe(1);
  });
  it('keeps confirmed side/time separate from Activity time and rejects invalid side/metric', async () => {
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    const input = {
      schemaVersion: 1 as const,
      logId,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed' as const,
      values,
    };
    const first = await repo.createLog(athlete, input);
    expect(first.status).toBe('active');
    expect(await repo.createLog(athlete, input)).toEqual(first);
    await expect(
      repo.createLog(athlete, {
        ...input,
        logId: randomUUID(),
        idempotencyKey: randomUUID(),
        values: { ...values, side: 'total' as const },
      }),
    ).rejects.toThrow('STRETCH_LOG_INVALID');
    await expect(
      repo.createLog(athlete, {
        ...input,
        logId: randomUUID(),
        idempotencyKey: randomUUID(),
        values: { ...values, repetitions: 3, holdSeconds: null },
      }),
    ).rejects.toThrow('STRETCH_LOG_INVALID');
    const stored = await database.tenant(athlete, (tx) =>
      tx.query(
        "SELECT count(*)::int AS total,max(original->>'durationSeconds') AS duration FROM activity_canonical WHERE athlete_id=$1 AND id=$2",
        [athlete, activityId],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ total: 1, duration: '600' });
    expect((await repo.listLogs(athlete, activityId)).items).toEqual([first]);
    expect((await repo.listLogs(other, null)).items).toEqual([]);
  });
  it('bounds explicit blocks by elapsed evidence, never timer or moving duration', async () => {
    const timerActivityId = randomUUID();
    const movingActivityId = randomUUID();
    const sourcedActivityId = randomUUID();
    const sourceId = randomUUID();
    const startedAt = '2026-09-18T09:00:00.000Z';
    await database.tenant(athlete, async (tx) => {
      for (const [id, durationKind] of [
        [timerActivityId, 'timer'],
        [movingActivityId, 'moving'],
        [sourcedActivityId, 'timer'],
      ]) {
        await tx.query(
          'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
          [
            athlete,
            id,
            JSON.stringify({
              title: 'Time basis fixture',
              kind: 'other',
              startedAt,
              durationSeconds: 180,
              durationKind,
              timezone: 'UTC',
              distanceMeters: null,
            }),
          ],
        );
      }
      await tx.query(
        `INSERT INTO activity_source_head
         (athlete_id,kind,source_id,source_revision,content_hash,activity_id)
         VALUES($1,'fixture',$2,1,$3,$4)`,
        [athlete, sourceId, 'a'.repeat(64), sourcedActivityId],
      );
      await tx.query(
        `INSERT INTO activity_source_revision
         (athlete_id,kind,source_id,source_revision,content_hash,normalized_raw,details_json)
         VALUES($1,'fixture',$2,1,$3,'{}'::jsonb,$4::jsonb)`,
        [
          athlete,
          sourceId,
          'a'.repeat(64),
          JSON.stringify({
            schemaVersion: 3,
            streamIndex: 0,
            sessionIndex: 0,
            startedAt,
            recordedAt: '2026-09-18T09:10:00.000Z',
            elapsedSeconds: 600,
            records: [],
            laps: [],
            sessionSummary: { averageHeartRateBpm: null, maximumHeartRateBpm: null },
            allocation: {
              parent: { startedAt, endedAtExclusive: '2026-09-18T09:10:00.000Z' },
              bouts: [
                {
                  sourceLapIndex: null,
                  startedAt,
                  endedAtExclusive: '2026-09-18T09:10:00.000Z',
                  kind: 'mixed_unallocated',
                },
              ],
            },
          }),
        ],
      );
    });
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    const block = {
      kind: 'activity_block' as const,
      startedAt: '2026-09-18T09:08:00.000Z',
      endedAtExclusive: '2026-09-18T09:09:00.000Z',
    };
    for (const id of [timerActivityId, movingActivityId]) {
      await expect(
        repo.createLog(athlete, {
          schemaVersion: 1,
          logId: randomUUID(),
          idempotencyKey: randomUUID(),
          confirmation: 'user_confirmed',
          values: { ...values, activityId: id, allocation: block },
        }),
      ).rejects.toThrow('STRETCH_LOG_INVALID');
    }
    const sourced = await repo.createLog(athlete, {
      schemaVersion: 1,
      logId: randomUUID(),
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed',
      values: { ...values, activityId: sourcedActivityId, allocation: block },
    });
    expect(sourced.status).toBe('active');
    await expect(
      repo.createLog(athlete, {
        schemaVersion: 1,
        logId: randomUUID(),
        idempotencyKey: randomUUID(),
        confirmation: 'user_confirmed',
        values: {
          ...values,
          activityId: sourcedActivityId,
          allocation: { ...block, endedAtExclusive: '2026-09-18T09:11:00.000Z' },
        },
      }),
    ).rejects.toThrow('STRETCH_LOG_INVALID');
  });
  it('does not let the generic supplementary set log bypass stretching actual fields', async () => {
    const executionId = randomUUID();
    await database.tenant(athlete, (tx) =>
      tx.query(
        `INSERT INTO supplementary_execution
       (athlete_id,id,activity_id,revision,status,started_at)
       VALUES($1,$2,$3,1,'active',$4)`,
        [athlete, executionId, activityId, '2026-09-18T09:00:00.000Z'],
      ),
    );
    const supplementary = createSupplementaryRepository(database, { now: () => new Date(now) });
    await expect(
      supplementary.createSetLog(athlete, {
        schemaVersion: 2,
        executionId,
        logId: randomUUID(),
        expectedExecutionRevision: 1,
        idempotencyKey: randomUUID(),
        confirmation: 'user_confirmed',
        values: {
          targetSetId: null,
          blockId: null,
          roundIndex: null,
          exerciseVersionId: versionId,
          side: 'left',
          state: 'performed',
          count: null,
          durationSeconds: { value: 25, unit: 's', status: 'reported', evidenceIds: [] },
          externalResistance: { kind: 'unknown' },
          effort: { rir: null, rpe: null, scaleVersion: 'rpe-v1' },
          occurredAt: '2026-09-18T09:05:00.000Z',
          reason: null,
        },
      }),
    ).rejects.toThrow('TARGET_LINK_INVALID');
    const targets = await createStretchingRepository(database).listTargets(athlete, activityId);
    expect(targets).toEqual({ items: [], hasMore: false });
  });
  it('links an approved supplementary target without copying a planned hold or creating another Activity', async () => {
    const routineVersionId = randomUUID(),
      routineId = randomUUID();
    const supplementary = createSupplementaryRepository(database, { now: () => new Date(now) });
    await supplementary.saveRoutine(athlete, {
      template: {
        schemaVersion: 2,
        routineId,
        versionId: routineVersionId,
        title: 'Cooldown',
        purpose: '',
        requiredEquipment: ['bodyweight'],
        createdAt: now,
        spec: {
          schemaVersion: 2,
          kind: 'supplementary',
          routineVersionId,
          blocks: [
            {
              id: 'stretch-block',
              mode: 'single',
              rounds: 1,
              restBetweenRoundsSeconds: null,
              sets: [
                {
                  id: 'hold-left',
                  exerciseVersionId: versionId,
                  side: 'left',
                  count: null,
                  durationSeconds: {
                    min: 40,
                    max: 40,
                    unit: 's',
                    basis: 'user_confirmed',
                    evidenceIds: [],
                  },
                  externalResistance: { kind: 'unknown' },
                  restAfterSeconds: 20,
                  tempo: null,
                  effort: null,
                },
              ],
            },
          ],
        },
      },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const planVersionId = randomUUID();
    const link = {
      schemaVersion: 2 as const,
      planVersionId,
      plannedSessionId: 'strength-1',
      content: { kind: 'routine_version' as const, routineVersionId },
    };
    const plannedActivityId = randomUUID();
    await database.tenant(athlete, async (tx) => {
      await tx.query(
        'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
        [
          athlete,
          planVersionId,
          JSON.stringify({
            title: 'Cooldown',
            timezone: 'UTC',
            periods: [],
            sessions: [{ id: 'strength-1', sport: 'strength' }],
          }),
        ],
      );
      await tx.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [
        athlete,
        planVersionId,
      ]);
      await tx.query(
        "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
        [athlete, planVersionId],
      );
      await insertSupplementarySessionLink(tx, link);
      await tx.query(
        'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
        [
          athlete,
          plannedActivityId,
          JSON.stringify({
            title: 'Strength with cooldown',
            kind: 'strength',
            startedAt: '2026-09-18T09:00:00.000Z',
            durationSeconds: 600,
            durationKind: 'elapsed',
            timezone: 'Asia/Seoul',
            distanceMeters: null,
          }),
        ],
      );
    });
    const execution = await supplementary.createExecution(athlete, {
      schemaVersion: 2,
      executionId: randomUUID(),
      plannedSession: link,
      activity: { kind: 'match_existing', activityId: plannedActivityId },
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const repository = createStretchingRepository(database, { now: () => new Date(now) });
    const targets = await repository.listTargets(athlete, plannedActivityId);
    expect(targets.items).toMatchObject([
      {
        executionId: execution.executionId,
        targetSetId: 'hold-left',
        plannedHoldSeconds: { min: 40, max: 40 },
        restAfterSeconds: 20,
      },
    ]);
    const actual = await repository.createLog(athlete, {
      schemaVersion: 1,
      logId: randomUUID(),
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed',
      values: {
        ...values,
        activityId: plannedActivityId,
        allocation: { kind: 'activity_block', startedAt: null, endedAtExclusive: null },
        plannedTarget: { executionId: execution.executionId, targetSetId: 'hold-left' },
        holdSeconds: 25,
        restSeconds: null,
      },
    });
    expect(actual.status).toBe('active');
    if (actual.status === 'active') {
      expect(actual.current.holdSeconds).toBe(25);
      expect(actual.current.restSeconds).toBeNull();
    }
    const count = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
        [athlete, plannedActivityId],
      ),
    );
    expect(count.rows[0]?.['total']).toBe(1);
  });
  it('preserves stopped corrections and rejects a stale concurrent write', async () => {
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    const correction = {
      schemaVersion: 1 as const,
      logId,
      expectedRevision: 1,
      confirmation: 'user_confirmed' as const,
      values: { ...values, state: 'stopped' as const, holdSeconds: 12, reason: 'Discomfort' },
    };
    const results = await Promise.allSettled([
      repo.correctLog(athlete, { ...correction, idempotencyKey: randomUUID() }),
      repo.correctLog(athlete, { ...correction, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const current = await repo.readLog(athlete, logId);
    expect(current?.status).toBe('active');
    if (current?.status === 'active') {
      expect(current.current.state).toBe('stopped');
      expect(current.current.reason).toBe('Discomfort');
      expect(current.current.revision).toBe(2);
    }
  });
  it('never replays an old active receipt after an explicit log tombstone', async () => {
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    const id = randomUUID();
    const created = {
      schemaVersion: 1 as const,
      logId: id,
      idempotencyKey: randomUUID(),
      confirmation: 'user_confirmed' as const,
      values,
    };
    await repo.createLog(athlete, created);
    const corrected = {
      ...created,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      values: { ...values, holdSeconds: 26 },
    };
    await repo.correctLog(athlete, corrected);
    const deleted = await repo.deleteLog(athlete, {
      schemaVersion: 1,
      logId: id,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      confirmed: true,
      reason: 'User removed entry',
    });
    expect(deleted.status).toBe('deleted');
    await expect(repo.createLog(athlete, created)).rejects.toThrow('REVISION_CONFLICT');
    await expect(repo.correctLog(athlete, corrected)).rejects.toThrow('REVISION_CONFLICT');
    expect(await repo.readLog(athlete, id)).toEqual(deleted);
    const revisions = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM stretching_log_revision WHERE athlete_id=$1 AND log_id=$2',
        [athlete, id],
      ),
    );
    expect(revisions.rows[0]?.['total']).toBe(3);
  });
  it('blocks new actual after latest version withdrawal but retains history, then purges on Activity deletion', async () => {
    const withdrawnId = randomUUID();
    await database.tenant(athlete, async (tx) => {
      await tx.query(
        `INSERT INTO supplementary_exercise_version
         (athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json)
         VALUES($1,$2,$3,2,$4,1,$5,$6::jsonb)`,
        [
          athlete,
          exerciseId,
          withdrawnId,
          versionId,
          now,
          JSON.stringify({
            ...definition,
            versionId: withdrawnId,
            reviewState: 'withdrawn',
            createdAt: now,
          }),
        ],
      );
      await tx.query(
        'UPDATE supplementary_exercise_head SET version=2,version_id=$3 WHERE athlete_id=$1 AND exercise_id=$2',
        [athlete, exerciseId, withdrawnId],
      );
    });
    const repo = createStretchingRepository(database, { now: () => new Date(now) });
    await expect(
      repo.createLog(athlete, {
        schemaVersion: 1,
        logId: randomUUID(),
        idempotencyKey: randomUUID(),
        confirmation: 'user_confirmed',
        values,
      }),
    ).rejects.toThrow('EXERCISE_WITHDRAWN');
    expect((await repo.readLog(athlete, logId))?.status).toBe('active');
    await database.tenant(athlete, (tx) =>
      tx.query(
        'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
        [athlete, activityId],
      ),
    );
    expect(await repo.readLog(athlete, logId)).toBeNull();
    const rows = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT count(*)::int AS total FROM stretching_log WHERE athlete_id=$1 AND activity_id=$2',
        [athlete, activityId],
      ),
    );
    expect(rows.rows[0]?.['total']).toBe(0);
  });
});
