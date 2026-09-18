import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActivityRepository } from '../src/activities.js';
import { createDatabase, type Database } from '../src/database.js';
import { createIntegratedPlannerRepository } from '../src/integrated-planner.js';
import {
  grantNutritionCore,
  grantOperations,
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
});
