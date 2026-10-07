import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accountExportSchema } from '@workout/contracts/operations';
import type { RoutineBlueprintVersion, IntegratedApprovalV023 } from '@workout/contracts/routines';
import type { RecoveryStrategyDraft } from '@workout/contracts/recovery-core';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRoutineCore,
  grantRecoveryCore,
  grantIntegratedApprovalV4,
  grantCoachingThreads,
  grantCoachingConstraints,
  grantCoreEvidenceSnapshots,
  grantCheckIns,
  grantSessionCompletions,
} from '../src/migrate.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createOperationsRepository } from '../src/operations.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createIntegratedApprovalV4Repository } from '../src/integrated-approval-v4.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Actual producer/SQL boundaries; no provider, positive restore seed or admission reopen.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `generic_export_${suffix}`;
const ownerRole = `generic_owner_${suffix}`;
const runtimeRole = `generic_app_${suffix}`;
const exportRole = `generic_reader_${suffix}`;
const roles: string[] = [];
let created = false;
let owner: Pool;
let runtime: Database;
let reader: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, exportRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  for (const grant of [
    grantCorePlanning,
    grantOperations,
    grantRoutineCore,
    grantRecoveryCore,
    grantIntegratedApprovalV4,
    grantCoachingThreads,
    grantCoachingConstraints,
    grantCoreEvidenceSnapshots,
    grantCheckIns,
    grantSessionCompletions,
  ])
    await grant(url(ownerRole), runtimeRole);
  // Export gets only the real operations helper, never the domain writer grants.
  await grantOperations(url(ownerRole), exportRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 2 });
  runtime = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  reader = createDatabase({ connectionString: url(exportRole), max: 2 });
  const result = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole, exportRole]],
  );
  expect(result.rows).toHaveLength(3);
  for (const role of result.rows) expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  expect(
    (await owner.query('SELECT count(*)::int count,max(version) latest FROM schema_migrations'))
      .rows,
  ).toEqual([{ count: 107, latest: 107 }]);
});
afterAll(async () => {
  await runtime?.close();
  await reader?.close();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athlete,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function permission(athlete: string, kind: 'app' | 'ai', granted: boolean) {
  const consent = createConsentRepository(runtime);
  const current = await consent.getConsent(athlete, kind);
  return consent.setConsent(athlete, {
    kind,
    granted,
    expectedRevision: current.revision,
    idempotencyKey: randomUUID(),
  });
}
async function athlete() {
  const id = randomUUID();
  await permission(id, 'app', true);
  return id;
}
function blueprint(
  routineId: string = randomUUID(),
  versionId: string = randomUUID(),
  prompt = 'Synthetic checklist',
): RoutineBlueprintVersion {
  return {
    schemaVersion: 4,
    routineId,
    versionId,
    title: 'Synthetic routine',
    intent: 'Manual selection',
    status: 'published',
    tags: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-07T00:00:00.000Z',
    steps: [
      {
        id: randomUUID(),
        title: 'Synthetic step',
        content: { kind: 'checklist', prompt },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
  };
}
const fields = [
  'genericRoutineBlueprintVersions',
  'genericRoutineBlueprintHeads',
  'genericRoutineScheduleVersions',
  'genericRoutineScheduleHeads',
  'genericRoutineOccurrences',
  'genericRoutineRuns',
  'genericRoutineRunRevisions',
  'genericRoutineChecklistConfirmations',
  'genericRoutineStepTimers',
  'recoveryMethodVersions',
  'recoveryMethodHeads',
  'recoveryStrategyVersions',
  'recoveryStrategyHeads',
  'recoveryActions',
  'recoveryActionRevisions',
  'recoveryStrategyHistory',
  'genericRoutineScheduleHistory',
  'referencedIntegratedApprovalFacts',
] as const;
async function exported(id: string, db: Database = reader) {
  const artifact = accountExportSchema.parse(
    await createOperationsRepository(db).exportAccount(id),
  );
  expect(artifact.schemaVersion).toBe(34);
  if (artifact.schemaVersion !== 34) throw new Error('EXPECTED_EXPORT34');
  return artifact;
}
async function producers(id: string) {
  const routine = createRoutineRepository(runtime);
  const first = blueprint();
  const save = {
    blueprint: first,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  expect(await routine.saveBlueprint(id, save)).toEqual(await routine.saveBlueprint(id, save));
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: first.routineId, versionId: first.versionId },
      window: {
        startDate: '2080-01-01',
        endDateExclusive: '2080-01-03',
        timezone: 'UTC',
        maxOccurrences: 2,
      },
      rule: { kind: 'dates' as const, dates: ['2080-01-01'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: null,
  };
  const preview = await routine.previewSchedule(id, scheduleInput);
  const approve = {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  const schedule = await routine.approveSchedule(id, approve);
  expect(await routine.approveSchedule(id, approve)).toEqual(schedule);
  const occurrence = z.uuid().parse(schedule.occurrences[0]?.id);
  const start = {
    runId: randomUUID(),
    blueprintVersionId: first.versionId,
    occurrenceId: occurrence,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  const initial = await routine.startRun(id, start);
  expect(initial.run.revision).toBe(0);
  expect(await routine.startRun(id, start)).toEqual(initial);
  const stepId = z.string().parse(first.steps[0]?.id);
  const record = {
    runId: initial.run.id,
    stepId,
    state: 'performed' as const,
    actualRefs: [],
    occurredAt: '2026-10-07T00:00:00.000Z',
    reason: null,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  const recorded = await routine.recordStep(id, record);
  expect(await routine.recordStep(id, record)).toEqual(recorded);
  let timer = await routine.commandTimer(id, {
    runId: initial.run.id,
    stepId,
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  timer = await routine.commandTimer(id, {
    runId: initial.run.id,
    stepId,
    action: 'pause',
    durationSeconds: null,
    expectedRevision: timer.revision,
    idempotencyKey: randomUUID(),
  });
  timer = await routine.commandTimer(id, {
    runId: initial.run.id,
    stepId,
    action: 'resume',
    durationSeconds: null,
    expectedRevision: timer.revision,
    idempotencyKey: randomUUID(),
  });
  timer = await routine.commandTimer(id, {
    runId: initial.run.id,
    stepId,
    action: 'clear',
    durationSeconds: null,
    expectedRevision: timer.revision,
    idempotencyKey: randomUUID(),
  });
  const pausedRun = await routine.changeRun(id, {
    runId: initial.run.id,
    action: 'pause',
    expectedRevision: recorded.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const resumedRun = await routine.changeRun(id, {
    runId: initial.run.id,
    action: 'resume',
    expectedRevision: pausedRun.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const stopped = await routine.changeRun(id, {
    runId: initial.run.id,
    action: 'stop',
    expectedRevision: resumedRun.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const muted = await routine.changeSchedule(id, {
    scheduleId: schedule.schedule.id,
    action: 'mute',
    expectedVersionId: schedule.schedule.versionId,
    previewDigest: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(muted.notificationMuted).toBe(true);
  const pausedSchedule = await routine.changeSchedule(id, {
    scheduleId: schedule.schedule.id,
    action: 'pause',
    expectedVersionId: muted.schedule.versionId,
    previewDigest: muted.impactDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const manual = await routine.startRun(id, {
    runId: randomUUID(),
    blueprintVersionId: first.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const newer = blueprint(first.routineId);
  await routine.saveBlueprint(id, {
    blueprint: newer,
    expectedVersionId: first.versionId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const unresolvedInput = {
    ...scheduleInput,
    schedule: {
      ...scheduleInput.schedule,
      id: randomUUID(),
      versionId: randomUUID(),
      rule: { kind: 'dates' as const, dates: ['2080-01-02'], localTime: null },
    },
  };
  const unresolvedPreview = await routine.previewSchedule(id, unresolvedInput);
  const unresolved = await routine.approveSchedule(id, {
    ...unresolvedInput,
    previewDigest: unresolvedPreview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(unresolved.occurrences[0]?.scheduledAt).toBeNull();
  const recovery = createRecoveryRepository(runtime, {
    now: () => new Date('2026-10-08T00:00:00.000Z'),
  });
  const methodInput = {
    title: 'Synthetic rest',
    category: 'rest' as const,
    intendedUse: 'Personal tracking',
    applicability: [],
    cautions: [],
    sourceDescription: 'User entered',
    evidenceLimitations: 'Unreviewed',
    idempotencyKey: randomUUID(),
  };
  const method = await recovery.createMethod(id, methodInput);
  expect(await recovery.createMethod(id, methodInput)).toEqual(method);
  const option = randomUUID();
  const draft: RecoveryStrategyDraft = {
    title: 'Synthetic strategy',
    goal: 'Personal recording',
    startDate: '2026-10-07',
    endDateExclusive: '2026-10-09',
    timezone: 'UTC',
    knownFacts: [],
    missingInformation: [],
    priority: 'normal',
    observations: [],
    planRefs: [],
    options: [
      {
        id: option,
        title: 'Record rest',
        kind: 'nonexercise_action',
        methodVersionId: method.versionId,
        explanation: 'Explicit only',
      },
    ],
    reassessment: [
      {
        id: randomUUID(),
        trigger: 'plan_changed',
        plannedAt: null,
        description: 'Synthetic review',
        policyVersion: null,
      },
    ],
  };
  const strategy = await recovery.createStrategy(id, { draft, idempotencyKey: randomUUID() });
  const confirmed = await recovery.confirmStrategy(id, {
    strategyId: strategy.strategyId,
    expectedHeadVersionId: strategy.versionId,
    selectedOptionId: option,
    idempotencyKey: randomUUID(),
  });
  const generation = await runtime.tenant(id, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const actionInput = {
    restoreGeneration: generation,
    methodVersionId: method.versionId,
    strategyVersionId: confirmed.versionId,
    plannedOptionId: option,
    occurredAt: '2026-10-07T00:00:00.000Z',
    timezone: 'UTC',
    state: 'performed' as const,
    durationSeconds: null,
    actualConditions: 'Synthetic',
    beforeCheckIn: null,
    afterCheckIn: null,
    discomfort: '',
    userNotes: 'Synthetic report',
    source: 'user_confirmed' as const,
    idempotencyKey: randomUUID(),
  };
  const action = await recovery.createAction(id, actionInput);
  expect(await recovery.createAction(id, actionInput)).toEqual(action);
  const { restoreGeneration: _generation, ...correction } = actionInput;
  void _generation;
  const corrected = await recovery.correctAction(id, {
    ...correction,
    actionId: action.actionId,
    expectedRevision: 1,
    durationSeconds: 0,
    idempotencyKey: randomUUID(),
  });
  const deletion = { actionId: action.actionId, expectedRevision: 2, idempotencyKey: randomUUID() };
  const deleted = await recovery.deleteAction(id, deletion);
  expect(await recovery.deleteAction(id, deletion)).toEqual(deleted);
  return {
    first,
    newer,
    schedule,
    pausedSchedule,
    unresolved,
    initial,
    stopped,
    manual,
    timer,
    method,
    strategy,
    confirmed,
    action,
    corrected,
    deleted,
    save,
  };
}
it('exports exactly eighteen empty arrays for an empty own tenant', async () => {
  const result = await exported(randomUUID());
  for (const field of fields) expect(result.data[field]).toEqual([]);
});
it('exports actual producer bodies, frozen origins, null/zero and retained tombstone history without synthetic activity', async () => {
  const id = await athlete();
  const facts = await producers(id);
  const result = await exported(id);
  expect(result.data.genericRoutineBlueprintVersions.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([facts.first, facts.newer]),
  );
  expect(result.data.genericRoutineScheduleVersions.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([
      facts.schedule.schedule,
      facts.pausedSchedule.schedule,
      facts.unresolved.schedule,
    ]),
  );
  expect(result.data.genericRoutineOccurrences.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([...facts.schedule.occurrences, ...facts.unresolved.occurrences]),
  );
  expect(result.data.genericRoutineRuns.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([facts.stopped.run, facts.manual.run]),
  );
  expect(result.data.genericRoutineRunRevisions.map((v) => v.record_json)).toContainEqual(
    facts.initial.run,
  );
  expect(result.data.genericRoutineChecklistConfirmations).toHaveLength(1);
  expect(result.data.genericRoutineStepTimers).toHaveLength(1);
  expect(result.data.recoveryMethodVersions.map((v) => v.record_json)).toContainEqual(facts.method);
  expect(result.data.recoveryStrategyVersions.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([facts.strategy, facts.confirmed]),
  );
  expect(result.data.recoveryActions).toMatchObject([
    { action_id: facts.action.actionId, revision: 3, status: 'deleted' },
  ]);
  expect(result.data.recoveryActionRevisions.map((v) => v.record_json)).toEqual(
    expect.arrayContaining([facts.action, facts.corrected, facts.deleted]),
  );
  expect(
    (
      await runtime.tenant(id, (tx) =>
        tx.query('SELECT count(*)::int count FROM activity_canonical WHERE athlete_id=$1', [id]),
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(result.data.genericRoutineBlueprintHeads).toEqual([
    {
      routine_id: facts.first.routineId,
      version_id: facts.newer.versionId,
      version: 2,
      favorite: false,
      visibility: 'active',
    },
  ]);
  expect(result.data.recoveryMethodHeads).toEqual([
    { method_id: facts.method.methodId, version_id: facts.method.versionId, version: 1 },
  ]);
  expect(result.data.recoveryStrategyHeads).toEqual([
    { strategy_id: facts.strategy.strategyId, version_id: facts.confirmed.versionId, version: 2 },
  ]);
  expect(result.data.genericRoutineScheduleHeads).toEqual(
    expect.arrayContaining([
      {
        schedule_id: facts.schedule.schedule.id,
        version_id: facts.pausedSchedule.schedule.versionId,
        notification_muted: true,
      },
    ]),
  );
  const before = result.data;
  await permission(id, 'ai', true);
  await permission(id, 'ai', false);
  await permission(id, 'app', false);
  const after = await exported(id);
  for (const field of fields) expect(after.data[field]).toEqual(before[field]);
  const receiptsBefore = await runtime.tenant(
    id,
    async (tx) =>
      (
        await tx.query(
          'SELECT (SELECT count(*)::int FROM routine_command_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1) outbox',
          [id],
        )
      ).rows,
  );
  expect(await createRoutineRepository(runtime).saveBlueprint(id, facts.save)).toEqual(
    expect.objectContaining({ blueprint: facts.first }),
  );
  expect(
    await runtime.tenant(
      id,
      async (tx) =>
        (
          await tx.query(
            'SELECT (SELECT count(*)::int FROM routine_command_receipt WHERE athlete_id=$1) receipts,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1) outbox',
            [id],
          )
        ).rows,
    ),
  ).toEqual(receiptsBefore);
});
it('preserves canonical bigint strings through export, separately labeled owner numeric-boundary maintenance', async () => {
  const id = await athlete();
  const facts = await producers(id);
  const stepId = z.string().parse(facts.first.steps[0]?.id);
  const routine = createRoutineRepository(runtime);
  const timer = await routine.commandTimer(id, {
    runId: facts.manual.run.id,
    stepId,
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  expect(timer.state).toBe('running');
  for (const value of ['0', '9007199254740991', '9007199254740992', '9223372036854775807']) {
    // Public start created this running own timer. Owner-only numeric maintenance
    // preserves its time/state/body and advances revision with nondecreasing pause size.
    const changed = await owned(id, (client) =>
      client.query(
        'UPDATE routine_step_timer SET paused_milliseconds=$4::bigint,revision=revision+1 WHERE athlete_id=$1 AND run_id=$2 AND step_id=$3 RETURNING revision',
        [id, facts.manual.run.id, stepId, value],
      ),
    );
    expect(changed.rowCount).toBe(1);
    const exportedTimers = (await exported(id)).data.genericRoutineStepTimers;
    const exactTimer = exportedTimers.filter(
      (row) => row.run_id === facts.manual.run.id && row.step_id === stepId,
    );
    expect(exactTimer).toHaveLength(1);
    expect(exactTimer[0]?.paused_milliseconds).toBe(value);
  }
});
it('keeps populated tenant exports isolated and denies SELECT-role writes and receipt reads', async () => {
  const alice = await athlete();
  const bob = await athlete();
  await producers(alice);
  await producers(bob);
  const first = await exported(alice);
  const second = await exported(bob);
  expect(first.data.genericRoutineBlueprintVersions[0]?.routine_id).not.toBe(
    second.data.genericRoutineBlueprintVersions[0]?.routine_id,
  );
  for (const table of [
    'routine_blueprint_version',
    'routine_blueprint_head',
    'routine_schedule_version',
    'routine_schedule_head',
    'routine_occurrence',
    'routine_run',
    'routine_run_revision',
    'routine_checklist_confirmation',
    'routine_step_timer',
    'recovery_method_version',
    'recovery_method_head',
    'recovery_strategy_version',
    'recovery_strategy_head',
    'recovery_action_log',
    'recovery_action_revision',
    'recovery_strategy_history',
    'routine_schedule_history',
  ]) {
    expect(
      (
        await reader.tenant(alice, (tx) =>
          tx.query(`SELECT count(*)::int count FROM ${table} WHERE athlete_id=$1`, [bob]),
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    for (const query of [
      `INSERT INTO ${table} DEFAULT VALUES`,
      `UPDATE ${table} SET athlete_id=athlete_id`,
      `DELETE FROM ${table}`,
    ])
      await expect(reader.tenant(alice, (tx) => tx.query(query))).rejects.toMatchObject({
        code: '42501',
      });
  }
  expect(
    (
      await owner.query(
        "SELECT count(*)::int count FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relname=ANY($1) AND a.grantee=0 AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')",
        [
          [
            'routine_blueprint_version',
            'routine_run',
            'recovery_action_revision',
            'integrated_approval_v4',
          ],
        ],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  for (const table of [
    'routine_command_receipt',
    'command_receipt',
    'restore_manual_review_source_replay_receipt',
  ])
    await expect(
      reader.tenant(alice, (tx) => tx.query(`SELECT 1 FROM ${table} LIMIT 1`)),
    ).rejects.toMatchObject({ code: '42501' });
  await expect(
    reader.tenant(alice, (tx) => tx.query('SELECT body FROM integrated_candidate_v4 LIMIT 1')),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    reader.tenant(alice, (tx) =>
      tx.query('SELECT public.erase_account_before_manual_review($1)', [alice]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await createOperationsRepository(runtime).eraseAccount(alice);
  await expect(exported(alice)).rejects.toThrow('ACCOUNT_ERASED');
  for (const field of fields) expect((await exported(bob)).data[field]).toEqual(second.data[field]);
  await owned(alice, async (client) => {
    for (const table of [
      'routine_blueprint_version',
      'routine_blueprint_head',
      'routine_schedule_version',
      'routine_schedule_head',
      'routine_occurrence',
      'routine_run',
      'routine_run_revision',
      'routine_checklist_confirmation',
      'routine_step_timer',
      'recovery_method_version',
      'recovery_method_head',
      'recovery_strategy_version',
      'recovery_strategy_head',
      'recovery_action_log',
      'recovery_action_revision',
      'recovery_strategy_history',
      'routine_schedule_history',
    ])
      expect(
        (
          await client.query(`SELECT count(*)::int count FROM ${table} WHERE athlete_id=$1`, [
            alice,
          ])
        ).rows,
      ).toEqual([{ count: 0 }]);
  });
});
it('exports only exact referenced committed integrated approval facts from the real capture/prepare/approve path', async () => {
  const id = await athlete();
  await permission(id, 'ai', true);
  const draft: PlanDraft = {
    title: 'Synthetic plan',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Synthetic',
      isPartial: false,
    })),
    sessions: [],
  };
  const plan = await createPlanningRepository(runtime).save(id, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    draft,
    idempotencyKey: randomUUID(),
  });
  // A public save allocates an aggregate UUID separately from its snapshot UUID.
  // Read the exact own stored tuple through the normal runtime SELECT privilege;
  // never infer aggregate identity or insert an owner-created replacement head.
  const trainingHead = await runtime.tenant(id, async (tx) => {
    const result = await tx.query(
      'SELECT aggregate_id,version_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2 LIMIT 2',
      [id, plan.id],
    );
    expect(result.rows).toHaveLength(1);
    return z.strictObject({ aggregate_id: z.uuid(), version_id: z.uuid() }).parse(result.rows[0]);
  });
  expect(trainingHead.version_id).toBe(plan.id);
  const thread = await createCoachingThreadRepository(runtime).create(id, {
    planVersionId: plan.id,
    title: 'Synthetic review',
    scope: { kind: 'block', targetId: 'block' },
    message: 'Review synthetic schedule',
    idempotencyKey: randomUUID(),
  });
  const first = blueprint();
  await createRoutineRepository(runtime).saveBlueprint(id, {
    blueprint: first,
    expectedVersionId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const evidence = await createCoreEvidenceSnapshotRepository(runtime).capture(
    id,
    thread.thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-02-01', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  if (evidence.status !== 'available') throw new Error('EXPECTED_OWN_AVAILABLE_EVIDENCE');
  const integrated = createIntegratedApprovalV4Repository(runtime, {
    policyVersion: 'generic-export-test',
  });
  const recoveryId = randomUUID();
  const scheduleId = randomUUID();
  const versionId = randomUUID();
  const optionId = randomUUID();
  const basis = await integrated.captureBasis(id, {
    evidenceSnapshotId: evidence.id,
    trainingAggregateId: trainingHead.aggregate_id,
    nutritionAggregateId: randomUUID(),
    recoveryAggregateId: recoveryId,
    routineScheduleAggregateId: scheduleId,
  });
  const occurrence = {
    id: randomUUID(),
    schedule: { id: scheduleId, versionId },
    blueprint: { id: first.routineId, versionId: first.versionId },
    anchorKey: 'date:2080-01-02',
    scheduledAt: '2080-01-02T08:00:00.000Z',
    timingStatus: 'resolved' as const,
    stepBindings: [],
    selectedChoices: {},
  };
  const candidate = await integrated.prepareInternal(id, {
    proposalId: randomUUID(),
    basis,
    writes: [
      {
        domain: 'recovery',
        aggregateId: recoveryId,
        selectedOptionId: optionId,
        proposed: {
          title: 'Synthetic full rest',
          goal: 'No new actual',
          startDate: '2080-01-01',
          endDateExclusive: '2080-01-03',
          timezone: 'UTC',
          knownFacts: [],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: [],
          options: [
            {
              id: optionId,
              title: 'Rest',
              kind: 'full_rest',
              methodVersionId: null,
              explanation: 'No actual fabrication',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              plannedAt: null,
              description: 'Synthetic review',
              policyVersion: null,
            },
          ],
        },
      },
      {
        domain: 'routine_schedule',
        aggregateId: scheduleId,
        sourcePlanVersionId: plan.id,
        proposed: {
          schemaVersion: 4,
          id: scheduleId,
          versionId,
          blueprint: { id: first.routineId, versionId: first.versionId },
          window: {
            startDate: '2080-01-01',
            endDateExclusive: '2080-01-03',
            timezone: 'UTC',
            maxOccurrences: 1,
          },
          rule: { kind: 'dates', dates: ['2080-01-02'], localTime: '08:00' },
          state: 'active',
        },
        occurrences: [occurrence],
      },
    ],
    summary: 'Synthetic explicit review',
    validation: { status: 'checked', errors: [], unknowns: [] },
    idempotencyKey: randomUUID(),
  });
  const command: IntegratedApprovalV023 = {
    schemaVersion: 4 as const,
    confirmed: true as const,
    proposalId: candidate.proposalId,
    candidateId: candidate.id,
    proposalDigest: candidate.digest,
    writeDomains: ['recovery', 'routine_schedule'],
    expectedBasis: candidate.basis,
    idempotencyKey: randomUUID(),
  };
  const committed = await integrated.approve(id, command);
  const firstExport = await exported(id);
  expect(firstExport.data.referencedIntegratedApprovalFacts).toHaveLength(1);
  expect(firstExport.data.referencedIntegratedApprovalFacts[0]?.result_json).toEqual(committed);
  expect(firstExport.data.referencedIntegratedApprovalFacts[0]?.candidate_id).toBe(candidate.id);
  expect(firstExport.data.recoveryStrategyHistory).toEqual([
    {
      version_id: committed.versions.find((v) => v.domain === 'recovery')?.versionId,
      approval_id: committed.approvalId,
      action: 'candidate_approved',
    },
  ]);
  expect(firstExport.data.genericRoutineScheduleHistory).toEqual([
    {
      version_id: committed.versions.find((v) => v.domain === 'routine_schedule')?.versionId,
      approval_id: committed.approvalId,
      action: 'candidate_approved',
    },
  ]);
  expect(firstExport.data.recoveryActions).toEqual([]);
  expect(firstExport.data.genericRoutineRuns).toEqual([]);
  expect(await integrated.approve(id, command)).toEqual(committed);
  expect((await exported(id)).data.referencedIntegratedApprovalFacts).toEqual(
    firstExport.data.referencedIntegratedApprovalFacts,
  );
  // Withdrawal preserves committed own manual facts, not AI candidate body access.
  await permission(id, 'ai', false);
  await permission(id, 'app', false);
  const retained = await exported(id);
  for (const field of fields) expect(retained.data[field]).toEqual(firstExport.data[field]);
  await createOperationsRepository(runtime).eraseAccount(id);
  await expect(exported(id)).rejects.toThrow('ACCOUNT_ERASED');
  await owned(id, async (client) => {
    for (const table of [
      'recovery_strategy_history',
      'routine_schedule_history',
      'integrated_approval_v4',
    ])
      expect(
        (await client.query(`SELECT count(*)::int count FROM ${table} WHERE athlete_id=$1`, [id]))
          .rows,
      ).toEqual([{ count: 0 }]);
  });
});
function observeExports(base: Database, observations: unknown[]): Database {
  const wrap = (tx: Transaction): Transaction => ({
    ...tx,
    async query(sql, values) {
      const result = await tx.query(sql, values);
      if (sql.startsWith('WITH rows AS MATERIALIZED')) observations.push(result.rows);
      return result;
    },
  });
  return {
    tenant: (id, operation) => base.tenant(id, (tx) => operation(wrap(tx))),
    exclusiveTenant: (id, operation) => base.exclusiveTenant(id, (tx) => operation(wrap(tx))),
    close: async () => {},
  };
}
async function auditCount(id: string) {
  return reader.tenant(id, async (tx) =>
    z
      .number()
      .int()
      .parse(
        (
          await tx.query(
            "SELECT count(*)::int count FROM operations_audit WHERE athlete_id=$1 AND action='export_requested'",
            [id],
          )
        ).rows[0]?.['count'],
      ),
  );
}
it('exports 1000 real producer catalog rows and rejects 1001 without truncated data or successful audit', async () => {
  const id = await athlete();
  const routine = createRoutineRepository(runtime);
  for (let index = 0; index < 1000; index++)
    await routine.saveBlueprint(id, {
      blueprint: { ...blueprint(), steps: [] },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  expect((await exported(id)).data.genericRoutineBlueprintVersions).toHaveLength(1000);
  const before = await auditCount(id);
  await routine.saveBlueprint(id, {
    blueprint: { ...blueprint(), steps: [] },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const observations: unknown[] = [];
  await expect(exported(id, observeExports(reader, observations))).rejects.toMatchObject({
    code: 'EXPORT_TOO_LARGE',
  });
  expect(observations).toEqual([[{ ok: false, data: {} }]]);
  expect(await auditCount(id)).toBe(before);
});
it('SQL aggregate 8MiB preflight rejects bounded producer bodies before returning any payload', async () => {
  const id = await athlete();
  const routine = createRoutineRepository(runtime);
  // Forty valid <1MiB blueprint bodies exceed global8MiB without any collection
  // reaching1001. No owner-generated raw body or larger production bound.
  for (let index = 0; index < 40; index++)
    await routine.saveBlueprint(id, {
      blueprint: blueprint(undefined, undefined, 'x'.repeat(230000)),
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  const observations: unknown[] = [];
  const before = await auditCount(id);
  await expect(exported(id, observeExports(reader, observations))).rejects.toMatchObject({
    code: 'EXPORT_TOO_LARGE',
  });
  expect(observations).toEqual([[{ ok: false, data: {} }]]);
  expect(await auditCount(id)).toBe(before);
});
it('validates real exported microsecond/body tuples and rejects corrupted portable bigint values', async () => {
  const id = await athlete();
  const facts = await producers(id);
  const precise = { ...blueprint(), createdAt: '2026-10-07T09:00:00.123001+09:00' };
  await createRoutineRepository(runtime).saveBlueprint(id, {
    blueprint: precise,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const result = await exported(id);
  const row = result.data.genericRoutineBlueprintVersions.find(
    (v) => v.version_id === precise.versionId,
  );
  expect(row?.record_json).toEqual(precise);
  expect(row?.created_at).toContain('.123001');
  for (const value of [0, -1, '00', '-1', '9223372036854775808']) {
    const changed = structuredClone(result);
    const timer = changed.data.genericRoutineStepTimers[0];
    if (!timer) throw new Error('EXPECTED_EXPORTED_TIMER');
    const malformed = {
      ...changed,
      data: {
        ...changed.data,
        genericRoutineStepTimers: [{ ...timer, paused_milliseconds: value }],
      },
    };
    expect(accountExportSchema.safeParse(malformed).success).toBe(false);
  }
  const mismatched = structuredClone(result);
  const blueprintRow = mismatched.data.genericRoutineBlueprintVersions.find(
    (v) => v.version_id === precise.versionId,
  );
  if (!blueprintRow) throw new Error('EXPECTED_EXPORTED_BLUEPRINT');
  blueprintRow.created_at = '2026-10-07T00:00:00.123000Z';
  expect(accountExportSchema.safeParse(mismatched).success).toBe(false);
  expect(
    accountExportSchema.safeParse({
      ...result,
      data: {
        ...result.data,
        genericRoutineBlueprintHeads: result.data.genericRoutineBlueprintHeads.map((v) => ({
          ...v,
          version_id: randomUUID(),
        })),
      },
    }).success,
  ).toBe(false);
  expect(
    accountExportSchema.safeParse({
      ...result,
      data: {
        ...result.data,
        genericRoutineRuns: result.data.genericRoutineRuns.map((v) => ({
          ...v,
          record_json: {
            ...v.record_json,
            blueprint: { id: facts.first.routineId, versionId: randomUUID() },
          },
        })),
      },
    }).success,
  ).toBe(false);
});
