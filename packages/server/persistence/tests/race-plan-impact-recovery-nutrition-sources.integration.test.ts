import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { createRaceRepository } from '../src/races.js';
import { captureRacePlanImpactConsumedScope } from '../src/race-plan-impact-context.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema, planSnapshotSchema } from '@workout/contracts/planning';
import {
  nutritionPlanDraftSchema,
  saveFoodDefinitionVersionRequestSchema,
} from '@workout/contracts/nutrition-core';
import { recoveryStrategyDraftSchema } from '@workout/contracts/recovery-core';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { captureRecoveryNutritionSourceFacts } from '../src/race-plan-impact-recovery-nutrition-sources.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Normal107 exact public V1 nutrition sources. No V2/V3/V4 approval/SQL staging proof.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `recovery_nutrition_${suffix}`,
  ownerRole = `recovery_nutrition_owner_${suffix}`,
  runtimeRole = `recovery_nutrition_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const inspector = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (await inspector.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await inspector.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantOperations,
    grantRaces,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db),
    old = await repo.getConsent(athlete, 'app');
  return repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: old?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
const draft = () =>
  planDraftSchema.parse({
    title: 'Synthetic plan',
    timezone: 'Asia/Seoul',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, array) => ({
      id: level,
      parentId: index === 0 ? null : array[index - 1],
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: null,
        title: 'Synthetic planned session',
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

const refs = (planId: string, versionId: string) => [{ aggregateId: planId, versionId }];
const freshBudget = () => ({ bytes: 0n, sources: 0 });
async function capture(
  athlete: string,
  references: { aggregateId: string; versionId: string }[],
  budget = freshBudget(),
) {
  const consumedPlans: string[] = [];
  const result = await db.tenant(athlete, (tx) =>
    captureRecoveryNutritionSourceFacts(tx, references, budget, {
      plan: async (id) => {
        consumedPlans.push(id);
        const row = z
          .strictObject({
            id: z.uuid(),
            version: z.number().int().positive(),
            created_at: z.date(),
            draft: z.unknown(),
          })
          .parse(
            (
              await tx.query(
                'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid',
                [athlete, id],
              )
            ).rows[0],
          );
        return planSnapshotSchema.parse({
          id: row.id,
          version: row.version,
          createdAt: row.created_at.toISOString(),
          draft: row.draft,
        });
      },
      race: async (id) => {
        throw new Error(`FIXTURE_UNEXPECTED_RACE_SOURCE:${id.length}`);
      },
    }),
  );
  return { result, consumedPlans };
}
async function seed(athlete = randomUUID()) {
  await app(athlete, true);
  const planning = createPlanningRepository(db);
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const repo = createNutritionRepository(db);
  const datum = (unit: string, value: number | null) => ({
    unit,
    value,
    status: value === null ? 'unknown' : 'reported',
    evidenceIds: [],
  });
  const food = await repo.saveFood(
    athlete,
    saveFoodDefinitionVersionRequestSchema.parse({
      idempotencyKey: randomUUID(),
      confirmed: true,
      expectedVersionId: null,
      definition: {
        foodId: 'synthetic-food',
        name: 'Original saved food',
        basis: { kind: 'per_100g' },
        nutrients: {
          energy: datum('kcal', 0),
          carbohydrate: datum('g', null),
          protein: datum('g', null),
          fat: datum('g', null),
          fluid: datum('mL', null),
          sodium: datum('mg', null),
        },
        provenance: {
          kind: 'user_entered',
          reference: null,
          capturedAt: '2026-10-06T00:00:00Z',
          reviewState: 'unreviewed',
        },
      },
    }),
  );
  const meal = nutritionPlanDraftSchema.parse({
    period: { from: '2026-10-01', toInclusive: '2026-10-31' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic historical meal',
    linkedTrainingPlanVersionId: plan.id,
    items: [
      {
        id: 'meal',
        category: 'meal',
        title: 'Original portions',
        anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
        foods: [
          {
            foodVersionId: food.versionId,
            description: 'Reported zero',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'per_100g',
          },
          {
            foodVersionId: null,
            description: 'Unknown amount',
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'unknown',
          },
        ],
        targets: [],
        instructions: 'Preserved',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  const nutrition = await repo.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: meal,
  });
  const strategy = await createRecoveryRepository(db).createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: recoveryStrategyDraftSchema.parse({
      title: 'Synthetic recovery source',
      goal: 'Preserve sources',
      startDate: '2026-10-01',
      endDateExclusive: '2026-10-31',
      timezone: 'Asia/Seoul',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [
        { kind: 'nutrition', aggregateId: nutrition.planId, headVersionId: nutrition.versionId },
      ],
      options: [
        {
          id: randomUUID(),
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'No actual created',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'user_report_changed',
          plannedAt: null,
          description: 'Explicit review',
          policyVersion: null,
        },
      ],
    }),
  });
  return { athlete, plan, food, meal, nutrition, strategy, repo, planning };
}
it('actual public recovery strategy retains exact historical nutrition and nested food/linked plan after head changes', async () => {
  const f = await seed();
  const next = await f.repo.savePlan(f.athlete, {
    kind: 'update',
    planId: f.nutrition.planId,
    expectedHeadVersionId: f.nutrition.versionId,
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: { ...f.meal, purpose: 'Changed current meal' },
  });
  const newerPlan = await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'New current training' },
  });
  const ref = f.strategy.draft.planRefs[0];
  if (!ref || ref.kind !== 'nutrition') throw Error('FIXTURE_NUTRITION_REFERENCE');
  const { result, consumedPlans } = await capture(
    f.athlete,
    refs(ref.aggregateId, ref.headVersionId),
  );
  expect(result.records).toEqual([f.nutrition]);
  expect(result.facts).toEqual([
    {
      requested: refs(f.nutrition.planId, f.nutrition.versionId)[0],
      state: 'historical',
      reason: null,
      content: { digest: impactDependencyDigest(f.nutrition) },
      currentHead: { aggregateId: f.nutrition.planId, versionId: next.versionId },
    },
  ]);
  expect(result.nestedSources.loadedPlans).toEqual([f.plan]);
  expect(consumedPlans).toEqual([f.plan.id]);
  expect(result.nestedSources.nutrition[0]).toMatchObject({
    versionId: f.nutrition.versionId,
    foods: [{ requestedVersionId: f.food.versionId, content: { record: f.food } }],
    linkedPlan: {
      state: 'historical',
      requestedVersionId: f.plan.id,
      content: { digest: impactDependencyDigest(f.plan) },
      currentHead: { version_id: newerPlan.id },
    },
  });
  expect(result.records[0]?.items[0]?.foods.map((v) => v.quantity)).toEqual([0, null]);
  expect(result).toMatchObject({ authority: 'none', freshness: 'not_checked' });
});
it('full capture keeps recovery-consumed historical nutrition separate from the current nutrition roster', async () => {
  const f = await seed();
  const next = await f.repo.savePlan(f.athlete, {
    kind: 'update',
    planId: f.nutrition.planId,
    expectedHeadVersionId: f.nutrition.versionId,
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: { ...f.meal, purpose: 'Current version is a different immutable body' },
  });
  const race = await createRaceRepository(db).createRaceEvent(f.athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic source capture',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    },
  });
  const captured = await db.tenant(f.athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: race.id,
      expectedRevision: race.revision,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(captured.capture.rosters.nutrition).toEqual([
    { aggregateId: next.planId, versionId: next.versionId },
  ]);
  expect(captured.capture.nutrition.map((row) => row.record)).toEqual([next]);
  expect(captured.capture.recoveryNutritionSources.records).toEqual([f.nutrition]);
  expect(captured.capture.recoveryNutritionSources.nestedSources.nutrition[0]).toMatchObject({
    versionId: f.nutrition.versionId,
    foods: [{ requestedVersionId: f.food.versionId, content: { record: f.food } }],
  });
  expect(captured.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(captured.capture.coverage.complete).toBe(false);
  expect(captured.capture.coverage.missing).toHaveLength(5);
});
it('current tuples and repeated normalized refs dedup bodies and nested source cache deterministically', async () => {
  const f = await seed();
  const requested = refs(f.nutrition.planId, f.nutrition.versionId)[0];
  if (!requested) throw Error('FIXTURE_REF');
  const one = await capture(f.athlete, [requested]);
  const repeated = await capture(f.athlete, [
    requested,
    {
      aggregateId: requested.aggregateId.toUpperCase(),
      versionId: requested.versionId.toUpperCase(),
    },
    requested,
  ]);
  expect(repeated).toEqual(one);
  expect(one.result.facts[0]?.state).toBe('current');
  expect(one.consumedPlans).toEqual([f.plan.id]);
});
it('populated foreign, missing and mismatched aggregate tuples remain contentless without nested body reads', async () => {
  const f = await seed(),
    bob = randomUUID();
  await app(bob, true);
  for (const [athlete, requested] of [
    [bob, refs(f.nutrition.planId, f.nutrition.versionId)],
    [f.athlete, refs(randomUUID(), f.nutrition.versionId)],
    [f.athlete, refs(f.nutrition.planId, randomUUID())],
  ] as const) {
    const { result, consumedPlans } = await capture(athlete, [...requested]);
    expect(result.records).toEqual([]);
    expect(result.nestedSources).toEqual({ nutrition: [], loadedPlans: [] });
    expect(consumedPlans).toEqual([]);
    expect(result.facts).toEqual([
      {
        requested: requested[0],
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      },
    ]);
  }
});
it('5000 visited refs and whole shared byte budget fail before loading protected bodies', async () => {
  const f = await seed(),
    requested = refs(f.nutrition.planId, f.nutrition.versionId)[0];
  if (!requested) throw Error('FIXTURE_REF');
  await expect(
    capture(
      f.athlete,
      Array.from({ length: 5001 }, () => requested),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  await expect(
    capture(f.athlete, [requested], { bytes: 4194300n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
  await expect(capture(f.athlete, [requested], { bytes: 0n, sources: 5000 })).rejects.toMatchObject(
    { code: 'CONTEXT_UNAVAILABLE', bound: 'unique_sources' },
  );
  const forged = { ...requested, body: 'client supplied' };
  await expect(capture(f.athlete, [forged])).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
