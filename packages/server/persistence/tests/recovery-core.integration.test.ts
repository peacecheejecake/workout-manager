import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  CreateRecoveryActionRequest,
  RecoveryStrategyDraft,
} from '@workout/contracts/recovery-core';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { createRecoveryRepository, RecoveryReferenceError } from '../src/recovery-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  // This isolated task worktree precedes 023/024. The root integrator registers
  // 025 in migrate.ts after merging the three tasks.
  const installed = await admin.query(
    "SELECT to_regclass('public.recovery_method_version') AS name",
  );
  if (installed.rows[0]?.name === null) {
    const sql = await readFile(
      new URL('../migrations/025_recovery_core.sql', import.meta.url),
      'utf8',
    );
    await admin.query(sql);
  }
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT ON recovery_method_version,recovery_strategy_version,recovery_action_revision TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE ON recovery_method_head,recovery_strategy_head,recovery_action_log TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON check_in,activity_canonical,intake_entry,plan_head,plan_snapshot,nutrition_plan_head,tenant_erasure TO workout_runtime',
  );
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

async function createCheckIn(athleteId: string, id: string) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await client.query(
      `INSERT INTO check_in(athlete_id,id,revision,values_json,local_date)
       VALUES($1,$2,1,'{}'::jsonb,'2026-09-18')`,
      [athleteId, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function draft(checkInId: string, methodVersionId: string): RecoveryStrategyDraft {
  return {
    title: 'Pause then review',
    goal: 'Compare rest with existing plan',
    startDate: '2026-09-18',
    endDateExclusive: '2026-09-21',
    timezone: 'UTC',
    knownFacts: ['User reported a change'],
    missingInformation: ['Follow-up check-in'],
    priority: 'normal',
    observations: [{ kind: 'check_in', id: checkInId, revision: 1 }],
    planRefs: [],
    options: [
      {
        id: randomUUID(),
        title: 'Full rest',
        kind: 'full_rest',
        methodVersionId: null,
        explanation: 'No new activity',
      },
      {
        id: randomUUID(),
        title: 'Optional recorded action',
        kind: 'nonexercise_action',
        methodVersionId,
        explanation: 'Only if selected',
      },
    ],
    reassessment: [
      {
        id: randomUUID(),
        trigger: 'scheduled_checkin',
        plannedAt: '2026-09-20T00:00:00.000Z',
        description: 'Review',
        policyVersion: null,
      },
      {
        id: randomUUID(),
        trigger: 'user_report_changed',
        plannedAt: null,
        description: 'Check-in revision',
        policyVersion: null,
      },
    ],
  };
}

it('keeps rest selection separate from actuals and enforces tenant ownership, revisions and replay', async () => {
  const owner = 'recovery-owner-' + randomUUID();
  const other = 'recovery-other-' + randomUUID();
  const checkInId = randomUUID();
  await createCheckIn(owner, checkInId);
  const repo = createRecoveryRepository(database, {
    now: () => new Date('2026-09-19T00:00:00.000Z'),
  });
  const methodCommand = {
    title: 'Manual rest record',
    category: 'rest' as const,
    intendedUse: 'Personal tracking only',
    applicability: [],
    cautions: [],
    sourceDescription: 'User input',
    evidenceLimitations: 'Not reviewed for efficacy',
    idempotencyKey: randomUUID(),
  };
  const method = await repo.createMethod(owner, methodCommand);
  expect(method.reviewState).toBe('unreviewed');
  expect(await repo.createMethod(owner, methodCommand)).toEqual(method);
  await expect(repo.createMethod(other, methodCommand)).resolves.toMatchObject({
    reviewState: 'unreviewed',
  });
  const prepared = draft(checkInId, method.versionId);
  const create = { draft: prepared, idempotencyKey: randomUUID() };
  const [strategy, concurrentReplay] = await Promise.all([
    repo.createStrategy(owner, create),
    repo.createStrategy(owner, create),
  ]);
  expect(concurrentReplay).toEqual(strategy);
  expect(strategy.status).toBe('draft');
  expect(strategy.selectedOptionId).toBeNull();
  expect(await repo.createStrategy(owner, create)).toEqual(strategy);
  await expect(
    repo.createStrategy(other, {
      draft: { ...prepared, observations: [] },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  const rest = prepared.options[0];
  if (!rest) throw new Error('REST_OPTION_MISSING');
  const confirmation = {
    strategyId: strategy.strategyId,
    expectedHeadVersionId: strategy.versionId,
    selectedOptionId: rest.id,
    idempotencyKey: randomUUID(),
  };
  const confirmed = await repo.confirmStrategy(owner, confirmation);
  expect(confirmed.status).toBe('user_confirmed');
  expect(confirmed.selectedOptionId).toBe(rest.id);
  expect(await repo.confirmStrategy(owner, confirmation)).toEqual(confirmed);
  expect(await repo.readStrategy(owner, strategy.strategyId)).toEqual(confirmed);
  expect(await repo.readStrategy(other, strategy.strategyId)).toBeNull();
  expect((await repo.workspace(owner)).actions).toEqual([]);
  const noActionBefore = await database.tenant(owner, (tx) =>
    tx.query('SELECT count(*)::integer AS count FROM activity_canonical WHERE athlete_id=$1', [
      owner,
    ]),
  );
  expect(noActionBefore.rows[0]?.['count']).toBe(0);
  const action: CreateRecoveryActionRequest = {
    methodVersionId: method.versionId,
    strategyVersionId: null,
    plannedOptionId: null,
    occurredAt: '2026-09-18T21:00:00.000Z',
    timezone: 'UTC',
    state: 'performed',
    durationSeconds: null,
    actualConditions: 'Quiet time',
    beforeCheckIn: { kind: 'check_in', id: checkInId, revision: 1 },
    afterCheckIn: null,
    discomfort: '',
    userNotes: 'Prepared for sleep, sleep itself not measured',
    source: 'user_confirmed',
    idempotencyKey: randomUUID(),
  };
  const unselectedAction = prepared.options[1];
  if (!unselectedAction) throw new Error('ACTION_OPTION_MISSING');
  await expect(
    repo.createAction(owner, {
      ...action,
      strategyVersionId: confirmed.versionId,
      plannedOptionId: unselectedAction.id,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'OPTION_LINK_INVALID' });
  const saved = await repo.createAction(owner, action);
  expect(saved.durationSeconds).toBeNull();
  expect(await repo.createAction(owner, action)).toEqual(saved);
  await expect(
    repo.createAction(other, {
      ...action,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(RecoveryReferenceError);
  const correctionCommand = {
    ...action,
    actionId: saved.actionId,
    expectedRevision: 1,
    state: 'partial',
    userNotes: 'Corrected personal report',
    idempotencyKey: randomUUID(),
  } as const;
  const corrected = await repo.correctAction(owner, correctionCommand);
  expect(corrected.revision).toBe(2);
  await expect(
    repo.correctAction(owner, {
      ...action,
      actionId: saved.actionId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const removed = await repo.deleteAction(owner, {
    actionId: saved.actionId,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(removed.status).toBe('deleted');
  expect((await repo.workspace(owner)).actions).toEqual([removed]);
  await expect(repo.createAction(owner, action)).rejects.toMatchObject({
    code: 'ACTION_NOT_FOUND',
  });
  await expect(repo.correctAction(owner, correctionCommand)).rejects.toMatchObject({
    code: 'ACTION_NOT_FOUND',
  });
  const noActionAfter = await database.tenant(owner, (tx) =>
    tx.query('SELECT count(*)::integer AS count FROM activity_canonical WHERE athlete_id=$1', [
      owner,
    ]),
  );
  expect(noActionAfter.rows[0]?.['count']).toBe(0);

  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
    await client.query(
      `UPDATE check_in SET revision=2,updated_at=clock_timestamp()
       WHERE athlete_id=$1 AND id=$2`,
      [owner, checkInId],
    );
    await client.query(
      `INSERT INTO check_in_revision(athlete_id,check_in_id,revision,values_json,reason)
       VALUES($1,$2,2,'{}'::jsonb,'user_correction')`,
      [owner, checkInId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const afterCorrection = await repo.workspace(owner);
  expect(afterCorrection.observations).toContainEqual({
    reference: { kind: 'check_in', id: checkInId, revision: 1 },
    state: 'revised',
  });
  expect(afterCorrection.reassessment.some((item) => item.reason === 'observation_changed')).toBe(
    true,
  );
  await expect(
    repo.createStrategy(owner, { draft: prepared, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

  const eraser = await admin.connect();
  try {
    await eraser.query('BEGIN');
    await eraser.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
    await eraser.query('SELECT public.erase_account($1)', [owner]);
    const remaining = await eraser.query(
      `SELECT
         (SELECT count(*) FROM recovery_method_version WHERE athlete_id=$1) AS methods,
         (SELECT count(*) FROM recovery_strategy_version WHERE athlete_id=$1) AS strategies,
         (SELECT count(*) FROM recovery_action_revision WHERE athlete_id=$1) AS actions`,
      [owner],
    );
    expect(remaining.rows[0]).toMatchObject({ methods: '0', strategies: '0', actions: '0' });
    await eraser.query('COMMIT');
  } catch (error) {
    await eraser.query('ROLLBACK');
    throw error;
  } finally {
    eraser.release();
  }
});
