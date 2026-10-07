import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  CreateRecoveryActionRequest,
  RecoveryStrategyDraft,
} from '@workout/contracts/recovery-core';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantNutritionCore,
  grantSupplementaryCore,
  grantOperations,
  grantCorePlanning,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { planDraftSchema } from '@workout/contracts/planning';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { createRecoveryRepository, RecoveryReferenceError } from '../src/recovery-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'];
if (!adminUrl || !runtimeUrl || !ownerUrl)
  throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
// Protected maintenance uses the actual plain schema owner; admin remains inspector.
const maintenanceOwner = new Pool({ connectionString: ownerUrl });
let database: Database;
let restoreGeneration: string;

beforeAll(async () => {
  await migrate(adminUrl);
  const ownerIdentity = await maintenanceOwner.query(`SELECT
    current_user=pg_get_userbyid(relowner) AS owner_matches,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unsafe
    FROM pg_class WHERE oid='public.restore_generation'::regclass`);
  expect(ownerIdentity.rows).toEqual([{ owner_matches: true, unsafe: false }]);
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
  // App admission reads this tenant-scoped head; no new write privilege is needed.
  await admin.query('GRANT SELECT ON consent TO workout_runtime');
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
  await admin.query(
    'GRANT EXECUTE ON FUNCTION public.current_restore_generation() TO workout_runtime',
  );
  await grantOperations(adminUrl, 'workout_runtime');
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantSupplementaryCore(adminUrl, 'workout_runtime');
  // Use the actual public planning composition; private association ledger is
  // never granted. The composer grants only its narrow reader when installed.
  await grantCorePlanning(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
  restoreGeneration = (await admin.query('SELECT public.current_restore_generation() AS id'))
    .rows[0]?.id as string;
});
afterAll(async () => {
  await database?.close();
  await maintenanceOwner.end();
  await admin.end();
});

// Explicit synthetic app processing permission for the existing tenant fixture.
// Direct fixture setup preserves the original command/outbox assertions.
async function grantAppPurpose(athleteId: string): Promise<void> {
  await admin.query(
    "WITH scope AS MATERIALIZED (SELECT set_config('app.athlete_id',$1,true)) INSERT INTO consent(athlete_id,kind,granted,revision) SELECT $1,'app',true,1 FROM scope",
    [athleteId],
  );
}

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
  await grantAppPurpose(owner);
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
  await grantAppPurpose(other);
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
    restoreGeneration,
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
  expect('restoreGeneration' in saved).toBe(false);
  expect(saved.durationSeconds).toBeNull();
  expect(await repo.createAction(owner, action)).toEqual(saved);
  try {
    await maintenanceOwner.query('SELECT public.rotate_restore_generation()');
    await expect(repo.createAction(owner, action)).rejects.toMatchObject({
      code: 'STALE_RESTORE_GENERATION',
    });
    expect((await repo.workspace(owner)).actions).toHaveLength(1);
  } finally {
    await maintenanceOwner.query(
      'UPDATE public.restore_generation SET generation_id=$1 WHERE singleton=true',
      [restoreGeneration],
    );
  }
  await expect(
    repo.createAction(other, {
      ...action,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(RecoveryReferenceError);
  const { restoreGeneration: _generation, ...correctionFields } = action;
  void _generation;
  const correctionCommand = {
    ...correctionFields,
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
      ...correctionFields,
      actionId: saved.actionId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const deletionCommand = {
    actionId: saved.actionId,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  };
  const removed = await repo.deleteAction(owner, deletionCommand);
  expect(await repo.deleteAction(owner, deletionCommand)).toEqual(removed);
  const deletionEvents = await admin.query(
    `SELECT event_id,target_id,actual_deletion_revision,occurred_at,to_jsonb(e) AS event
     FROM restore_suppression_event e
     WHERE athlete_id=$1 AND kind='recovery_action_deleted'`,
    [owner],
  );
  expect(deletionEvents.rows).toHaveLength(1);
  expect(deletionEvents.rows[0]).toMatchObject({
    event_id: expect.any(String),
    target_id: saved.actionId,
    actual_deletion_revision: 3,
    occurred_at: new Date(removed.deletedAt),
  });
  const eventJson = JSON.stringify(deletionEvents.rows[0]?.event);
  expect(eventJson).not.toContain(deletionCommand.idempotencyKey);
  expect(eventJson).not.toContain('Prepared for sleep');
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
  expect(
    (
      await admin.query(
        `SELECT event_id FROM restore_suppression_event
         WHERE athlete_id=$1 AND kind='recovery_action_deleted'`,
        [owner],
      )
    ).rows,
  ).toEqual([{ event_id: deletionEvents.rows[0]?.event_id }]);
});

const trainingDraft = planDraftSchema.parse({
  title: 'Recovery linked training',
  timezone: 'UTC',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: 'Season',
      startDate: '2026-09-18',
      endDateExclusive: '2026-09-21',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    },
  ],
  sessions: [],
});
async function planFixture() {
  const athleteId = randomUUID();
  await grantAppPurpose(athleteId);
  const planning = createPlanningRepository(database);
  const snapshot = await planning.save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: trainingDraft,
  });
  const head = await database.tenant(athleteId, (tx) =>
    tx.query('SELECT aggregate_id,version_id FROM plan_head WHERE athlete_id=$1', [athleteId]),
  );
  const row = z.strictObject({ aggregate_id: z.uuid(), version_id: z.uuid() }).parse(head.rows[0]);
  expect(row.version_id).toBe(snapshot.id);
  expect(row.aggregate_id).not.toBe(snapshot.id);
  const recovery = createRecoveryRepository(database);
  const method = await recovery.createMethod(athleteId, {
    title: 'Rest record',
    category: 'rest',
    intendedUse: 'User record',
    applicability: [],
    cautions: [],
    sourceDescription: '',
    evidenceLimitations: 'Unreviewed',
    idempotencyKey: randomUUID(),
  });
  const prepared = draft(randomUUID(), method.versionId);
  prepared.observations = [];
  prepared.planRefs = [
    { kind: 'training', aggregateId: row.aggregate_id, headVersionId: snapshot.id },
  ];
  return { athleteId, planning, snapshot, aggregateId: row.aggregate_id, recovery, prepared };
}
it('accepts actual public aggregate identity and distinguishes current from historical training version', async () => {
  const f = await planFixture();
  const saved = await f.recovery.createStrategy(f.athleteId, {
    draft: f.prepared,
    idempotencyKey: randomUUID(),
  });
  expect(saved.draft.planRefs).toEqual(f.prepared.planRefs);
  const latest = await f.planning.save(f.athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.snapshot.id,
    idempotencyKey: randomUUID(),
    draft: { ...trainingDraft, title: 'Next revision' },
  });
  await expect(
    f.recovery.createStrategy(f.athleteId, { draft: f.prepared, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await f.recovery.workspace(f.athleteId)).planRefs).toContainEqual({
    reference: f.prepared.planRefs[0],
    state: 'changed',
  });
  expect((await f.recovery.readStrategy(f.athleteId, saved.strategyId))?.draft.planRefs).toEqual(
    f.prepared.planRefs,
  );
  const canonical = {
    ...f.prepared,
    planRefs: [{ kind: 'training' as const, aggregateId: f.aggregateId, headVersionId: latest.id }],
  };
  await expect(
    f.recovery.createStrategy(f.athleteId, { draft: canonical, idempotencyKey: randomUUID() }),
  ).resolves.toMatchObject({ draft: { planRefs: canonical.planRefs } });
});
it('keeps separate tenant aggregates and rejects foreign aggregate paired with owned snapshot', async () => {
  const own = await planFixture(),
    foreign = await planFixture();
  expect(own.aggregateId).not.toBe(foreign.aggregateId);
  await expect(
    own.recovery.createStrategy(own.athleteId, {
      draft: own.prepared,
      idempotencyKey: randomUUID(),
    }),
  ).resolves.toMatchObject({ draft: { planRefs: own.prepared.planRefs } });
  await expect(
    foreign.recovery.createStrategy(foreign.athleteId, {
      draft: foreign.prepared,
      idempotencyKey: randomUUID(),
    }),
  ).resolves.toMatchObject({ draft: { planRefs: foreign.prepared.planRefs } });
  await expect(
    own.recovery.createStrategy(own.athleteId, {
      draft: {
        ...own.prepared,
        planRefs: [
          { kind: 'training', aggregateId: foreign.aggregateId, headVersionId: own.snapshot.id },
        ],
      },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  await expect(
    own.recovery.createStrategy(own.athleteId, {
      draft: {
        ...own.prepared,
        planRefs: [
          { kind: 'training', aggregateId: own.aggregateId, headVersionId: foreign.snapshot.id },
        ],
      },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('rejects snapshot-as-aggregate on new public writes without altering existing legacy read bytes', async () => {
  const f = await planFixture();
  const legacyDraft = {
    ...f.prepared,
    planRefs: [
      { kind: 'training' as const, aggregateId: f.snapshot.id, headVersionId: f.snapshot.id },
    ],
  };
  await expect(
    f.recovery.createStrategy(f.athleteId, { draft: legacyDraft, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  // Explicit owner-offline historical compatibility fixture. It is not a new
  // public command or an approval witness; no production guard is disabled.
  const legacy = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: randomUUID(),
    versionId: randomUUID(),
    version: 1,
    previousVersionId: null,
    status: 'draft',
    selectedOptionId: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    draft: legacyDraft,
  });
  const client = await maintenanceOwner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [f.athleteId]);
    await client.query(
      'INSERT INTO recovery_strategy_version(athlete_id,strategy_id,version_id,version,previous_version,previous_version_id,record_json) VALUES($1,$2,$3,1,NULL,NULL,$4::jsonb)',
      [f.athleteId, legacy.strategyId, legacy.versionId, JSON.stringify(legacy)],
    );
    await client.query(
      'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
      [f.athleteId, legacy.strategyId, legacy.versionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect(await f.recovery.readStrategy(f.athleteId, legacy.strategyId)).toEqual(legacy);
});
