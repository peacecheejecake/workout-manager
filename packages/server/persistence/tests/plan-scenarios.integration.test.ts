import { createPlanScenarioRepository } from '../src/plan-scenarios.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { ManualPlanCommand } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantOperations,
  grantPlanScenarios,
  grantSessionCompletions,
} from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantPlanScenarios(adminUrl, 'workout_runtime');
  await grantSessionCompletions(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_snapshot,plan_head,plan_history,command_receipt,outbox TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON consent,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function command(): ManualPlanCommand {
  return {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Manual season',
      timezone: 'UTC',
      periods: [
        {
          id: 'season',
          parentId: null,
          level: 'season',
          title: 'Season',
          startDate: '2026-01-01',
          endDateExclusive: '2026-02-01',
          timezone: 'UTC',
          intent: 'Base',
          isPartial: false,
        },
      ],
      sessions: [],
    },
  };
}
function intensityCommand(): ManualPlanCommand {
  const input = command();
  const root = input.draft.periods[0];
  if (!root) throw new Error('Missing fixture season');
  input.draft.periods.push(
    { ...root, id: 'wave', parentId: 'season', level: 'wave' },
    { ...root, id: 'phase', parentId: 'wave', level: 'phase' },
    { ...root, id: 'block', parentId: 'phase', level: 'block' },
  );
  input.draft.sessions = [
    {
      id: 'run',
      blockId: 'block',
      date: '2026-01-02',
      localStartTime: null,
      title: 'Run',
      sport: 'running',
      durationSeconds: 0,
      distanceMeters: null,
      targetRpe: 0,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [
        { id: 'step', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 1 },
      ],
    },
  ];
  return input;
}

const createCommand = (basePlanVersionId: string, label = 'A') => ({
  confirmed: true as const,
  basePlanVersionId,
  label,
  idempotencyKey: randomUUID(),
});
const applyCommand = (planId: string, revision = 1, completion = 0) => ({
  confirmed: true as const,
  expectedPlanVersionId: planId,
  expectedScenarioRevision: revision,
  expectedCompletionRevision: completion,
  idempotencyKey: randomUUID(),
});
async function seed() {
  const athlete = randomUUID(),
    input = intensityCommand(),
    base = await createPlanningRepository(database).save(athlete, input);
  return { athlete, input, base };
}

