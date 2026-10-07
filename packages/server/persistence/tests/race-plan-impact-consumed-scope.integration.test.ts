import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import {
  foodDefinitionVersionSchema,
  saveFoodDefinitionVersionRequestSchema,
} from '@workout/contracts/nutrition-core';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  captureRacePlanImpactConsumedScope,
  captureRacePlanImpactContext,
} from '../src/race-plan-impact-context.js';
import {
  validateRaceImpactConsumedManifest,
  type RaceImpactConsumedScope,
} from '../src/race-plan-impact-complete-manifest.js';
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
// Normal107 public producers only. A structural consumed scope never proves
// approval freshness, complete capture, storage authority or external restore.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `consumed_scope_${suffix}`,
  ownerRole = `consumed_owner_${suffix}`,
  runtimeRole = `consumed_app_${suffix}`;
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
async function event(athlete: string) {
  await app(athlete, true);
  return createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic scope race',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
}
const intent = (id: string, expectedRevision = 1) => ({
  eventId: id,
  expectedRevision,
  selection: { kind: 'keep_plan' as const },
});
function scope(
  c: Awaited<ReturnType<typeof captureRacePlanImpactContext>>,
): RaceImpactConsumedScope {
  if (c.manualBasis.app.state !== 'present') throw Error('FIXTURE_APP_ABSENT');
  return {
    purpose: c.manualBasis.purpose,
    athleteId: c.athleteId,
    restoreGeneration: c.restoreGeneration,
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    expectedPolicy: c.manualBasis.policy,
    expectedAppRevision: c.manualBasis.app.revision,
    expectedReadSetDigest: c.readSetDigest,
  };
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

it('normal public empty race capture derives server scope and preserves blocked/full-coverage state and exact digest', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete);
  await db.tenant(athlete, async (tx) => {
    const artifacts = async () =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM race_command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox`,
          [athlete],
        )
      ).rows;
    const before = await artifacts();
    const result = await captureRacePlanImpactConsumedScope(tx, intent(saved.id));
    expect(result.capture.status).toBe('blocked');
    expect(result.capture.coverage.complete).toBe(false);
    expect(result.capture.coverage.missing).toHaveLength(5);
    expect(result.consumedScope).toMatchObject({
      status: 'validated_read_scope',
      approvalAuthority: 'none',
      freshness: 'not_checked',
      capturedReadSetDigest: result.capture.readSetDigest,
    });
    expect(result.capture.consumedSources.races).toEqual([result.capture.event]);
    expect(result.consumedScope).toEqual(
      validateRaceImpactConsumedManifest(result.capture, scope(result.capture)),
    );
    expect((await captureRacePlanImpactContext(tx, intent(saved.id))).readSetDigest).toBe(
      result.capture.readSetDigest,
    );
    expect(await artifacts()).toEqual(before);
  });
  // Compatibility provider ledger facts are not consumed provider content.
  const consents = createConsentRepository(db);
  await consents.setConsent(athlete, {
    kind: 'provider',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const granted = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(granted.consumedScope.status).toBe('validated_read_scope');
  await consents.setConsent(athlete, {
    kind: 'provider',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const withdrawn = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(withdrawn.consumedScope.status).toBe('validated_read_scope');
});
it('public current training and absolute unlinked nutrition correspond to exact captured roster without authorizing approval', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete);
  const training = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const nutrition = await createNutritionRepository(db).savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic absolute meal',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: 'Synthetic explicit meal action',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const result = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(result.capture.currentTraining?.snapshot.id).toBe(training.id);
  expect(result.capture.rosters.nutrition).toEqual([
    { aggregateId: nutrition.planId, versionId: nutrition.versionId },
  ]);
  expect(result.capture.nutrition[0]?.record).toEqual(nutrition);
  expect(result.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    nutritionVersions: [{ planId: nutrition.planId, versionId: nutrition.versionId }],
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
});
it('public withdrawal specifically blocks manual admission and regrant changes digest; stale expected app revision remains rejected', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete);
  const original = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  await app(athlete, false);
  const withdrawn = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(withdrawn.consumedScope).toEqual({
    status: 'blocked',
    blockers: [{ path: 'manualBasis.app', reason: 'manual_admission_unavailable' }],
  });
  expect(withdrawn.capture.readSetDigest).not.toBe(original.capture.readSetDigest);
  await app(athlete, true);
  const regranted = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(regranted.consumedScope.status).toBe('validated_read_scope');
  expect(regranted.capture.readSetDigest).not.toBe(original.capture.readSetDigest);
  expect(regranted.capture.event).toEqual(original.capture.event);
  const stale = validateRaceImpactConsumedManifest(regranted.capture, {
    ...scope(regranted.capture),
    expectedAppRevision: scope(original.capture).expectedAppRevision,
  });
  expect(stale).toMatchObject({
    status: 'blocked',
    blockers: expect.arrayContaining([{ path: 'scope', reason: 'scope_mismatch' }]),
  });
});
it('populated foreign event and client capture/digest/ready fields cannot become a server scope', async () => {
  const alice = randomUUID(),
    bob = randomUUID(),
    saved = await event(alice);
  await app(bob, true);
  await expect(
    db.tenant(bob, (tx) => captureRacePlanImpactConsumedScope(tx, intent(saved.id))),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await expect(
    db.tenant(alice, (tx) => captureRacePlanImpactConsumedScope(tx, intent(saved.id, 2))),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  for (const extra of [{ ready: true }, { readSetDigest: 'a'.repeat(64) }, { capture: {} }])
    await expect(
      db.tenant(alice, (tx) =>
        captureRacePlanImpactConsumedScope(tx, { ...intent(saved.id), ...extra }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('actual public session-relative nutrition validates exact readonly sources without claiming complete capture or approval', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete);
  const training = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const nutrition = await createNutritionRepository(db).savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic legacy relative',
      linkedTrainingPlanVersionId: training.id,
      items: [
        {
          id: 'race-meal',
          category: 'before',
          title: 'Meal',
          anchor: {
            kind: 'relative',
            entity: 'session',
            entityId: 'session',
            point: 'start',
            offsetMinutes: 0,
          },
          foods: [],
          targets: [],
          instructions: 'Synthetic explicit meal action',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const result = await db.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, intent(saved.id)),
  );
  expect(result.capture.nutrition).toHaveLength(1);
  expect(result.capture.coverage.complete).toBe(false);
  expect(result.capture.coverage.missing).toHaveLength(5);
  expect(result.capture.nutrition[0]?.record).toEqual(nutrition);
  expect(result.capture.nutrition[0]?.relativeItems).toEqual([
    {
      itemId: 'race-meal',
      entity: 'session',
      entityId: 'session',
      sourceVersionId: training.id,
      affected: false,
      point: 'start',
      timing: 'not_resolved',
    },
  ]);
  expect(result.capture.consumedSources.plans).toEqual([training]);
  expect(result.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
    nutritionVersions: [{ planId: nutrition.planId, versionId: nutrition.versionId }],
    capturedReadSetDigest: result.capture.readSetDigest,
  });
  if (result.consumedScope.status === 'validated_read_scope')
    expect(result.consumedScope.remaining).toHaveLength(5);
});

it('public food save, approved plan and later food head retain the exact historical definition/digest and zero/null portions', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    repository = createNutritionRepository(db);
  const datum = (unit: string, value: number | null) => ({
    value,
    unit,
    status: value === null ? 'unknown' : 'reported',
    evidenceIds: [],
  });
  const request = saveFoodDefinitionVersionRequestSchema.parse({
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
  });
  const original = await repository.saveFood(athlete, request);
  const nutrition = await repository.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Preserve historical food',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Original portions',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [
            {
              foodVersionId: original.versionId,
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
          instructions: '',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const captured = async () =>
    db.tenant(athlete, async (tx) => {
      const counts = async () =>
        (
          await tx.query(
            `SELECT
      (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts,
      (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS versions,
      (SELECT count(*)::int FROM nutrition_plan_history WHERE athlete_id=$1) AS history,
      (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox,
      (SELECT count(*)::int FROM intake_entry WHERE athlete_id=$1) AS intake`,
            [athlete],
          )
        ).rows;
      const before = await counts();
      const result = await captureRacePlanImpactConsumedScope(tx, intent(saved.id));
      expect(await counts()).toEqual(before);
      expect(result.capture.coverage.complete).toBe(false);
      expect(result.capture.coverage.missing).toHaveLength(5);
      expect(result.consumedScope).toMatchObject({
        status: 'validated_read_scope',
        approvalAuthority: 'none',
        freshness: 'not_checked',
      });
      if (result.consumedScope.status === 'validated_read_scope')
        expect(result.consumedScope.remaining).toHaveLength(5);
      expect(result.capture.nutrition[0]?.record).toEqual(nutrition);
      return result;
    });
  const foodFact = (result: Awaited<ReturnType<typeof captured>>) => {
    expect(result.capture.sourcePermissionManifest.nestedNutritionSources).toHaveLength(1);
    const nested = result.capture.sourcePermissionManifest.nestedNutritionSources[0];
    expect(nested?.foods).toHaveLength(1);
    return z
      .strictObject({
        requestedVersionId: z.uuid(),
        state: z.enum(['current', 'historical']),
        content: z.strictObject({
          foodId: z.string(),
          versionId: z.uuid(),
          digest: z.string(),
          record: foodDefinitionVersionSchema,
          provenance: z.json(),
        }),
        currentHead: z.strictObject({ versionId: z.uuid(), provenance: z.json() }),
      })
      .parse(nested?.foods[0]);
  };
  const before = await captured(),
    first = foodFact(before);
  expect(first.state).toBe('current');
  expect(first.currentHead.versionId).toBe(original.versionId);
  expect(first.content.record).toEqual(original);
  expect(first.content.digest).toBe(impactDependencyDigest(original));
  const updated = await repository.saveFood(athlete, {
    ...request,
    idempotencyKey: randomUUID(),
    expectedVersionId: original.versionId,
    definition: {
      ...request.definition,
      name: 'New current food',
      nutrients: {
        ...request.definition.nutrients,
        energy: { value: 200, unit: 'kcal', status: 'reported', evidenceIds: [] },
      },
      provenance: { ...request.definition.provenance, capturedAt: '2026-10-06T01:00:00Z' },
    },
  });
  expect(updated.version).toBe(2);
  expect(updated.previousVersionId).toBe(original.versionId);
  expect(await repository.readFood(athlete, original.foodId)).toEqual(updated);
  const after = await captured(),
    historical = foodFact(after);
  expect(historical.state).toBe('historical');
  expect(historical.requestedVersionId).toBe(original.versionId);
  expect(historical.content.foodId).toBe(original.foodId);
  expect(historical.content.versionId).toBe(original.versionId);
  expect(historical.content.record).toEqual(original);
  expect(historical.content.digest).toBe(impactDependencyDigest(original));
  expect(historical.currentHead.versionId).toBe(updated.versionId);
  expect(historical.content.provenance).toEqual(first.content.provenance);
  expect(historical.currentHead.provenance).toMatchObject({
    capturedAt: updated.provenance.capturedAt,
  });
  expect(historical.currentHead.provenance).not.toEqual(historical.content.provenance);
  expect(historical.content.record.nutrients.energy.value).toBe(0);
  expect(historical.content.record.nutrients.protein.value).toBeNull();
  expect(after.capture.nutrition[0]?.record.items[0]?.foods.map((food) => food.quantity)).toEqual([
    0,
    null,
  ]);
  expect((await repository.readPlan(athlete, nutrition.planId))?.head).toEqual(nutrition);
  expect(after.capture.readSetDigest).not.toBe(before.capture.readSetDigest);
});
