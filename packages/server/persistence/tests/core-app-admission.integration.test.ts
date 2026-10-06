import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { AppConsentRequiredError, lockAppAdmission } from '../src/app-admission.js';
import { createActivityRepository } from '../src/activities.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createCoachingConstraintRepository } from '../src/coaching-constraints.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantCheckIns,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantOperations,
  grantPlanScenarios,
  grantSessionCompletions,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPlanScenarioRepository } from '../src/plan-scenarios.js';
import { createPlanningRepository } from '../src/planning.js';
import { createConsentRepository } from '../src/repositories.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated real PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const applicationName = `core-app-admission-${randomUUID()}`;
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  for (const grant of [
    grantOperations,
    grantCheckIns,
    grantCoachingConstraints,
    grantCoachingThreads,
    grantPlanScenarios,
    grantSessionCompletions,
  ])
    await grant(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON consent,command_receipt,outbox,
    plan_snapshot,plan_head,plan_history,activity_canonical,activity_source_head,
    activity_source_revision,activity_overlay,activity_overlay_revision,
    activity_suppression,activity_import_receipt TO workout_runtime`);
  const endpoint = new URL(runtimeUrl);
  endpoint.searchParams.set('application_name', applicationName);
  database = createDatabase({ connectionString: endpoint.toString(), max: 6 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

const draft = (): PlanDraft => ({
  title: 'Synthetic core plan',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2080-01-01',
    endDateExclusive: '2080-02-01',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [
    {
      id: 'run',
      blockId: 'block',
      date: '2080-01-02',
      localStartTime: null,
      title: 'Run',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
});
const activity = () => ({
  title: 'Synthetic actual',
  kind: 'running' as const,
  startedAt: '2026-01-01T10:00:00Z',
  timezone: 'UTC',
  durationSeconds: null,
  durationKind: 'unknown' as const,
  distanceMeters: 0,
});
const checkInValues = () => ({
  observedAt: '2026-01-01T10:00:00Z',
  timezone: 'UTC',
  fatigue: 0,
  discomfort: null,
  bodyLocation: null,
  note: 'Synthetic observation',
});
async function consent(athlete: string, granted: boolean, expectedRevision: number) {
  return createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision,
    idempotencyKey: randomUUID(),
  });
}

const commandNames = [
  'plan.save',
  'scenario.create',
  'scenario.save',
  'scenario.apply',
  'activity.manual',
  'activity.import',
  'activity.overlay',
  'check-in.create',
  'check-in.update',
  'completion.write',
  'thread.create',
  'thread.append',
  'constraint.create',
  'constraint.update',
] as const;
type CommandName = (typeof commandNames)[number];

async function setup() {
  const athlete = randomUUID();
  await consent(athlete, true, 0);
  const plans = createPlanningRepository(database);
  const scenarios = createPlanScenarioRepository(database);
  const activities = createActivityRepository(database);
  const checkIns = createCheckInRepository(database);
  const threads = createCoachingThreadRepository(database);
  const constraints = createCoachingConstraintRepository(database);
  const completions = createSessionCompletionRepository(database);
  const plan = await plans.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const scenario = await scenarios.create(athlete, {
    confirmed: true,
    basePlanVersionId: plan.id,
    label: 'A',
    idempotencyKey: randomUUID(),
  });
  const actual = await activities.createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: activity(),
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const observation = await checkIns.createCheckIn(athlete, {
    idempotencyKey: randomUUID(),
    values: checkInValues(),
  });
  const conversation = await threads.create(athlete, {
    planVersionId: plan.id,
    title: 'Synthetic dialogue',
    scope: { kind: 'session', targetId: 'run' },
    message: 'Original message',
    idempotencyKey: randomUUID(),
  });
  const constraint = await constraints.create(athlete, {
    confirmed: true,
    expectedHeadRevision: null,
    text: 'Synthetic restriction',
    idempotencyKey: randomUUID(),
  });
  const key = randomUUID();
  const execute: Record<CommandName, () => Promise<unknown>> = {
    'plan.save': () =>
      plans.save(athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: plan.id,
        idempotencyKey: key,
        draft: { ...draft(), title: 'Changed plan' },
      }),
    'scenario.create': () =>
      scenarios.create(athlete, {
        confirmed: true,
        basePlanVersionId: plan.id,
        label: 'B',
        idempotencyKey: key,
      }),
    'scenario.save': () =>
      scenarios.save(athlete, scenario.id, {
        confirmed: true,
        expectedRevision: 1,
        draft: { ...draft(), title: 'Alternative' },
        idempotencyKey: key,
      }),
    'scenario.apply': () =>
      scenarios.apply(athlete, scenario.id, {
        confirmed: true,
        expectedScenarioRevision: 1,
        expectedPlanVersionId: plan.id,
        expectedCompletionRevision: 0,
        idempotencyKey: key,
      }),
    'activity.manual': () =>
      activities.createManualActivity(athlete, {
        confirmed: true,
        idempotencyKey: key,
        activity: activity(),
        report: { sessionRpe: null, note: null, planLink: null },
      }),
    'activity.import': () =>
      activities.importActivity(athlete, {
        idempotencyKey: key,
        source: {
          kind: 'fit',
          sourceId: 'synthetic-fit',
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
        activity: activity(),
      }),
    'activity.overlay': () =>
      activities.updateOverlay(athlete, actual.activityId, {
        expectedRevision: 1,
        title: 'Corrected actual',
        reason: 'Synthetic correction',
        idempotencyKey: key,
      }),
    'check-in.create': () =>
      checkIns.createCheckIn(athlete, { idempotencyKey: key, values: checkInValues() }),
    'check-in.update': () =>
      checkIns.updateCheckIn(athlete, observation.id, {
        expectedRevision: 1,
        idempotencyKey: key,
        reason: 'Synthetic correction',
        values: { ...checkInValues(), fatigue: 2 },
      }),
    'completion.write': () =>
      completions.write(athlete, 'run', {
        action: 'complete',
        confirmed: true,
        expectedPlanVersionId: plan.id,
        expectedRevision: null,
        reason: null,
        idempotencyKey: key,
      }),
    'thread.create': () =>
      threads.create(athlete, {
        planVersionId: plan.id,
        title: 'Second dialogue',
        scope: { kind: 'session', targetId: 'run' },
        message: 'New message',
        idempotencyKey: key,
      }),
    'thread.append': () =>
      threads.append(athlete, conversation.thread.id, {
        expectedRevision: 1,
        message: 'New message',
        idempotencyKey: key,
      }),
    'constraint.create': () =>
      constraints.create(athlete, {
        confirmed: true,
        expectedHeadRevision: 1,
        text: 'Another restriction',
        idempotencyKey: key,
      }),
    'constraint.update': () =>
      constraints.update(athlete, constraint.id, {
        confirmed: true,
        expectedRevision: 1,
        expectedHeadRevision: 1,
        text: 'Corrected restriction',
        idempotencyKey: key,
      }),
  };
  return {
    athlete,
    key,
    plan,
    actual,
    observation,
    conversation,
    constraint,
    execute,
    plans,
    activities,
    checkIns,
    threads,
    constraints,
  };
}

// Full owned canonical/head/revision/receipt/outbox facts detect partial commits and changed existing data.
const tables = [
  'plan_snapshot',
  'plan_head',
  'plan_history',
  'plan_scenario',
  'plan_scenario_revision',
  'plan_scenario_application',
  'activity_canonical',
  'activity_source_head',
  'activity_source_revision',
  'activity_overlay',
  'activity_overlay_revision',
  'activity_suppression',
  'activity_import_receipt',
  'check_in',
  'check_in_revision',
  'check_in_collection_head',
  'check_in_receipt',
  'session_completion',
  'session_completion_revision',
  'session_completion_collection_head',
  'session_completion_receipt',
  'coaching_thread',
  'coaching_message',
  'coaching_constraint',
  'coaching_constraint_head',
  'command_receipt',
  'outbox',
] as const;
async function facts(athlete: string) {
  return database.tenant(athlete, async (tx) => {
    const result = [];
    for (const table of tables)
      result.push(
        (
          await tx.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS facts FROM ${table} t`,
          )
        ).rows[0],
      );
    return result;
  });
}

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function blocked() {
  await expect
    .poll(
      async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
            [applicationName],
          )
        ).rows[0]?.['count'],
    )
    .toBeGreaterThan(0);
}

