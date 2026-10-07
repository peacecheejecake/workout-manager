import { raceManualReviewCandidateV2ResultSchema } from '@workout/server-coaching/race-manual-review-candidate-v2';
import { randomUUID } from 'node:crypto';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { readFile } from 'node:fs/promises';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  createRaceManualReviewCompatibleV4PreparationService,
  prepareRaceManualReviewCompatibleV4In,
} from '../src/race-manual-review-preparation-v2.js';
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
import { validateRaceImpactConsumedManifest } from '../src/race-plan-impact-complete-manifest.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Actual normal107/public producers; assertions are prepared for Root's isolated PG run.
// No stored review, source seal, SQL106 review admission or approval is exercised.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `review_v2_${suffix}`,
  ownerRole = `review_v2_owner_${suffix}`,
  runtimeRole = `review_v2_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
let staged: Database,
  stagedCreated = false;
const stagedName = `review_v2_staged_${suffix}`,
  stagedOwner = `review_v2_stage_owner_${suffix}`,
  stagedRuntime = `review_v2_stage_app_${suffix}`;
function url(role: string, databaseName = name) {
  const u = new URL(adminUrl);
  u.pathname = `/${databaseName}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, stagedOwner, stagedRuntime]) {
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
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  await admin.query(`CREATE DATABASE "${stagedName}" OWNER "${stagedOwner}"`);
  stagedCreated = true;
  await migrate(url(stagedOwner, stagedName), 107);
  const stagedPool = new Pool({ connectionString: url(stagedOwner, stagedName), max: 1 });
  try {
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
    ])
      await stagedPool.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    // Explicit unregistered staging EXECUTE only, identical to the V4 writer fixture.
    await stagedPool.query(
      `GRANT EXECUTE ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text),public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) TO "${stagedRuntime}"`,
    );
  } finally {
    await stagedPool.end();
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
    await grant(url(stagedOwner, stagedName), stagedRuntime);
  staged = createDatabase({ connectionString: url(stagedRuntime, stagedName), max: 4 });
});
afterAll(async () => {
  await db?.close();
  await staged?.close();
  if (stagedCreated) await dropIsolatedDatabase(admin, stagedName);
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

const intent = (id: string, revision = 1) => ({
  expectedEvent: { id, revision },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
const service = () => createRaceManualReviewCompatibleV4PreparationService(db);
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM race_command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox,(SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS nutrition,(SELECT count(*) FROM plan_snapshot WHERE athlete_id=$1)::int AS plans`,
          [athlete],
        )
      ).rows,
  );
}
function readonly(result: Awaited<ReturnType<ReturnType<typeof service>['prepare']>>) {
  expect(result).toMatchObject({
    storage: 'not_persisted',
    sourceCompleteness: 'unverified',
    approvalAllowed: false,
    authority: 'none',
    freshness: 'not_checked',
  });
  expect(result.context.coverage.complete).toBe(false);
  expect(result.context.coverage.missing).toHaveLength(5);
}
it('public empty race is assembled from the exact server scope without writing receipts or versions', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    before = await counts(athlete);
  const result = await service().prepare(athlete, intent(saved.id));
  readonly(result);
  expect(result.status).toBe('prepared_readonly');
  if (result.status !== 'prepared_readonly') throw Error('EXPECTED_PREPARED_READONLY');
  expect(result.candidate.body.binding).toMatchObject({
    event: { id: saved.id, revision: 1 },
    restoreGeneration: result.context.restoreGeneration,
    readSetDigest: result.context.readSetDigest,
    appRevision: 1,
  });
  expect(result.consumedScope.status).toBe('validated_read_scope');
  expect(result.correspondence).toBe('recomputed');
  expect(await counts(athlete)).toEqual(before);
});
it('public current Plan and absolute Nutrition retain actual null/zero and server source bodies', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete);
  const plan = await createPlanningRepository(db).save(athlete, {
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
      purpose: 'Synthetic meal',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'a'.repeat(201) + '한글"\\',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: 'Synthetic explicit meal',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const before = await counts(athlete),
    result = await service().prepare(athlete, intent(saved.id));
  readonly(result);
  expect(result.status).toBe('prepared_readonly');
  if (result.status !== 'prepared_readonly') throw Error('EXPECTED_PREPARED_READONLY');
  expect(result.sourceInput.projectionInput.currentPlan?.id).toBe(plan.id);
  expect(result.context.rosters.nutrition).toEqual([
    { aggregateId: nutrition.planId, versionId: nutrition.versionId },
  ]);
  expect(result.context.currentTraining?.snapshot.draft.sessions[0]).toMatchObject({
    distanceMeters: 0,
    durationSeconds: null,
  });
  expect(await counts(athlete)).toEqual(before);
});
it('linked historical Plan remains the exact body after a normal public head change', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
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
  if (!original) throw Error('FIXTURE_EVENT_MISSING');
  const { id: _id, revision: _revision, ...values } = original;
  await races.updateRaceEvent(athlete, saved.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, planVersionId: first.id },
  });
  const second = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Second public plan' },
  });
  const result = await service().prepare(athlete, intent(saved.id, 2));
  readonly(result);
  expect(result.status).toBe('prepared_readonly');
  expect(result.context.currentTraining?.snapshot.id).toBe(second.id);
  expect(result.context.linkedPlan?.id).toBe(first.id);
  if (result.status !== 'prepared_readonly') throw Error('EXPECTED_PREPARED_READONLY');
  expect(result.sourceInput.projectionInput.sourcePlans.map((p) => p.id)).toContain(first.id);
});
it('withdrawal rejects new preparation; retained Race reads remain allowed and regrant binds the new app revision', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    first = await service().prepare(athlete, intent(saved.id));
  readonly(first);
  await app(athlete, false);
  await expect(service().prepare(athlete, intent(saved.id))).rejects.toMatchObject({
    code: 'APP_CONSENT_REQUIRED',
  });
  expect(await createRaceRepository(db).getRaceEvent(athlete, saved.id)).toMatchObject({
    id: saved.id,
    revision: 1,
  });
  await app(athlete, true);
  const before = await counts(athlete),
    after = await service().prepare(athlete, intent(saved.id));
  readonly(after);
  expect(after.status).toBe('prepared_readonly');
  if (after.status !== 'prepared_readonly' || first.status !== 'prepared_readonly')
    throw Error('EXPECTED_PREPARED_READONLY');
  expect(after.candidate.body.binding.appRevision).toBe(3);
  expect(after.candidate.body.binding.readSetDigest).not.toBe(
    first.candidate.body.binding.readSetDigest,
  );
  expect(await counts(athlete)).toEqual(before);
});
it('foreign event, stale revision and client capture fields reject without new artifacts', async () => {
  const athlete = randomUUID(),
    foreign = randomUUID(),
    saved = await event(athlete);
  await app(foreign, true);
  const before = await counts(athlete);
  await expect(service().prepare(foreign, intent(saved.id))).rejects.toMatchObject({
    code: 'EVENT_UNAVAILABLE',
  });
  await expect(service().prepare(athlete, intent(saved.id, 2))).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  for (const extra of [
    { capture: {} },
    { readSetDigest: 'a'.repeat(64) },
    { changedSessionIds: ['session'] },
    { approvalAllowed: true },
  ])
    await expect(
      service().prepare(athlete, { ...intent(saved.id), ...extra }),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  expect(await counts(athlete)).toEqual(before);
});
it('caller-owned rollback preserves facts and service never falls back to RC without snapshot capability', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    before = await counts(athlete);
  const snapshot = db.snapshotTenant;
  if (!snapshot) throw Error('FIXTURE_SNAPSHOT_PORT_MISSING');
  await expect(
    snapshot(athlete, async (tx) => {
      const result = await prepareRaceManualReviewCompatibleV4In(tx, intent(saved.id));
      readonly(result);
      throw Error('SYNTHETIC_CALLBACK_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLBACK_ROLLBACK');
  expect(await counts(athlete)).toEqual(before);
  const withoutSnapshot: Database = {
    tenant: () => {
      throw Error('RC_MUST_NOT_BE_CALLED');
    },
    exclusiveTenant: () => {
      throw Error('EXCLUSIVE_MUST_NOT_BE_CALLED');
    },
    close: async () => {},
  };
  await expect(
    createRaceManualReviewCompatibleV4PreparationService(withoutSnapshot).prepare(
      athlete,
      intent(saved.id),
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
});

it('explicit108/109/110 public V4 multipin retains old/current exact tuples without storage or approval authority', async () => {
  const athlete = randomUUID();
  const offline = new Pool({ connectionString: url(stagedOwner, stagedName) });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await offline.end();
  }
  await createConsentRepository(staged).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const races = createRaceRepository(staged),
    values = {
      title: 'Synthetic multipin race',
      localDate: '2026-10-06',
      localStartTime: '09:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard' as const, class: '10k' as const },
      priority: null,
      participation: 'registered' as const,
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    };
  const race = await races.createRaceEvent(athlete, { values, idempotencyKey: randomUUID() });
  const meal = (id: string) => ({
    id,
    category: 'before' as const,
    title: 'Food',
    anchor: {
      kind: 'relative' as const,
      entity: 'race' as const,
      entityId: race.id,
      point: 'start' as const,
      offsetMinutes: -30,
    },
    foods: [
      {
        foodVersionId: null,
        description: 'Preserved food',
        quantity: 0,
        unit: 'g' as const,
        sourceBasis: 'manual_total' as const,
      },
    ],
    targets: [],
    instructions: 'Synthetic action',
    evidenceIds: [],
    source: 'user_confirmed' as const,
  });
  const initial = await createNutritionRacePlanWriter(staged).savePlanV2(athlete, {
    schemaVersion: 2,
    command: {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: {
        period: { from: '2026-10-01', toInclusive: '2026-10-31' },
        timezone: 'UTC',
        purpose: 'Synthetic two meals',
        linkedTrainingPlanVersionId: null,
        items: [meal('old'), meal('changed')],
      },
    },
    expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: 1 }],
  });
  const changed = await races.updateRaceEvent(athlete, race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00' },
  });
  const prior = initial;
  const saved = await createNutritionRacePlanV4Writer(staged).savePlanV4(
    athlete,
    saveNutritionPlanV4IntentSchema.parse({
      schemaVersion: 4,
      intent: {
        schemaVersion: 3,
        command: {
          kind: 'update',
          confirmed: true,
          planId: prior.planId,
          expectedHeadVersionId: prior.versionId,
          idempotencyKey: randomUUID(),
          draft: {
            period: prior.period,
            timezone: prior.timezone,
            purpose: prior.purpose,
            linkedTrainingPlanVersionId: null,
            items: prior.items.map(({ planVersionId, ...item }) => {
              void planVersionId;
              return item.id === 'changed'
                ? { ...item, anchor: { ...meal('changed').anchor, offsetMinutes: -60 } }
                : item;
            }),
          },
        },
        expectedRaceHeads: [{ namespace: 'race-event', eventId: race.id, revision: 2 }],
        reconnectItemIds: [],
      },
    }),
  );
  expect('schemaVersion' in saved.plan && saved.plan.schemaVersion).toBe(4);
  if (!('schemaVersion' in saved.plan) || saved.plan.schemaVersion !== 4)
    throw Error('FIXTURE_EXPECTED_V4');
  expect(saved.plan.raceTimingPins.map((p) => p.eventRevision)).toEqual([1, 2]);
  const before = await staged.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT (SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS versions,(SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
          [athlete],
        )
      ).rows,
  );
  const result = await createRaceManualReviewCompatibleV4PreparationService(staged).prepare(
    athlete,
    intent(race.id, changed.revision),
  );
  readonly(result);
  expect(result.status).toBe('prepared_readonly');
  if (result.status !== 'prepared_readonly') throw Error('EXPECTED_PREPARED_READONLY');
  expect(result.consumedScope.status).toBe('validated_read_scope');
  const binding = result.candidate.body.binding;
  expect(result.consumedScope).toEqual(
    validateRaceImpactConsumedManifest(result.context, {
      purpose: binding.purpose,
      athleteId: athlete,
      restoreGeneration: binding.restoreGeneration,
      expectedEvent: binding.event,
      expectedPolicy: binding.policy,
      expectedAppRevision: binding.appRevision,
      expectedReadSetDigest: binding.readSetDigest,
    }),
  );
  expect(
    result.candidate.body.pinTransitions.map((p) => ({
      id: p.itemId,
      revision: p.savedPin?.eventRevision,
      target: p.proposedTarget,
      allocation: p.allocation,
    })),
  ).toEqual([
    {
      id: 'changed',
      revision: 2,
      target: { eventId: race.id, eventRevision: 3 },
      allocation: 'not_allocated',
    },
    {
      id: 'old',
      revision: 1,
      target: { eventId: race.id, eventRevision: 3 },
      allocation: 'not_allocated',
    },
  ]);
  expect(result.candidate.body.projection.nutrition[0]?.record).toEqual(saved.plan);
  const after = await staged.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT (SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS versions,(SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
          [athlete],
        )
      ).rows,
  );
  expect(after).toEqual(before);
});
it('normal public schema-valid multiple Nutrition bodies enforce the final decoded aggregate budget', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    repo = createNutritionRepository(db);
  for (let n = 0; n < 3; n++)
    await repo.savePlan(athlete, {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: {
        period: { from: '2026-10-01', toInclusive: '2026-10-31' },
        timezone: 'UTC',
        purpose: 'Synthetic bounded payload',
        linkedTrainingPlanVersionId: null,
        items: Array.from({ length: 150 }, (_, i) => ({
          id: `meal-${i}`,
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'UTC' },
          foods: [],
          targets: [],
          instructions: 'x'.repeat(2000),
          evidenceIds: [],
          source: 'user_confirmed',
        })),
      },
    });
  const before = await counts(athlete);
  await expect(service().prepare(athlete, intent(saved.id))).rejects.toMatchObject({
    code: 'CONTEXT_LIMIT',
    bound: 'decoded_bytes',
  });
  expect(await counts(athlete)).toEqual(before);
});

it('public referenced Resource deletion retains a transient candidate with the exact original consumed blockers', async () => {
  const athlete = randomUUID(),
    race = await event(athlete),
    resources = createPrivateTextResourceRepository(db),
    catalog = createSupplementaryRepository(db),
    routines = createRoutineRepository(db);
  const offline = new Pool({ connectionString: url(ownerRole) });
  try {
    await offline.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await offline.end();
  }
  const resource = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic source',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic plain text only.',
    idempotencyKey: randomUUID(),
  });
  if (resource.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const exercise = await catalog.saveExercise(athlete, {
    definition: {
      schemaVersion: 2,
      exerciseId: randomUUID(),
      versionId: randomUUID(),
      name: 'Synthetic balance',
      family: 'balance_stability',
      equipment: ['bodyweight'],
      tags: [],
      countDefinitions: [],
      mediaAssetIds: [],
      resourceVersionIds: resource?.status === 'available' ? [resource.version.id] : [],
      reviewState: 'unreviewed',
      description: 'User defined synthetic movement',
      safetyNotes: '',
      supportedMetrics: ['duration'],
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const versionId = randomUUID();
  const saved = await catalog.saveRoutine(athlete, {
    template: {
      schemaVersion: 2,
      routineId: randomUUID(),
      versionId,
      title: 'Synthetic workout template',
      purpose: 'User selected practice',
      requiredEquipment: ['bodyweight'],
      spec: {
        schemaVersion: 2,
        kind: 'supplementary',
        routineVersionId: versionId,
        blocks: [
          {
            id: 'block',
            mode: 'single',
            rounds: 1,
            sets: [
              {
                id: 'set',
                exerciseVersionId: exercise.definition.versionId,
                side: 'unspecified',
                count: null,
                durationSeconds: {
                  min: 30,
                  max: 30,
                  unit: 's',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                externalResistance: { kind: 'no_added_load' },
                restAfterSeconds: 0,
                tempo: null,
                effort: null,
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic source blueprint',
    intent: 'Retained source read',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Named source',
        content: {
          kind: 'workout_template',
          ref: { id: saved.template.routineId, versionId: saved.template.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  const savedBlueprint = await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });

  const training = await createPlanningRepository(db).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: {
        id: savedBlueprint.blueprint.routineId,
        versionId: savedBlueprint.blueprint.versionId,
      },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: training.id,
  };
  const schedulePreview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: schedulePreview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const initial = await service().prepare(athlete, intent(race.id));
  readonly(initial);
  expect(initial.status).toBe('prepared_readonly');
  if (initial.status !== 'prepared_readonly') throw Error('EXPECTED_PREPARED_READONLY');
  expect(initial.sourceInput.projectionInput.routines).toMatchObject([
    {
      record: {
        id: approved.schedule.id,
        versionId: approved.schedule.versionId,
        blueprint: {
          id: savedBlueprint.blueprint.routineId,
          versionId: savedBlueprint.blueprint.versionId,
        },
      },
    },
  ]);
  expect(initial.context.resourceReadFacts?.requestedVersionIds).toContain(resource.version.id);
  expect(initial.context.resourceReadFacts?.facts).toMatchObject([
    { requestedVersionId: resource.version.id, state: 'current', record: resource.version },
  ]);
  expect(initial.candidate.body.projection.routines).toMatchObject([
    { scheduleVersionId: approved.schedule.versionId },
  ]);
  await resources.softDelete(athlete, resource.resource.id, {
    expectedAccessRevision: resource.resource.accessRevision,
    expectedCurrentVersionId: resource.version.id,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(athlete),
    result = await service().prepare(athlete, intent(race.id));
  readonly(result);
  expect(result.status).toBe('prepared_blocked');
  if (result.status !== 'prepared_blocked') throw Error('EXPECTED_PREPARED_BLOCKED');
  expect(result.candidate.status).toBe('assembled_readonly');
  expect(raceManualReviewCandidateV2ResultSchema.parse(result.candidate)).toEqual(result.candidate);
  if (!result.context.resourceReadFacts) throw Error('FIXTURE_RESOURCE_FACTS_MISSING');
  expect(result.context.resourceReadFacts.facts).toMatchObject([
    { requestedVersionId: resource.version.id, state: 'deleted', record: null },
  ]);
  expect(result.consumedScope).toMatchObject({
    status: 'blocked',
    blockers: expect.arrayContaining([expect.objectContaining({ reason: 'source_unavailable' })]),
  });
  const binding = result.candidate.body.binding;
  expect(result.consumedScope).toEqual(
    validateRaceImpactConsumedManifest(result.context, {
      purpose: binding.purpose,
      athleteId: athlete,
      restoreGeneration: binding.restoreGeneration,
      expectedEvent: binding.event,
      expectedPolicy: binding.policy,
      expectedAppRevision: binding.appRevision,
      expectedReadSetDigest: binding.readSetDigest,
    }),
  );
  expect(await counts(athlete)).toEqual(before);
});