describe('plan scenario durable alternatives', () => {
  it('branches exact legacy snapshots, saves independent revisions and applies only on explicit command with original replay and audit', async () => {
    const { athlete, input, base } = await seed(),
      repo = createPlanScenarioRepository(database),
      plans = createPlanningRepository(database);
    const create = createCommand(base.id);
    const first = await repo.create(athlete, create);
    expect(first.draft).toEqual(base.draft);
    expect(first.draft.sessions[0]).not.toHaveProperty('intensityLabel');
    expect((await plans.read(athlete)).head).toEqual(base);
    const save = {
      confirmed: true as const,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      draft: { ...first.draft, title: 'Alternative A' },
    };
    const second = await repo.save(athlete, first.id, save);
    expect(second.revision).toBe(2);
    expect(await repo.readRevision(athlete, first.id, 1)).toEqual(first);
    expect(await repo.readRevision(athlete, first.id, 2)).toEqual(second);
    expect(await repo.create(athlete, create)).toEqual(first);
    expect(await repo.save(athlete, first.id, save)).toEqual(second);
    expect((await plans.read(athlete)).history).toHaveLength(1);
    const apply = applyCommand(base.id, 2);
    const [applied, replayed] = await Promise.all([
      repo.apply(athlete, first.id, apply),
      repo.apply(athlete, first.id, apply),
    ]);
    expect(replayed).toEqual(applied);
    expect(applied.plan.draft).toEqual(second.draft);
    expect(applied.plan.version).toBe(2);
    expect(await plans.save(athlete, input)).toEqual(base);
    expect((await plans.read(athlete)).head).toEqual(applied.plan);
    expect(await repo.read(athlete, first.id)).toEqual(second);
    await repo.save(athlete, first.id, {
      ...save,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      draft: { ...second.draft, title: 'Later branch draft' },
    });
    expect(await repo.apply(athlete, first.id, apply)).toEqual(applied);
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    if (exported.schemaVersion !== 22) throw new Error('Expected scenario export v22');
    expect(exported.data.planScenarios).toEqual([
      expect.objectContaining({
        id: first.id,
        revision: 3,
        base_plan_version_id: base.id,
        label: 'A',
      }),
    ]);
    expect(exported.data.planScenarioRevisions).toHaveLength(3);
    expect(exported.data.planScenarioApplications).toEqual([
      expect.objectContaining({
        version_id: applied.plan.id,
        scenario_id: first.id,
        scenario_revision: 2,
      }),
    ]);
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM plan_scenario_application')).rows).toEqual([
        expect.objectContaining({
          version_id: applied.plan.id,
          scenario_id: first.id,
          scenario_revision: 2,
          previous_version_id: base.id,
          completion_revision: 0,
        }),
      ]);
      expect((await tx.query('SELECT action FROM plan_history ORDER BY action')).rows).toEqual([
        { action: 'manual_saved' },
        { action: 'scenario_applied' },
      ]);
      const events = await tx.query('SELECT topic,payload FROM outbox');
      expect(events.rows.map((row) => row['topic'])).toEqual(
        expect.arrayContaining([
          'plan.scenario_created',
          'plan.scenario_saved',
          'plan.scenario_applied',
        ]),
      );
      for (const row of events.rows) expect(row['payload']).not.toHaveProperty('draft');
      expect((await tx.query('SELECT * FROM activity_canonical')).rowCount).toBe(0);
      expect((await tx.query('SELECT * FROM session_completion')).rowCount).toBe(0);
    });
    await createOperationsRepository(database).eraseAccount(athlete);
    for (const table of ['plan_scenario', 'plan_scenario_revision', 'plan_scenario_application'])
      expect(
        (await admin.query(`SELECT * FROM ${table} WHERE athlete_id=$1`, [athlete])).rowCount,
      ).toBe(0);
  });
  it('serializes same-name creation while allowing unbounded named alternatives per base version', async () => {
    const { athlete, base } = await seed(),
      repo = createPlanScenarioRepository(database);
    const creates = await Promise.allSettled([
      repo.create(athlete, createCommand(base.id)),
      repo.create(athlete, createCommand(base.id)),
    ]);
    expect(creates.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(creates.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'SCENARIO_SLOT_EXISTS' },
    });
    const winner = creates.find((item) => item.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing winner');
    const first = winner.value;
    const saves = await Promise.allSettled(
      ['One', 'Two'].map((title) =>
        repo.save(athlete, first.id, {
          confirmed: true,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          draft: { ...first.draft, title },
        }),
      ),
    );
    expect(saves.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(saves.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'SCENARIO_REVISION_CONFLICT' },
    });
    await repo.create(athlete, createCommand(base.id, 'B'));
    await repo.create(athlete, createCommand(base.id, 'C'));
    await repo.create(athlete, createCommand(base.id, '대회 준비 주간'));
    expect(await repo.list(athlete, { basePlanVersionId: base.id, offset: 99, limit: 1 })).toEqual({
      items: [],
      total: 4,
    });
    const nextBase = await createPlanningRepository(database).save(athlete, {
      ...command(),
      expectedVersionId: base.id,
    });
    const sameNameOnNextBase = await repo.create(athlete, createCommand(nextBase.id, 'A'));
    expect(sameNameOnNextBase.basePlanVersionId).toBe(nextBase.id);
    expect((await repo.list(athlete, { basePlanVersionId: nextBase.id })).total).toBe(1);
    expect((await repo.list(athlete, { limit: 1 })).items).toHaveLength(1);
    const other = randomUUID();
    expect(await repo.read(other, first.id)).toBeNull();
    expect(await repo.readRevision(other, first.id, 1)).toBeNull();
    expect(await repo.list(other)).toEqual({ items: [], total: 0 });
    await expect(repo.create(other, createCommand(base.id))).rejects.toMatchObject({
      code: 'PLAN_VERSION_NOT_FOUND',
    });
    await expect(
      repo.save(other, first.id, {
        confirmed: true,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        draft: first.draft,
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_NOT_FOUND' });
    await expect(repo.apply(other, first.id, applyCommand(base.id))).rejects.toMatchObject({
      code: 'SCENARIO_NOT_FOUND',
    });
    await database.tenant(other, async (tx) => {
      expect(
        (await tx.query('SELECT * FROM plan_scenario WHERE athlete_id=$1', [athlete])).rowCount,
      ).toBe(0);
    });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE plan_scenario_revision SET record_json=record_json WHERE scenario_id=$1', [
          first.id,
        ]),
      ),
    ).rejects.toThrow();
  });
  it('checks current plan and completion revisions on apply and completion schedules during branch save', async () => {
    const { athlete, base } = await seed(),
      repo = createPlanScenarioRepository(database),
      first = await repo.create(athlete, createCommand(base.id));
    const command = applyCommand(base.id);
    const reports = createSessionCompletionRepository(database);
    await reports.write(athlete, 'run', {
      action: 'complete',
      confirmed: true,
      expectedPlanVersionId: base.id,
      expectedRevision: null,
      reason: null,
      idempotencyKey: randomUUID(),
    });
    await expect(repo.apply(athlete, first.id, command)).rejects.toMatchObject({
      code: 'COMPLETION_REVISION_CONFLICT',
    });
    await expect(
      repo.save(athlete, first.id, {
        confirmed: true,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        draft: {
          ...first.draft,
          sessions: first.draft.sessions.map((session) => ({ ...session, date: '2026-01-03' })),
        },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_COMPLETED_SESSION' });
    const applied = await repo.apply(athlete, first.id, {
      ...command,
      expectedCompletionRevision: 1,
    });
    expect(applied.plan.version).toBe(2);
    await expect(
      repo.apply(athlete, first.id, {
        ...command,
        expectedCompletionRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      repo.apply(athlete, first.id, {
        ...command,
        expectedPlanVersionId: applied.plan.id,
        expectedScenarioRevision: 2,
        expectedCompletionRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_REVISION_CONFLICT' });
  });
  it('preserves branch locks and refuses applying an old unlocked alternative over newly locked current state', async () => {
    const { athlete, base, input } = await seed(),
      repo = createPlanScenarioRepository(database),
      first = await repo.create(athlete, createCommand(base.id));
    const changed = await repo.save(athlete, first.id, {
      confirmed: true,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      draft: {
        ...first.draft,
        sessions: first.draft.sessions.map((session) => ({
          ...session,
          distanceMeters: 100,
          locks: { ...session.locks, intensity: true },
        })),
      },
    });
    await expect(
      repo.save(athlete, first.id, {
        confirmed: true,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        draft: {
          ...changed.draft,
          sessions: changed.draft.sessions.map((session) => ({
            ...session,
            distanceMeters: 200,
            locks: { ...session.locks, intensity: false },
          })),
        },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_LOCKED' });
    const current = await createPlanningRepository(database).save(athlete, {
      ...input,
      expectedVersionId: base.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...base.draft,
        sessions: base.draft.sessions.map((session) => ({
          ...session,
          locks: { ...session.locks, intensity: true },
        })),
      },
    });
    await expect(repo.apply(athlete, first.id, applyCommand(current.id, 2))).rejects.toMatchObject({
      code: 'PLAN_LOCKED',
    });
    expect((await createPlanningRepository(database).read(athlete)).head).toEqual(current);
  });
  it('rolls back scenario creation and application when durable outbox enqueue fails, with retry using the same key', async () => {
    const { athlete, base } = await seed(),
      repo = createPlanScenarioRepository(database);
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, args) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('scenario injected failure');
              return tx.query(sql, args);
            },
          }),
        ),
    };
    const faulty = createPlanScenarioRepository(broken),
      create = createCommand(base.id);
    await expect(faulty.create(athlete, create)).rejects.toThrow('scenario injected failure');
    expect(await repo.list(athlete)).toEqual({ items: [], total: 0 });
    const first = await repo.create(athlete, create),
      apply = applyCommand(base.id);
    await expect(faulty.apply(athlete, first.id, apply)).rejects.toThrow(
      'scenario injected failure',
    );
    expect((await createPlanningRepository(database).read(athlete)).head).toEqual(base);
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM plan_scenario_application')).rowCount).toBe(0);
      expect((await tx.query('SELECT * FROM plan_snapshot')).rowCount).toBe(1);
      expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(2);
    });
    const applied = await repo.apply(athlete, first.id, apply);
    expect(applied.plan.version).toBe(2);
    await expect(
      repo.apply(athlete, first.id, { ...apply, expectedScenarioRevision: 2 }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

it('serializes completion confirmation against applying a schedule-changing alternative', async () => {
  const { athlete, base } = await seed(),
    repo = createPlanScenarioRepository(database),
    first = await repo.create(athlete, createCommand(base.id));
  const alternative = await repo.save(athlete, first.id, {
    confirmed: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    draft: {
      ...first.draft,
      sessions: first.draft.sessions.map((session) => ({ ...session, date: '2026-01-03' })),
    },
  });
  const outcomes = await Promise.allSettled([
    repo.apply(athlete, first.id, applyCommand(base.id, alternative.revision)),
    createSessionCompletionRepository(database).write(athlete, 'run', {
      action: 'complete',
      confirmed: true,
      expectedPlanVersionId: base.id,
      expectedRevision: null,
      reason: null,
      idempotencyKey: randomUUID(),
    }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const current = (await createPlanningRepository(database).read(athlete)).head;
  const completed = await createSessionCompletionRepository(database).read(athlete, 'run');
  if (outcomes[0]?.status === 'fulfilled') {
    expect(current?.draft.sessions[0]?.date).toBe('2026-01-03');
    expect(completed?.report).toBeNull();
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'PLAN_REVISION_CONFLICT' },
    });
  } else {
    expect(current?.id).toBe(base.id);
    expect(completed?.report?.schedule.date).toBe('2026-01-02');
    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'COMPLETION_REVISION_CONFLICT' },
    });
  }
});