describe('V2-F31 bounded direct core commands enforce app admission', () => {
  for (const state of ['absent', 'withdrawn'] as const) {
    it.each(commandNames)(
      `${state} app consent refuses %s without altering any owned artifacts`,
      async (name) => {
        const fixture = await setup();
        if (state === 'absent')
          await database.tenant(fixture.athlete, (tx) =>
            tx.query("DELETE FROM consent WHERE athlete_id=$1 AND kind='app'", [fixture.athlete]),
          );
        else await consent(fixture.athlete, false, 1);
        const before = await facts(fixture.athlete);
        await expect(fixture.execute[name]()).rejects.toBeInstanceOf(AppConsentRequiredError);
        expect(await facts(fixture.athlete)).toEqual(before);
      },
    );
  }
  it.each(commandNames)(
    'successful %s replays after revocation without a new artifact',
    async (name) => {
      const fixture = await setup();
      const original = await fixture.execute[name]();
      await consent(fixture.athlete, false, 1);
      const before = await facts(fixture.athlete);
      expect(await fixture.execute[name]()).toEqual(original);
      expect(await facts(fixture.athlete)).toEqual(before);
    },
  );

  it('grant in a different account or AI/provider grants cannot authorize a manual plan', async () => {
    await setup();
    const athlete = randomUUID();
    for (const kind of ['ai', 'provider'] as const)
      await createConsentRepository(database).setConsent(athlete, {
        kind,
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    await expect(
      createPlanningRepository(database).save(athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: null,
        draft: draft(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AppConsentRequiredError);
    expect((await createPlanningRepository(database).read(athlete)).head).toBeNull();
  });

  it('existing plan/actual/dialogue reads, account export and actual/check-in/constraint deletion remain available', async () => {
    const fixture = await setup();
    await consent(fixture.athlete, false, 1);
    expect((await fixture.plans.read(fixture.athlete)).head?.id).toBe(fixture.plan.id);
    expect(
      await fixture.activities.getActivity(fixture.athlete, fixture.actual.activityId),
    ).not.toBeNull();
    expect(
      await fixture.checkIns.getCheckIn(fixture.athlete, fixture.observation.id),
    ).not.toBeNull();
    expect(
      (await fixture.threads.messages(fixture.athlete, fixture.conversation.thread.id))?.messages,
    ).toHaveLength(1);
    expect(await createOperationsRepository(database).exportAccount(fixture.athlete)).toBeDefined();
    await fixture.activities.deleteActivity(fixture.athlete, fixture.actual.activityId, {
      expectedRevision: 1,
    });
    expect(
      await fixture.activities.getActivity(fixture.athlete, fixture.actual.activityId),
    ).toBeNull();
    await fixture.checkIns.deleteCheckIn(fixture.athlete, fixture.observation.id, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await fixture.constraints.remove(fixture.athlete, fixture.constraint.id, {
      confirmed: true,
      expectedRevision: 1,
      expectedHeadRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect((await fixture.constraints.list(fixture.athlete)).items).toEqual([]);
  });

  it('changed successful plan payload conflicts before the app gate', async () => {
    const fixture = await setup();
    await fixture.execute['plan.save']();
    await consent(fixture.athlete, false, 1);
    const before = await facts(fixture.athlete);
    await expect(
      fixture.plans.save(fixture.athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: fixture.plan.id,
        idempotencyKey: fixture.key,
        draft: draft(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await facts(fixture.athlete)).toEqual(before);
  });

  it('completion retraction is a new self-report revision, not deletion', async () => {
    const fixture = await setup();
    await fixture.execute['completion.write']();
    await consent(fixture.athlete, false, 1);
    const before = await facts(fixture.athlete);
    await expect(
      createSessionCompletionRepository(database).write(fixture.athlete, 'run', {
        action: 'retract',
        confirmed: true,
        expectedPlanVersionId: fixture.plan.id,
        expectedRevision: 1,
        reason: 'Synthetic retraction',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AppConsentRequiredError);
    expect(await facts(fixture.athlete)).toEqual(before);
  });

  it('real check-in takes tenant0 before its domain lock and refuses a revocation that wins', async () => {
    const fixture = await setup();
    const held = barrier();
    const release = barrier();
    const revocation = database.tenant(fixture.athlete, async (tx) => {
      await lockAppAdmission(tx);
      await tx.query("UPDATE consent SET granted=false,revision=revision+1 WHERE kind='app'");
      held.release();
      await release.ready;
    });
    await held.ready;
    const writer = expect(fixture.execute['check-in.create']()).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
    // The lock check would immediately fail if this writer held 77209 while waiting for 0.
    try {
      await blocked();
      await database.tenant(fixture.athlete, async (tx) => {
        expect(
          (
            await tx.query(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,77209)) AS acquired',
              [fixture.athlete],
            )
          ).rows[0]?.['acquired'],
        ).toBe(true);
      });
    } finally {
      release.release();
    }
    await revocation;
    await writer;
    expect(
      (
        await fixture.checkIns.listCheckIns(fixture.athlete, {
          from: '2026-01-01',
          toExclusive: '2026-01-02',
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(1);
  });

  it('a real plan commit that wins the command lock remains readable after waiting revocation', async () => {
    const fixture = await setup();
    const held = barrier();
    const release = barrier();
    // Observe the real repository's tenant transaction after the gate and before first write.
    const originalDatabase = database;
    const observedDatabase: Database = {
      ...originalDatabase,
      tenant: (athlete, operation) =>
        originalDatabase.tenant(athlete, (tx) =>
          operation({
            ...tx,
            query: async (sql, values) => {
              if (sql.startsWith('INSERT INTO plan_snapshot')) {
                held.release();
                await release.ready;
              }
              return tx.query(sql, values);
            },
          }),
        ),
    };
    const saving = createPlanningRepository(observedDatabase).save(fixture.athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: fixture.plan.id,
      idempotencyKey: randomUUID(),
      draft: { ...draft(), title: 'Committed before revoke' },
    });
    await held.ready;
    const revoking = consent(fixture.athlete, false, 1);
    try {
      await blocked();
    } finally {
      release.release();
    }
    const saved = await saving;
    await revoking;
    expect((await fixture.plans.read(fixture.athlete)).head?.id).toBe(saved.id);
    await expect(fixture.execute['check-in.create']()).rejects.toBeInstanceOf(
      AppConsentRequiredError,
    );
  });
});
