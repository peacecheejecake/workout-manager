import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { createIntegratedPlannerRepository } from '../src/integrated-planner.js';
import {
  grantNutritionCore,
  grantOperations,
  grantRecoveryCore,
  grantRoutineCore,
  grantStretchingCore,
  grantSupplementaryCore,
  migrate,
} from '../src/migrate.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createPlanningRepository } from '../src/planning.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantSupplementaryCore(adminUrl, 'workout_runtime');
  await grantRoutineCore(adminUrl, 'workout_runtime');
  await grantStretchingCore(adminUrl, 'workout_runtime');
  await grantRecoveryCore(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,plan_snapshot,plan_head,plan_history TO workout_runtime',
  );
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
function nutrients(energy: number | null) {
  return {
    energy:
      energy === null
        ? unknown('kcal')
        : {
            value: energy,
            unit: 'kcal' as const,
            status: 'reported' as const,
            evidenceIds: [],
          },
    carbohydrate: unknown('g'),
    protein: unknown('g'),
    fat: unknown('g'),
    fluid: unknown('mL'),
    sodium: unknown('mg'),
  };
}

async function seedPlan(athleteId: string) {
  return createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Frozen training',
      timezone: 'UTC',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, all) => ({
        id: level,
        parentId: index === 0 ? null : (all[index - 1] ?? null),
        level,
        title: level,
        startDate: '2026-09-18',
        endDateExclusive: '2026-09-21',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'evening',
          blockId: 'block',
          date: '2026-09-18',
          localStartTime: '23:30',
          title: 'Strength',
          sport: 'strength',
          durationSeconds: 3600,
          distanceMeters: null,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
}

describe('integrated Planner read under tenant RLS', () => {
  it('projects frozen relative nutrition, canonical Activity once, and current intake revision without zero filling', async () => {
    const athlete = randomUUID();
    const plan = await seedPlan(athlete);
    const nutrition = createNutritionRepository(database, {
      now: () => new Date('2026-09-20T00:00:00.000Z'),
    });
    const nutritionPlan = await nutrition.savePlan(athlete, {
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        period: { from: '2026-09-18', toInclusive: '2026-09-20' },
        timezone: 'UTC',
        purpose: 'User notes',
        linkedTrainingPlanVersionId: plan.id,
        items: [
          {
            id: 'breakfast',
            category: 'meal',
            title: 'Breakfast',
            anchor: { kind: 'absolute', date: '2026-09-18', localTime: null, timezone: 'UTC' },
            foods: [],
            targets: [],
            instructions: 'Eat breakfast',
            evidenceIds: [],
            source: 'user_confirmed',
          },
          {
            id: 'after',
            category: 'after',
            title: 'After exercise',
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'evening',
              point: 'end',
              offsetMinutes: 60,
            },
            foods: [],
            targets: [],
            instructions: 'Hydrate',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    });
    const activities = createActivityRepository(database);
    const actual = await activities.createManualActivity(athlete, {
      confirmed: true,
      activity: {
        title: 'Strength',
        kind: 'strength',
        startedAt: '2026-09-18T08:00:00Z',
        timezone: 'UTC',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: null,
      },
      report: { sessionRpe: null, note: null, planLink: null },
      idempotencyKey: randomUUID(),
    });
    await database.tenant(athlete, (tx) =>
      tx.query(
        `INSERT INTO supplementary_execution
       (athlete_id,id,activity_id,revision,status,started_at)
       VALUES($1,$2,$3,1,'active',$4)`,
        [athlete, randomUUID(), actual.activityId, '2026-09-18T08:00:00Z'],
      ),
    );
    const request = {
      idempotencyKey: randomUUID(),
      intakeId: 'intake-1',
      confirmed: true as const,
      occurredAt: '2026-09-18T09:00:00Z',
      timezone: 'UTC',
      foods: [
        {
          foodVersionId: null,
          description: 'Snack',
          quantity: null,
          unit: 'unspecified' as const,
          sourceBasis: 'manual_total' as const,
        },
      ],
      nutrientTotal: nutrients(0),
      plannedItemId: 'breakfast',
      relatedSessionIds: [],
      relatedActivityIds: [actual.activityId],
      source: 'user' as const,
      sourceRecordId: null,
      notes: null,
    };
    await nutrition.createIntake(athlete, request);
    const read = createIntegratedPlannerRepository(database);
    const query = { from: '2026-09-18', toExclusive: '2026-09-20', timezone: 'UTC' };
    const first = await read.read(athlete, query);
    expect(first.trainingPlanVersionId).toBe(plan.id);
    expect(first.nutritionPlanVersionIds).toEqual([nutritionPlan.versionId]);
    expect(first.days[0]?.plannedSessions.map((session) => session.id)).toEqual(['evening']);
    expect(first.days[0]?.nutritionItems.map((item) => item.id)).toEqual(['breakfast']);
    expect(first.days[1]?.nutritionItems.map((item) => item.id)).toEqual(['after']);
    expect(first.unresolvedNutritionItems).toEqual([]);
    const alternateDisplayZone = await read.read(athlete, { ...query, timezone: 'Asia/Seoul' });
    expect(alternateDisplayZone.timezone).toBe('UTC');
    expect(alternateDisplayZone.days[0]?.activities).toHaveLength(1);
    expect(alternateDisplayZone.days[1]?.nutritionItems.map((item) => item.id)).toEqual(['after']);
    expect(first.summary.training).toMatchObject({
      plannedSessionCount: 1,
      actualActivityCount: 1,
      supplementaryActivityCount: 1,
      distanceMeters: { value: null, knownCount: 0, missingCount: 1 },
      durationSeconds: { timer: { value: 0, knownCount: 1, missingCount: 0 } },
    });
    expect(first.summary.nutrition).toMatchObject({
      plannedItemCount: 2,
      intakeCount: 1,
      nutrients: {
        energyKcal: { value: 0, knownCount: 1, missingCount: 0 },
        proteinGrams: { value: null, knownCount: 0, missingCount: 1 },
      },
      intakeCoverage: 'unknown',
    });
    const corrected = await nutrition.correctIntake(athlete, {
      ...request,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      nutrientTotal: nutrients(12),
    });
    expect((await read.read(athlete, query)).summary.nutrition.nutrients.energyKcal).toMatchObject({
      value: 12,
      knownCount: 1,
    });
    await nutrition.deleteIntake(athlete, {
      idempotencyKey: randomUUID(),
      intakeId: 'intake-1',
      expectedRevision: corrected.revision,
      confirmed: true,
      reason: 'user_requested',
    });
    expect((await read.read(athlete, query)).summary.nutrition).toMatchObject({
      intakeCount: 0,
      nutrients: { energyKcal: { value: null, knownCount: 0, missingCount: 0 } },
    });
    const foreign = await read.read(randomUUID(), query);
    expect(foreign.trainingPlanVersionId).toBeNull();
    expect(foreign.summary.training.actualActivityCount).toBe(0);
    expect(foreign.summary.nutrition.intakeCount).toBe(0);
  });

  it('keeps ambiguous DST-relative anchors and date-only cross-timezone items unresolved', async () => {
    const athlete = randomUUID();
    const first = await seedPlan(athlete);
    const later = await createPlanningRepository(database).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...first.draft,
        timezone: 'America/New_York',
        periods: first.draft.periods.map((period) => ({
          ...period,
          startDate: '2026-11-01',
          endDateExclusive: '2026-11-03',
          timezone: 'America/New_York',
        })),
        sessions: first.draft.sessions.map((session) => ({
          ...session,
          date: '2026-11-01',
          localStartTime: '01:30',
        })),
      },
    });
    const nutrition = createNutritionRepository(database, {
      now: () => new Date('2026-11-05T00:00:00.000Z'),
    });
    await nutrition.savePlan(athlete, {
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        period: { from: '2026-11-01', toInclusive: '2026-11-02' },
        timezone: 'America/New_York',
        purpose: 'Unresolved time safety',
        linkedTrainingPlanVersionId: later.id,
        items: [
          {
            id: 'relative',
            category: 'after',
            title: 'After session',
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'evening',
              point: 'start',
              offsetMinutes: 0,
            },
            foods: [],
            targets: [],
            instructions: 'Check timing',
            evidenceIds: [],
            source: 'user_confirmed',
          },
          {
            id: 'floating',
            category: 'meal',
            title: 'No local time',
            anchor: { kind: 'absolute', date: '2026-11-01', localTime: null, timezone: 'UTC' },
            foods: [],
            targets: [],
            instructions: 'Check timezone',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    });
    const read = await createIntegratedPlannerRepository(database).read(athlete, {
      from: '2026-11-01',
      toExclusive: '2026-11-02',
      timezone: 'America/New_York',
    });
    expect(read.days[0]?.nutritionItems).toEqual([]);
    expect(read.unresolvedNutritionItems).toEqual([
      expect.objectContaining({ id: 'floating', reason: 'timezone_mismatch' }),
      expect.objectContaining({ id: 'relative', reason: 'ambiguous_local_time' }),
    ]);
    expect(read.summary.nutrition.plannedItemCount).toBe(0);
  });

  it('resolves a legacy nutrition link from its frozen historical training version', async () => {
    const athlete = randomUUID();
    const first = await seedPlan(athlete);
    const current = await createPlanningRepository(database).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...first.draft,
        sessions: first.draft.sessions.map((session) => ({ ...session, date: '2026-09-20' })),
      },
    });
    await createNutritionRepository(database, {
      now: () => new Date('2026-09-21T00:00:00.000Z'),
    }).savePlan(athlete, {
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        period: { from: '2026-09-18', toInclusive: '2026-09-20' },
        timezone: 'UTC',
        purpose: 'Previously linked schedule',
        linkedTrainingPlanVersionId: first.id,
        items: [
          {
            id: 'frozen-after',
            category: 'after',
            title: 'Original timing',
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'evening',
              point: 'end',
              offsetMinutes: 60,
            },
            foods: [],
            targets: [],
            instructions: 'Keep original timing',
            evidenceIds: [],
            source: 'user_confirmed',
          },
          {
            id: 'oversized-offset',
            category: 'after',
            title: 'Invalid offset for display',
            anchor: {
              kind: 'relative',
              entity: 'session',
              entityId: 'evening',
              point: 'start',
              offsetMinutes: 1e308,
            },
            foods: [],
            targets: [],
            instructions: 'Check timing',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    });
    const read = await createIntegratedPlannerRepository(database).read(athlete, {
      from: '2026-09-18',
      toExclusive: '2026-09-20',
      timezone: 'UTC',
    });
    expect(read.trainingPlanVersionId).toBe(current.id);
    expect(read.summary.training.plannedSessionCount).toBe(0);
    expect(read.days[1]?.nutritionItems.map((item) => item.id)).toEqual(['frozen-after']);
    expect(read.unresolvedNutritionItems).toEqual([
      expect.objectContaining({ id: 'oversized-offset', reason: 'offset_out_of_range' }),
    ]);
  });

  it('reads v4 layers in one snapshot without recounting routine or stretching wrappers', async () => {
    const athlete = randomUUID();
    const plan = await seedPlan(athlete);
    const activity = await createActivityRepository(database).createManualActivity(athlete, {
      confirmed: true,
      activity: {
        title: 'Mobility',
        kind: 'strength',
        startedAt: '2026-09-18T08:00:00.000Z',
        timezone: 'UTC',
        durationSeconds: 600,
        durationKind: 'timer',
        distanceMeters: null,
      },
      report: { sessionRpe: null, note: null, planLink: null },
      idempotencyKey: randomUUID(),
    });
    const methodId = randomUUID();
    const methodVersionId = randomUUID();
    const strategyId = randomUUID();
    const strategyVersionId = randomUUID();
    const optionId = randomUUID();
    const actionId = randomUUID();
    const actionRevisionId = randomUUID();
    const blueprintId = randomUUID();
    const blueprintVersionId = randomUUID();
    const scheduleId = randomUUID();
    const scheduleVersionId = randomUUID();
    const occurrenceId = randomUUID();
    const unresolvedOccurrenceId = randomUUID();
    const runId = randomUUID();
    const unplannedRunId = randomUUID();
    const historicalScheduleId = randomUUID();
    const historicalScheduleVersionId = randomUUID();
    const historicalOccurrenceId = randomUUID();
    const historicalRunId = randomUUID();
    const exerciseId = randomUUID();
    const exerciseVersionId = randomUUID();
    const stretchLogId = randomUUID();
    const stretchRevisionId = randomUUID();
    await database.tenant(athlete, async (tx) => {
      const method = {
        schemaVersion: 1,
        methodId,
        versionId: methodVersionId,
        version: 1,
        title: 'User stretch recovery',
        category: 'manual_method',
        intendedUse: 'Personal record',
        applicability: [],
        cautions: [],
        sourceDescription: 'User input',
        evidenceLimitations: 'Not reviewed',
        reviewState: 'unreviewed',
        reviewedAt: null,
        source: 'user_recorded',
        createdAt: '2026-09-17T00:00:00.000Z',
      };
      await tx.query(
        `INSERT INTO recovery_method_version
         (athlete_id,method_id,version_id,version,record_json) VALUES($1,$2,$3,1,$4::jsonb)`,
        [athlete, methodId, methodVersionId, JSON.stringify(method)],
      );
      await tx.query(
        'INSERT INTO recovery_method_head(athlete_id,method_id,version,version_id) VALUES($1,$2,1,$3)',
        [athlete, methodId, methodVersionId],
      );
      const strategy = {
        schemaVersion: 1,
        strategyId,
        versionId: strategyVersionId,
        version: 1,
        previousVersionId: null,
        status: 'user_confirmed',
        selectedOptionId: optionId,
        createdAt: '2026-09-17T00:00:00.000Z',
        draft: {
          title: 'Recovery window',
          goal: 'Keep actions separate',
          startDate: '2026-09-18',
          endDateExclusive: '2026-09-20',
          timezone: 'UTC',
          knownFacts: [],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: [{ kind: 'training', aggregateId: plan.id, headVersionId: plan.id }],
          options: [
            {
              id: optionId,
              title: 'Manual recovery',
              kind: 'nonexercise_action',
              methodVersionId,
              explanation: 'Record only after performance',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              plannedAt: null,
              description: 'Review changes',
              policyVersion: null,
            },
          ],
        },
      };
      await tx.query(
        `INSERT INTO recovery_strategy_version
         (athlete_id,strategy_id,version_id,version,previous_version_id,previous_version,record_json)
         VALUES($1,$2,$3,1,NULL,NULL,$4::jsonb)`,
        [athlete, strategyId, strategyVersionId, JSON.stringify(strategy)],
      );
      await tx.query(
        'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
        [athlete, strategyId, strategyVersionId],
      );
      const action = {
        schemaVersion: 1,
        actionId,
        revisionId: actionRevisionId,
        revision: 1,
        status: 'active',
        recordedAt: '2026-09-18T10:05:00.000Z',
        methodVersionId,
        strategyVersionId,
        plannedOptionId: optionId,
        occurredAt: '2026-09-18T10:00:00.000Z',
        timezone: 'UTC',
        state: 'performed',
        durationSeconds: null,
        actualConditions: '',
        beforeCheckIn: null,
        afterCheckIn: null,
        discomfort: '',
        userNotes: '',
        source: 'user_confirmed',
      };
      await tx.query(
        `INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status)
         VALUES($1,$2,1,$3,'active')`,
        [athlete, actionId, actionRevisionId],
      );
      await tx.query(
        `INSERT INTO recovery_action_revision
         (athlete_id,action_id,revision,revision_id,status,record_json)
         VALUES($1,$2,1,$3,'active',$4::jsonb)`,
        [athlete, actionId, actionRevisionId, JSON.stringify(action)],
      );
      const blueprint = {
        schemaVersion: 4,
        routineId: blueprintId,
        versionId: blueprintVersionId,
        title: 'Recovery routine',
        intent: 'Group existing ledgers',
        status: 'published',
        tags: [],
        steps: [],
        choiceGroups: [],
        estimatedDurationSeconds: 600,
        createdAt: '2026-09-17T00:00:00.000Z',
      };
      await tx.query(
        `INSERT INTO routine_blueprint_version
         (athlete_id,routine_id,version_id,version,previous_version_id,record_json,created_at)
         VALUES($1,$2,$3,1,NULL,$4::jsonb,$5)`,
        [athlete, blueprintId, blueprintVersionId, JSON.stringify(blueprint), blueprint.createdAt],
      );
      await tx.query(
        `INSERT INTO routine_blueprint_head
         (athlete_id,routine_id,version_id,version,visibility) VALUES($1,$2,$3,1,'active')`,
        [athlete, blueprintId, blueprintVersionId],
      );
      const schedule = {
        schemaVersion: 4,
        id: scheduleId,
        versionId: scheduleVersionId,
        blueprint: { id: blueprintId, versionId: blueprintVersionId },
        window: {
          startDate: '2026-09-18',
          endDateExclusive: '2026-09-20',
          timezone: 'UTC',
          maxOccurrences: 2,
        },
        rule: { kind: 'dates', dates: ['2026-09-18'], localTime: '11:00' },
        state: 'active',
      };
      await tx.query(
        `INSERT INTO routine_schedule_version
         (athlete_id,schedule_id,version_id,blueprint_routine_id,blueprint_version_id,
          source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          athlete,
          scheduleId,
          scheduleVersionId,
          blueprintId,
          blueprintVersionId,
          plan.id,
          JSON.stringify(schedule),
        ],
      );
      await tx.query(
        'INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)',
        [athlete, scheduleId, scheduleVersionId],
      );
      const occurrence = (id: string, scheduledAt: string | null) => ({
        id,
        schedule: { id: scheduleId, versionId: scheduleVersionId },
        blueprint: { id: blueprintId, versionId: blueprintVersionId },
        anchorKey: scheduledAt === null ? 'unresolved' : 'resolved',
        scheduledAt,
        timingStatus: scheduledAt === null ? 'unresolved' : 'resolved',
        stepBindings: [],
        selectedChoices: {},
      });
      for (const item of [
        occurrence(occurrenceId, '2026-09-18T11:00:00.000Z'),
        occurrence(unresolvedOccurrenceId, null),
      ])
        await tx.query(
          `INSERT INTO routine_occurrence
           (athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,
            blueprint_version_id,anchor_key,scheduled_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            athlete,
            item.id,
            scheduleId,
            scheduleVersionId,
            blueprintId,
            blueprintVersionId,
            item.anchorKey,
            item.scheduledAt,
            JSON.stringify(item),
          ],
        );
      const run = {
        id: runId,
        revision: 0,
        blueprint: { id: blueprintId, versionId: blueprintVersionId },
        origin: { kind: 'planned', occurrenceId },
        state: 'ended',
        progress: [],
        selectedChoices: {},
        startedAt: '2026-09-18T11:00:00.000Z',
        endedAt: '2026-09-18T11:10:00.000Z',
      };
      await tx.query(
        `INSERT INTO routine_run
         (athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json)
         VALUES($1,$2,$3,$4,$5,0,'ended',$6::jsonb)`,
        [athlete, runId, blueprintId, blueprintVersionId, occurrenceId, JSON.stringify(run)],
      );
      const unplannedRun = {
        ...run,
        id: unplannedRunId,
        origin: { kind: 'unplanned' },
        startedAt: '2026-09-18T12:00:00.000Z',
        endedAt: '2026-09-18T12:10:00.000Z',
      };
      await tx.query(
        `INSERT INTO routine_run
         (athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json)
         VALUES($1,$2,$3,$4,NULL,0,'ended',$5::jsonb)`,
        [athlete, unplannedRunId, blueprintId, blueprintVersionId, JSON.stringify(unplannedRun)],
      );
      const historicalSchedule = {
        ...schedule,
        id: historicalScheduleId,
        versionId: historicalScheduleVersionId,
      };
      await tx.query(
        `INSERT INTO routine_schedule_version
         (athlete_id,schedule_id,version_id,blueprint_routine_id,blueprint_version_id,
          source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          athlete,
          historicalScheduleId,
          historicalScheduleVersionId,
          blueprintId,
          blueprintVersionId,
          plan.id,
          JSON.stringify(historicalSchedule),
        ],
      );
      const historicalOccurrence = {
        ...occurrence(historicalOccurrenceId, '2026-09-18T13:00:00.000Z'),
        schedule: { id: historicalScheduleId, versionId: historicalScheduleVersionId },
      };
      await tx.query(
        `INSERT INTO routine_occurrence
         (athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,
          blueprint_version_id,anchor_key,scheduled_at,record_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          athlete,
          historicalOccurrenceId,
          historicalScheduleId,
          historicalScheduleVersionId,
          blueprintId,
          blueprintVersionId,
          historicalOccurrence.anchorKey,
          historicalOccurrence.scheduledAt,
          JSON.stringify(historicalOccurrence),
        ],
      );
      const historicalRun = {
        ...run,
        id: historicalRunId,
        origin: { kind: 'planned', occurrenceId: historicalOccurrenceId },
        startedAt: '2026-09-18T13:00:00.000Z',
        endedAt: '2026-09-18T13:10:00.000Z',
      };
      await tx.query(
        `INSERT INTO routine_run
         (athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json)
         VALUES($1,$2,$3,$4,$5,0,'ended',$6::jsonb)`,
        [
          athlete,
          historicalRunId,
          blueprintId,
          blueprintVersionId,
          historicalOccurrenceId,
          JSON.stringify(historicalRun),
        ],
      );
      const exercise = {
        schemaVersion: 2,
        exerciseId,
        versionId: exerciseVersionId,
        family: 'stretching',
        reviewState: 'unreviewed',
      };
      await tx.query(
        `INSERT INTO supplementary_exercise_version
         (athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json)
         VALUES($1,$2,$3,1,NULL,NULL,'2026-09-17T00:00:00Z',$4::jsonb)`,
        [athlete, exerciseId, exerciseVersionId, JSON.stringify(exercise)],
      );
      await tx.query(
        'INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id) VALUES($1,$2,1,$3)',
        [athlete, exerciseId, exerciseVersionId],
      );
      await tx.query(
        'INSERT INTO stretch_profile(athlete_id,exercise_version_id,profile_json) VALUES($1,$2,$3::jsonb)',
        [athlete, exerciseVersionId, JSON.stringify({ method: 'static_hold' })],
      );
      await tx.query(
        `INSERT INTO stretching_log
         (athlete_id,id,activity_id,exercise_version_id,current_revision,current_revision_id,status)
         VALUES($1,$2,$3,$4,1,$5,'active')`,
        [athlete, stretchLogId, activity.activityId, exerciseVersionId, stretchRevisionId],
      );
      await tx.query(
        `INSERT INTO stretching_log_revision
         (athlete_id,log_id,activity_id,exercise_version_id,revision,revision_id,status,recorded_at,record_json)
         VALUES($1,$2,$3,$4,1,$5,'active','2026-09-18T08:05:00Z',$6::jsonb)`,
        [
          athlete,
          stretchLogId,
          activity.activityId,
          exerciseVersionId,
          stretchRevisionId,
          JSON.stringify({
            logId: stretchLogId,
            activityId: activity.activityId,
            exerciseVersionId,
            revisionId: stretchRevisionId,
            revision: 1,
          }),
        ],
      );
    });

    const query = { from: '2026-09-18', toExclusive: '2026-09-20', timezone: 'UTC' };
    const planner = createIntegratedPlannerRepository(database);
    const legacyBefore = await planner.read(athlete, query);
    let statements = 0;
    const snapshotDatabase: Database = {
      tenant: (athleteId, operation) =>
        database.tenant(athleteId, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (statement, values) => {
              statements += 1;
              return tx.query(statement, values);
            },
          }),
        ),
      exclusiveTenant: (athleteId, operation) => database.exclusiveTenant(athleteId, operation),
      close: () => database.close(),
    };
    const read = await createIntegratedPlannerRepository(snapshotDatabase).readV4(athlete, query);
    expect(statements).toBe(1);
    expect(await planner.read(athlete, query)).toEqual(legacyBefore);
    expect(read.schemaVersion).toBe(4);
    expect(read.recoveryStrategyVersionIds).toEqual([strategyVersionId]);
    expect(read.routineScheduleVersionIds).toEqual([scheduleVersionId]);
    expect(read.days[0]).toMatchObject({
      recoveryPlans: [{ strategyId, versionId: strategyVersionId }],
      recoveryActions: [{ actionId, revision: 1, methodVersionId }],
      routineOccurrences: [{ occurrenceId, scheduleId, scheduleVersionId }],
      stretchingActivityIds: [activity.activityId],
      summary: {
        training: { actualActivityCount: 1 },
      },
    });
    expect(read.days[0]?.routineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId, occurrenceId }),
        expect.objectContaining({ runId: unplannedRunId, occurrenceId: null }),
        expect.objectContaining({ runId: historicalRunId, occurrenceId: historicalOccurrenceId }),
      ]),
    );
    expect(read.days[0]?.routineRuns).toHaveLength(3);
    expect(read.summary).toMatchObject({
      training: { actualActivityCount: 1 },
      recovery: { plannedStrategyCount: 1, actualActionCount: 1 },
      routines: { occurrenceCount: 1, runCount: 3 },
      stretchingActivityCount: 1,
    });
    expect(read.days.flatMap((day) => day.routineOccurrences)).toHaveLength(1);
    const foreign = await planner.readV4(randomUUID(), query);
    expect(foreign.summary).toMatchObject({
      training: { actualActivityCount: 0 },
      recovery: { plannedStrategyCount: 0, actualActionCount: 0 },
      routines: { occurrenceCount: 0, runCount: 0 },
      stretchingActivityCount: 0,
    });
  });
});
