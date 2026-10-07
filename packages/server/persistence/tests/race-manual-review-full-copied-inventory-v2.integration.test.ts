import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { saveFoodDefinitionVersionRequestSchema } from '@workout/contracts/nutrition-core';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
import { enumerateRaceManualReviewFullCopiedSourcesV2 } from '../src/race-manual-review-full-copied-inventory-v2.js';
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
// Public normal107 producers, plain owner/runtime grants. Root alone executes PG.
// Pure mapping neither authenticates sources nor closes storage/lifecycle/approval.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `fullcopy_${suffix}`,
  ownerRole = `fullcopy_owner_${suffix}`,
  runtimeRole = `fullcopy_app_${suffix}`;
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

function dereference(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (typeof value !== 'object' || value === null) throw Error('COPIED_LOCATION_UNAVAILABLE');
    value = z
      .record(z.string(), z.unknown())
      .parse(Array.isArray(value) ? Object.fromEntries(value.entries()) : value)[key];
  }
  if (value === undefined) throw Error('COPIED_LOCATION_UNAVAILABLE');
  return value;
}
async function prepared(athlete: string, id: string, revision = 1) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, async (tx) => {
    const result = await prepareRaceManualReviewCompatibleV4In(tx, {
      expectedEvent: { id, revision },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    });
    if (result.status !== 'prepared_readonly') throw Error('PREPARATION_BLOCKED');
    const envelope = {
      context: result.context,
      sourceInput: result.sourceInput,
      candidate: result.candidate,
    };
    const inventory = enumerateRaceManualReviewFullCopiedSourcesV2(envelope);
    expect(inventory.blockers).toEqual([]);
    expect(inventory.inventoryState).toBe('mapped');
    expect(inventory).toMatchObject({
      allCopiedBodiesIndexed: true,
      sourceAuthentication: 'unverified',
      sqlRowDigest: 'not_captured',
      lifecycleAuthority: 'none',
      permissionAuthority: 'none',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      approvalAllowed: false,
      admissionAllowed: false,
      candidateCoverage: { complete: false },
    });
    expect(inventory.candidateCoverage?.missing).toHaveLength(5);
    for (const ref of inventory.refs)
      for (const location of ref.copiedLocations)
        expect(impactDependencyDigest(dereference(envelope, location))).toBe(ref.dtoDigest);
    return { result, inventory };
  });
}
it('public food/current nutrition and historical linked training bodies keep exact copied locations and canonical digests', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    nutrition = createNutritionRepository(db),
    planning = createPlanningRepository(db),
    races = createRaceRepository(db);
  const first = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const original = await races.getRaceEvent(athlete, saved.id);
  if (!original) throw Error('EVENT_MISSING');
  const { id: _id, revision: _revision, ...values } = original;
  await races.updateRaceEvent(athlete, saved.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, planVersionId: first.id },
  });
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
      foodId: 'Food-한글-A',
      name: 'Original food',
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
  const food = await nutrition.saveFood(athlete, request);
  const plan = await nutrition.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic portions',
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
  const before = await prepared(athlete, saved.id, 2);
  expect(
    before.inventory.refs.find((r) => r.identity.kind === 'food-definition-version'),
  ).toMatchObject({
    identity: { sourceId: food.foodId, versionId: food.versionId },
    dtoDigest: impactDependencyDigest(food),
  });
  const current = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'New training head' },
  });
  await nutrition.saveFood(athlete, {
    ...request,
    idempotencyKey: randomUUID(),
    expectedVersionId: food.versionId,
    definition: { ...request.definition, name: 'New food head' },
  });
  const after = await prepared(athlete, saved.id, 2);
  expect(after.result.context.linkedPlan).toEqual(first);
  expect(after.result.context.currentTraining?.snapshot).toEqual(current);
  expect(
    after.inventory.refs
      .filter((r) => r.identity.kind === 'plan-snapshot')
      .map((r) => r.identity.sourceId),
  ).toEqual(expect.arrayContaining([first.id, current.id]));
  expect(
    after.inventory.refs.find((r) => r.identity.kind === 'food-definition-version'),
  ).toMatchObject({
    identity: { sourceId: food.foodId, versionId: food.versionId },
    dtoDigest: impactDependencyDigest(food),
  });
  expect(after.result.context.nutrition[0]?.record).toEqual(plan);
  expect(
    after.result.context.sourcePermissionManifest.nestedNutritionSources[0]?.foods[0]?.state,
  ).toBe('historical');
});
it('public recovery strategy and exact referenced method are additional full copied source channels', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    recovery = createRecoveryRepository(db);
  const method = await recovery.createMethod(athlete, {
    title: 'Rest',
    category: 'rest',
    intendedUse: 'Personal record',
    applicability: [],
    cautions: [],
    sourceDescription: 'User',
    evidenceLimitations: 'Unreviewed',
    idempotencyKey: randomUUID(),
  });
  const strategy = await recovery.createStrategy(athlete, {
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Rest review',
      goal: 'Synthetic',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: randomUUID(),
          title: 'Optional rest',
          kind: 'nonexercise_action',
          methodVersionId: method.versionId,
          explanation: 'Self report',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'user_report_changed',
          plannedAt: null,
          description: 'Review',
          policyVersion: null,
        },
      ],
    },
  });
  const captured = await prepared(athlete, saved.id);
  expect(
    captured.inventory.refs.find((r) => r.identity.kind === 'recovery-strategy-version'),
  ).toMatchObject({
    identity: { sourceId: strategy.strategyId, versionId: strategy.versionId },
    dtoDigest: impactDependencyDigest(strategy),
  });
  expect(
    captured.inventory.refs.find((r) => r.identity.kind === 'recovery-method-version'),
  ).toMatchObject({
    identity: { sourceId: method.methodId, versionId: method.versionId },
    dtoDigest: impactDependencyDigest(method),
  });
});
it('absent channels remain absent and foreign/deleted event preparation cannot resurrect bodies', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    foreign = randomUUID();
  await app(foreign, true);
  const empty = await prepared(athlete, saved.id);
  expect(
    empty.inventory.refs.some(
      (r) =>
        r.identity.kind === 'food-definition-version' ||
        r.identity.kind === 'recovery-strategy-version',
    ),
  ).toBe(false);
  await expect(prepared(foreign, saved.id)).rejects.toThrow();
  await createRaceRepository(db).deleteRaceEvent(athlete, saved.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(prepared(athlete, saved.id)).rejects.toThrow();
});
it('public integer check-in revision does not bypass the unsupported public routine template producer', async () => {
  const athlete = randomUUID();
  await event(athlete);
  const checkin = await createCheckInRepository(db).createCheckIn(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      observedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: null,
    },
  });
  expect(checkin.revision).toBe(1);
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic',
    intent: '',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Check-in',
        content: { kind: 'checkin_template', ref: { id: randomUUID(), versionId: randomUUID() } },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-06T00:00:00Z',
  });
  await expect(
    createRoutineRepository(db).saveBlueprint(athlete, {
      blueprint,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: 'CONTENT_REFERENCE_UNAVAILABLE' });
  // No owner-insert run/template bypass. Integer revision mapper positive remains a separate legacy-storage fixture.
});
