import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createActivityRepository } from '../src/activities.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { saveFoodDefinitionVersionRequestSchema } from '@workout/contracts/nutrition-core';
import { planDraftSchema } from '@workout/contracts/planning';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import {
  migrate,
  grantCorePlanning,
  grantSupplementaryCore,
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
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `semantic_basis_${suffix}`,
  ownerRole = `semantic_basis_owner_${suffix}`,
  runtimeRole = `semantic_basis_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
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
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  const migrationOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await migrationOwner.query(
      await readFile(
        new URL(
          '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await migrationOwner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
    expect(
      (await migrationOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await migrationOwner.end();
  }

  for (const grant of [
    grantCorePlanning,
    grantSupplementaryCore,
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
  const activityOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    // Same seven-table Activity composition as the existing API/public channel fixture.
    await activityOwner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await activityOwner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function setup() {
  const athlete = randomUUID();
  const owner = new Pool({ connectionString: url(ownerRole) });
  // Identity-only FK prerequisite. No owner health/source/admission rows.
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  const consent = createConsentRepository(db);
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await consent.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic manual binding',
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
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' as const },
  };
  return { athlete, consent, intent };
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

const service = () => createRaceManualSemanticBasisV2Service(db);
async function basis(f: Awaited<ReturnType<typeof setup>>) {
  const r = await service().prepare(f.athlete, f.intent);
  if (!('basis' in r)) throw Error('ACTUAL_BASIS_MISSING');
  expect(r.status).toBe('current_dependencies_captured');
  return r;
}
it('actual unused AI/provider/HK/media consent drift leaves semantic dependencies stable but raw capture differs', async () => {
  const f = await setup(),
    old = await basis(f);
  for (const kind of ['provider', 'healthkit', 'media'] as const)
    await f.consent.setConsent(f.athlete, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  await f.consent.setConsent(f.athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const fresh = await service().prepare(f.athlete, f.intent, old.basis);
  expect(fresh.status).toBe('current_dependencies_captured');
  if (!('basis' in fresh)) throw Error('BASIS_MISSING');
  expect(fresh.semanticDigest).toBe(old.semanticDigest);
  expect(fresh.rawReadSetDigest).not.toBe(old.rawReadSetDigest);
});
it('actual absent training head first public plan and relevant current head move invalidate original basis', async () => {
  const f = await setup(),
    old = await basis(f),
    plans = createPlanningRepository(db);
  expect(old.basis.core.trainingPlan.kind).toBe('absent');
  const p = await plans.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const afterFirst = await service().prepare(f.athlete, f.intent, old.basis);
  expect(afterFirst).toMatchObject({ status: 'blocked', reason: 'semantic_basis_changed' });
  const current = await basis(f);
  await plans.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: p.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Actual new current head' },
  });
  expect(await service().prepare(f.athlete, f.intent, current.basis)).toMatchObject({
    status: 'blocked',
    reason: 'semantic_basis_changed',
  });
});
it('app reallow revision and foreign/generation optimistic expectations block without minting authority', async () => {
  const f = await setup(),
    old = await basis(f);
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(service().prepare(f.athlete, f.intent, old.basis)).rejects.toMatchObject({
    code: 'APP_CONSENT_REQUIRED',
  });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await service().prepare(f.athlete, f.intent, old.basis)).toMatchObject({
    status: 'blocked',
    reason: 'semantic_basis_changed',
    approvalAllowed: false,
  });
  expect(
    await service().prepare(f.athlete, f.intent, { ...old.basis, athleteId: randomUUID() }),
  ).toMatchObject({ status: 'blocked', reason: 'semantic_basis_changed' });
  expect(
    await service().prepare(f.athlete, f.intent, { ...old.basis, restoreGeneration: randomUUID() }),
  ).toMatchObject({ status: 'blocked', reason: 'semantic_basis_changed' });
});

it('frozen consumed food version stays semantic-stable when an irrelevant catalog head advances', async () => {
  const f = await setup(),
    nutrition = createNutritionRepository(db);
  const datum = (unit: string, value: number | null) => ({
    value,
    unit,
    status: value === null ? 'unknown' : 'reported',
    evidenceIds: [],
  });
  const definition = {
    foodId: 'Food-한글-A',
    name: 'Frozen',
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
  };
  const food = await nutrition.saveFood(f.athlete, {
    idempotencyKey: randomUUID(),
    confirmed: true,
    expectedVersionId: null,
    definition: saveFoodDefinitionVersionRequestSchema.shape.definition.parse(definition),
  });
  await nutrition.savePlan(f.athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Frozen portions',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'Long-한글-' + 'x'.repeat(220),
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [
            {
              foodVersionId: food.versionId,
              description: 'Zero',
              quantity: 0,
              unit: 'g',
              sourceBasis: 'per_100g',
            },
            {
              foodVersionId: null,
              description: 'Unknown',
              quantity: null,
              unit: 'g',
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
  const old = await basis(f);
  await nutrition.saveFood(f.athlete, {
    idempotencyKey: randomUUID(),
    confirmed: true,
    expectedVersionId: food.versionId,
    definition: saveFoodDefinitionVersionRequestSchema.shape.definition.parse({
      ...definition,
      name: 'New irrelevant catalog head',
    }),
  });
  const fresh = await service().prepare(f.athlete, f.intent, old.basis);
  expect(fresh.status).toBe('current_dependencies_captured');
  if (!('basis' in fresh)) throw Error('BASIS_MISSING');
  expect(fresh.semanticDigest).toBe(old.semanticDigest);
  expect(fresh.rawReadSetDigest).not.toBe(old.rawReadSetDigest);
  expect(
    fresh.basis.copiedSources.find((r) => r.identity.kind === 'food-definition-version'),
  ).toEqual(old.basis.copiedSources.find((r) => r.identity.kind === 'food-definition-version'));
});

it('public delete/create replaces live roster with identical live count/sum but stale exact semantic basis', async () => {
  const f = await setup(),
    activities = createActivityRepository(db),
    service = createRaceManualSemanticBasisV2Service(db);
  const create = () =>
    activities.createManualActivity(f.athlete, {
      idempotencyKey: randomUUID(),
      confirmed: true,
      activity: {
        title: 'Synthetic live roster',
        kind: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        timezone: 'Asia/Seoul',
        durationSeconds: 600,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: null, note: null, planLink: null },
    });
  const summary = () =>
    db.tenant(f.athlete, async (tx) => {
      const r = await tx.query(
        'SELECT count(*)::text AS count,coalesce(sum(revision),0)::text AS revision_sum FROM activity_canonical WHERE athlete_id=$1 AND NOT deleted',
        [f.athlete],
      );
      return z.strictObject({ count: z.string(), revision_sum: z.string() }).parse(r.rows[0]);
    });
  const a = await create(),
    old = await service.prepare(f.athlete, f.intent);
  if (old.status !== 'current_dependencies_captured') throw Error('SEMANTIC_BEFORE_UNAVAILABLE');
  const before = await summary();
  await activities.deleteActivity(f.athlete, a.activityId, { expectedRevision: a.revision });
  const b = await create();
  expect(b.activityId).not.toBe(a.activityId);
  expect(await summary()).toEqual(before);
  expect(before).toEqual({ count: '1', revision_sum: '1' });
  const stale = await service.prepare(f.athlete, f.intent, old.basis);
  expect(stale).toMatchObject({ status: 'blocked', reason: 'semantic_basis_changed' });
  const fresh = await service.prepare(f.athlete, f.intent);
  if (fresh.status !== 'current_dependencies_captured') throw Error('SEMANTIC_AFTER_UNAVAILABLE');
  expect(fresh.basis.activities.find((x) => x.id === a.activityId)).toMatchObject({
    deleted: true,
  });
  expect(fresh.basis.activities.find((x) => x.id === b.activityId)).toMatchObject({
    deleted: false,
  });
});
