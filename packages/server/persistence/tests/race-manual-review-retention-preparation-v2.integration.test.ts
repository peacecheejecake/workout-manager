import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { saveFoodDefinitionVersionRequestSchema } from '@workout/contracts/nutrition-core';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import {
  prepareRaceManualReviewRetentionV2In,
  createRaceManualReviewRetentionV2Service,
} from '../src/race-manual-review-retention-preparation-v2.js';
import {
  validateRaceManualReviewRetainedPayloadV2,
  prepareRaceManualReviewRetainedPayloadV2,
} from '../src/race-manual-review-retained-payload-v2.js';
import {
  migrate,
  grantCorePlanning,
  grantSessionCompletions,
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
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `retention_v2_${suffix}`,
  ownerRole = `retention_owner_${suffix}`,
  runtimeRole = `retention_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
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
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      await readFile(
        new URL(
          '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSessionCompletions,
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
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
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

async function grantApp(database: Database, athlete: string) {
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}

async function snapshot<T>(athlete: string, fn: (tx: Transaction) => Promise<T>) {
  const port = db.snapshotTenant;
  if (!port) throw Error('FIXTURE_SNAPSHOT_MISSING');
  return port(athlete, fn);
}
const intent = (eventId: string) => ({
  expectedEvent: { id: eventId, revision: 2 },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipt,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox,(SELECT count(*)::text FROM race_command_receipt WHERE athlete_id=$1) AS race_receipt`,
          [athlete],
        )
      ).rows,
  );
}
async function createAdditionalEvent(athlete: string) {
  await grantApp(db, athlete);
  return createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Additional source race',
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
async function additionalSources(athlete = randomUUID()) {
  const saved = await createAdditionalEvent(athlete),
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
  return { athlete, saved, nutrition, planning, races, first, food, plan, request };
}
async function recovery(athlete: string) {
  const recovery = createRecoveryRepository(db);
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
  return { method, strategy };
}

it('public historical food/training/recovery and unplanned checklist/timer produce same-snapshot retained input without writes', async () => {
  const f = await additionalSources();
  await recovery(f.athlete);
  const routines = createRoutineRepository(db);
  const blueprint = (
    await routines.saveBlueprint(f.athlete, {
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Synthetic unplanned',
        intent: 'Read source only',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'check',
            title: 'Report',
            content: { kind: 'checklist', prompt: 'Explicit synthetic report' },
            timing: { kind: 'user_scheduled' },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
    })
  ).blueprint;
  let run = await routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  run = await routines.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'check',
    state: 'performed',
    actualRefs: [],
    occurredAt: '2026-10-06T00:00:00Z',
    reason: null,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const timer = await routines.commandTimer(f.athlete, {
    runId: run.run.id,
    stepId: 'check',
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  await f.nutrition.saveFood(f.athlete, {
    ...f.request,
    expectedVersionId: f.food.versionId,
    idempotencyKey: randomUUID(),
    definition: { ...f.request.definition, name: 'Current correction' },
  });
  await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.first.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'Current training correction' },
  });
  const before = await counts(f.athlete);
  await snapshot(f.athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 };
    const result = await prepareRaceManualReviewRetentionV2In(tx, intent(f.saved.id), budget);
    expect(result.status).toBe('prepared_readonly');
    if (!('retained' in result) || result.retained.state !== 'present')
      throw Error('FIXTURE_RETAINED_MISSING');
    const payload = result.retained.payload;
    expect(validateRaceManualReviewRetainedPayloadV2(result.retained).success).toBe(true);
    expect(payload.preparation.sourceInput.projectionInput.retainedUnplannedRuns).toEqual([
      { blueprint, run: run.run },
    ]);
    expect(
      payload.inventory.refs.some(
        (ref) =>
          ref.identity.kind === 'routine-schedule-version' ||
          ref.identity.kind === 'routine-occurrence',
      ),
    ).toBe(false);
    for (const kind of [
      'race-event',
      'plan-snapshot',
      'nutrition-plan-version',
      'food-definition-version',
      'recovery-strategy-version',
      'recovery-method-version',
      'routine-run',
      'routine-blueprint-version',
      'checklist-confirmation',
      'routine-timer',
    ])
      expect(payload.inventory.refs.some((ref) => ref.identity.kind === kind)).toBe(true);
    expect(
      payload.inventory.refs.find((ref) => ref.identity.kind === 'routine-timer')?.identity,
    ).toMatchObject({ sourceId: run.run.id, revision: timer.revision });
    expect(payload.preparation.context.linkedPlan?.id).toBe(f.first.id);
    expect(
      payload.preparation.context.sourcePermissionManifest.nestedNutritionSources[0]?.foods[0],
    ).toMatchObject({
      state: 'historical',
      content: { foodId: f.food.foodId, versionId: f.food.versionId, record: f.food },
    });
    expect(payload.dtoObservations.facts.every((row) => row.state === 'matched')).toBe(true);
    expect(result).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      aggregatePhysicalTransfer: 'not_verified',
      budgetCoverage: 'request_source_response_reservations',
    });
    expect(result.consumedScope).toEqual(
      expect.objectContaining({ status: 'validated_read_scope' }),
    );
    expect(payload.preparation.context.coverage.missing).toHaveLength(5);
    expect(budget.bytes).toBeGreaterThan(0n);
    expect(budget.sources).toBeGreaterThan(0);
    const audit = result.retained.minimalAudit;
    expect(
      prepareRaceManualReviewRetainedPayloadV2({
        state: 'purged',
        originalPayloadDigest: result.retained.payloadDigest,
        minimalAudit: audit,
        sourceWitness: 'not_authenticated',
        suppressionTail: 'not_authenticated',
        currentAuthority: payload.currentAuthority,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'external_source_witness_required' });
  });
  expect(await counts(f.athlete)).toEqual(before);
});
it('foreign or deleted race cannot produce retained input', async () => {
  const alice = await additionalSources(),
    bob = await additionalSources();
  await expect(
    snapshot(bob.athlete, (tx) =>
      prepareRaceManualReviewRetentionV2In(tx, intent(alice.saved.id), { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await alice.races.deleteRaceEvent(alice.athlete, alice.saved.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(alice.athlete);
  await expect(
    snapshot(alice.athlete, (tx) =>
      prepareRaceManualReviewRetentionV2In(tx, intent(alice.saved.id), { bytes: 0n, sources: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  expect(await counts(alice.athlete)).toEqual(before);
});
it('public app withdrawal rejects new preparation instead of authenticating old JSON', async () => {
  const f = await additionalSources();
  const service = createRaceManualReviewRetentionV2Service(db);
  await createConsentRepository(db).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const before = await counts(f.athlete);
  await expect(service.prepare(f.athlete, intent(f.saved.id))).rejects.toMatchObject({
    code: 'APP_CONSENT_REQUIRED',
  });
  expect(await counts(f.athlete)).toEqual(before);
});
it('shared exhausted/invalid budgets refuse before source SQL and snapshot absence has no RC fallback', async () => {
  const f = await additionalSources();
  const withoutSnapshot: Database = {
    tenant: db.tenant,
    exclusiveTenant: db.exclusiveTenant,
    close: async () => {},
  };
  await expect(
    createRaceManualReviewRetentionV2Service(withoutSnapshot).prepare(
      f.athlete,
      intent(f.saved.id),
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  await snapshot(f.athlete, async (tx) => {
    let queries = 0;
    const wrapped: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    const budget = { bytes: 4194304n, sources: 0 };
    await expect(
      prepareRaceManualReviewRetentionV2In(wrapped, intent(f.saved.id), budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
    expect(queries).toBe(0);
    await expect(
      prepareRaceManualReviewRetentionV2In(wrapped, intent(f.saved.id), { bytes: -1n, sources: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(queries).toBe(0);
  });
});
it('callback rollback closes its snapshot and leaves receipt/outbox unchanged', async () => {
  const f = await additionalSources(),
    before = await counts(f.athlete);
  let closed: Transaction | undefined;
  await expect(
    snapshot(f.athlete, async (tx) => {
      closed = tx;
      await prepareRaceManualReviewRetentionV2In(tx, intent(f.saved.id), { bytes: 0n, sources: 0 });
      throw Error('SYNTHETIC_CALLBACK_FAILURE');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLBACK_FAILURE');
  if (!closed) throw Error('FIXTURE_TX_MISSING');
  await expect(closed.query('SELECT 1')).rejects.toThrow();
  expect(await counts(f.athlete)).toEqual(before);
});
