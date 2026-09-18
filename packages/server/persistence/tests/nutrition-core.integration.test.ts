import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateIntakeEntryRequest,
  NutritionPlanDraft,
  SaveFoodDefinitionVersionRequest,
} from '@workout/contracts/nutrition-core';
import { createDatabase, type Database } from '../src/database.js';
import { grantNutritionCore, grantOperations, migrate } from '../src/migrate.js';
import { createNutritionRepository } from '../src/nutrition-core.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const makeRepository = () =>
  createNutritionRepository(database, {
    now: () => new Date('2026-09-19T00:00:00.000Z'),
  });
beforeAll(async () => {
  await migrate(adminUrl);
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON outbox TO workout_runtime');
  await admin.query(
    'GRANT SELECT ON plan_snapshot,activity_canonical,tenant_erasure TO workout_runtime',
  );
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
const nutrients = () => ({
  energy: unknown('kcal'),
  carbohydrate: unknown('g'),
  protein: unknown('g'),
  fat: unknown('g'),
  fluid: unknown('mL'),
  sodium: unknown('mg'),
});
function draft(): NutritionPlanDraft {
  return {
    period: { from: '2026-09-01', toInclusive: '2026-09-30' },
    timezone: 'UTC',
    purpose: 'User meal notes',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal-1',
        category: 'meal',
        title: 'Breakfast',
        anchor: { kind: 'absolute', date: '2026-09-18', localTime: null, timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'Eat when ready',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}
function food(foodId = 'oats'): SaveFoodDefinitionVersionRequest {
  return {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId,
      name: 'Oats',
      basis: { kind: 'per_100g' },
      nutrients: nutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-09-18T00:00:00.000Z',
        reviewState: 'unreviewed',
      },
    },
  };
}
function intake(foodVersionId: string, intakeId: string = randomUUID()): CreateIntakeEntryRequest {
  return {
    idempotencyKey: randomUUID(),
    intakeId,
    confirmed: true,
    occurredAt: '2026-09-18T08:00:00.000Z',
    timezone: 'UTC',
    foods: [
      { foodVersionId, description: 'Oats', quantity: 0, unit: 'g', sourceBasis: 'per_100g' },
    ],
    nutrientTotal: {
      ...nutrients(),
      energy: {
        value: 0,
        unit: 'kcal',
        status: 'reported',
        evidenceIds: [],
      },
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  };
}

describe('M1b-01 nutrition persistence', () => {
  it('stores immutable user-approved plans separately from actual intake and enforces head CAS', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const request = {
      kind: 'create' as const,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
      draft: draft(),
    };
    const first = await repository.savePlan(athlete, request);
    expect(await repository.savePlan(athlete, request)).toEqual(first);
    expect(first.items[0]?.planVersionId).toBe(first.versionId);
    expect(
      (
        await repository.listIntakes(athlete, {
          from: '2026-09-18T00:00:00.000Z',
          toExclusive: '2026-09-19T00:00:00.000Z',
          limit: 10,
          cursor: null,
        })
      ).coverage,
    ).toMatchObject({ status: 'unknown', knownEntries: 0 });
    const second = await repository.savePlan(athlete, {
      kind: 'update',
      planId: first.planId,
      expectedHeadVersionId: first.versionId,
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: { ...draft(), purpose: 'Revised' },
    });
    expect(second).toMatchObject({
      planId: first.planId,
      version: 2,
      previousVersionId: first.versionId,
    });
    expect((await repository.readPlan(athlete, first.planId))?.head).toEqual(second);
    expect(
      (
        await repository.listPlans(athlete, {
          from: '2026-09-18',
          toInclusive: '2026-09-18',
          limit: 10,
          cursor: null,
        })
      ).plans,
    ).toEqual([second]);
    await expect(
      repository.savePlan(athlete, {
        kind: 'update',
        planId: first.planId,
        expectedHeadVersionId: first.versionId,
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: draft(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      repository.savePlan(athlete, {
        ...request,
        draft: { ...draft(), purpose: 'Changed same key' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM nutrition_plan_history')).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM intake_entry')).rowCount).toBe(0);
    });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query("UPDATE nutrition_plan_version SET record_json='{}'::jsonb"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('freezes food definitions and intake revisions, preserving reported zero versus unknown', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const foodRequest = food();
    const firstFood = await repository.saveFood(athlete, foodRequest);
    expect(await repository.saveFood(athlete, foodRequest)).toEqual(firstFood);
    const createRequest = intake(firstFood.versionId);
    const first = await repository.createIntake(athlete, createRequest);
    expect(await repository.createIntake(athlete, createRequest)).toEqual(first);
    await expect(
      repository.createIntake(athlete, {
        ...createRequest,
        notes: 'Changed under the same key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const newerFood = await repository.saveFood(athlete, {
      ...food(firstFood.foodId),
      expectedVersionId: firstFood.versionId,
      definition: { ...food(firstFood.foodId).definition, name: 'Updated oats' },
    });
    expect(newerFood.version).toBe(2);
    expect(first.foods[0]?.foodVersionId).toBe(firstFood.versionId);
    expect(first.nutrientTotal.energy).toMatchObject({ value: 0, status: 'reported' });
    expect(first.nutrientTotal.protein).toMatchObject({ value: null, status: 'unknown' });
    expect(first.nutrientValueCoverage).toBe('partial');
    const input = intake(firstFood.versionId, first.intakeId);
    const corrected = await repository.correctIntake(athlete, {
      ...input,
      expectedRevision: 1,
      notes: 'Corrected portion',
    });
    expect(corrected.revision).toBe(2);
    expect((await repository.readIntake(athlete, first.intakeId))?.revisionId).toBe(
      corrected.revisionId,
    );
    expect(
      (
        await repository.listIntakes(athlete, {
          from: '2026-09-18T00:00:00.000Z',
          toExclusive: '2026-09-19T00:00:00.000Z',
          limit: 10,
          cursor: null,
        })
      ).coverage,
    ).toMatchObject({ status: 'partial', knownEntries: 1, entriesWithUnknownNutrients: 1 });
    const deleted = await repository.deleteIntake(athlete, {
      idempotencyKey: randomUUID(),
      intakeId: first.intakeId,
      expectedRevision: 2,
      confirmed: true,
      reason: 'user_requested',
    });
    expect(await repository.readIntake(athlete, first.intakeId)).toEqual(deleted);
    const listing = await repository.listIntakes(athlete, {
      from: '2026-09-18T00:00:00.000Z',
      toExclusive: '2026-09-19T00:00:00.000Z',
      limit: 10,
      cursor: null,
    });
    expect(listing.entries).toEqual([]);
    expect(listing.coverage.knownEntries).toBe(0);
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM intake_entry_revision')).rowCount).toBe(3);
    });
    await expect(
      database.tenant(athlete, (tx) => tx.query('DELETE FROM intake_entry_revision')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('paginates adjacent microsecond intake instants without skipping the next row', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const savedFood = await repository.saveFood(athlete, food());
    const base = intake(savedFood.versionId);
    const newer = await repository.createIntake(athlete, {
      ...base,
      intakeId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: '2026-09-18T08:00:00.123900Z',
    });
    const older = await repository.createIntake(athlete, {
      ...base,
      intakeId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: '2026-09-18T08:00:00.123800Z',
    });
    const range = {
      from: '2026-09-18T00:00:00.000Z',
      toExclusive: '2026-09-19T00:00:00.000Z',
      limit: 1,
    };
    const first = await repository.listIntakes(athlete, { ...range, cursor: null });
    expect(first.entries.map((entry) => entry.intakeId)).toEqual([newer.intakeId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.listIntakes(athlete, {
      ...range,
      cursor: first.nextCursor,
    });
    expect(second.entries.map((entry) => entry.intakeId)).toEqual([older.intakeId]);
    expect(second.nextCursor).toBeNull();
  });

  it('isolates owners, rejects foreign food links, and serializes competing creates', async () => {
    const repository = makeRepository();
    const owner = randomUUID();
    const other = randomUUID();
    const savedFood = await repository.saveFood(owner, food());
    expect(await repository.readFood(other, savedFood.foodId)).toBeNull();
    await expect(repository.createIntake(other, intake(savedFood.versionId))).rejects.toMatchObject(
      { code: 'FOOD_LINK_INVALID' },
    );
    const sameId = randomUUID();
    const attempts = await Promise.allSettled([
      repository.createIntake(owner, intake(savedFood.versionId, sameId)),
      repository.createIntake(owner, intake(savedFood.versionId, sameId)),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    await database.tenant(other, async (tx) => {
      expect((await tx.query('SELECT * FROM intake_entry')).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM food_definition_version')).rows).toEqual([]);
    });
  });

  it('fails closed on unknown training, planned item, session and activity links', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const savedFood = await repository.saveFood(athlete, food());
    await expect(
      repository.savePlan(athlete, {
        kind: 'create',
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: { ...draft(), linkedTrainingPlanVersionId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_LINK_INVALID' });
    const relativeDraft = draft();
    const relativeItem = relativeDraft.items[0];
    if (!relativeItem) throw new Error('Missing relative item fixture');
    relativeItem.anchor = {
      kind: 'relative',
      entity: 'session',
      entityId: 'unknown-session',
      point: 'start',
      offsetMinutes: 0,
    };
    await expect(
      repository.savePlan(athlete, {
        kind: 'create',
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: relativeDraft,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_LINK_INVALID' });
    const base = intake(savedFood.versionId);
    await expect(
      repository.createIntake(athlete, {
        ...base,
        plannedItemId: 'foreign-item',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_LINK_INVALID' });
    await expect(
      repository.createIntake(athlete, {
        ...base,
        relatedSessionIds: ['foreign-session'],
      }),
    ).rejects.toMatchObject({ code: 'SESSION_LINK_INVALID' });
    await expect(
      repository.createIntake(athlete, {
        ...base,
        relatedActivityIds: [randomUUID()],
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_LINK_INVALID' });
    expect(await repository.readIntake(athlete, base.intakeId)).toBeNull();
  });

  it('rolls back an intake when the outbox write fails', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const savedFood = await repository.saveFood(athlete, food());
    const request = intake(savedFood.versionId);
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload) VALUES($1,$2,$3,'fixture.collision','{}')",
        [athlete, randomUUID(), `nutrition-intake:${request.idempotencyKey}`],
      ),
    );
    await expect(repository.createIntake(athlete, request)).rejects.toThrow();
    expect(await repository.readIntake(athlete, request.intakeId)).toBeNull();
  });

  it('permits only one concurrent correction and erases all nutrition revisions', async () => {
    const repository = makeRepository();
    const athlete = randomUUID();
    const savedPlan = await repository.savePlan(athlete, {
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: draft(),
    });
    const savedFood = await repository.saveFood(athlete, food());
    const created = await repository.createIntake(athlete, intake(savedFood.versionId));
    const correction = intake(savedFood.versionId, created.intakeId);
    const attempts = await Promise.allSettled([
      repository.correctIntake(athlete, {
        ...correction,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        notes: 'First',
      }),
      repository.correctIntake(athlete, {
        ...correction,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        notes: 'Second',
      }),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    await database.exclusiveTenant(athlete, async (tx) => {
      await tx.query('SELECT public.erase_account($1)', [athlete]);
    });
    for (const table of [
      'nutrition_plan_version',
      'nutrition_plan_head',
      'nutrition_plan_history',
      'food_definition_version',
      'food_definition_head',
      'intake_entry',
      'intake_entry_revision',
    ]) {
      const rows = await admin.query(`SELECT 1 FROM ${table} WHERE athlete_id=$1`, [athlete]);
      expect(rows.rowCount).toBe(0);
    }
    const receipts = await admin.query('SELECT 1 FROM command_receipt WHERE athlete_id=$1', [
      athlete,
    ]);
    expect(receipts.rowCount).toBe(0);
    expect(savedPlan.planId).toBeTruthy();
  });
});
