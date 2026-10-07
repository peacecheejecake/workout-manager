import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { saveFoodDefinitionVersionRequestSchema } from '@workout/contracts/nutrition-core';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import {
  createRaceManualReviewCompatibleV4PreparationService,
  prepareRaceManualReviewCompatibleV4In,
} from '../src/race-manual-review-preparation-v2.js';
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
  name = `fullown_${suffix}`,
  ownerRole = `fullown_owner_${suffix}`,
  runtimeRole = `fullown_app_${suffix}`;
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

import { captureRaceManualReviewFullOwnedSourceInventoryV2In } from '../src/race-manual-review-full-owned-source-inventory-v2.js';
import { reserveSourceBudget, type SourceBudget } from '../src/race-plan-impact-nested-sources.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';

async function snapshot<T>(athlete: string, operation: (tx: Transaction) => Promise<T>) {
  const port = db.snapshotTenant;
  if (!port) throw Error('SNAPSHOT_PORT_MISSING');
  return port(athlete, operation);
}
async function prepareIn(tx: Transaction, id: string, revision: number, budget: SourceBudget) {
  const result = await prepareRaceManualReviewCompatibleV4In(
    tx,
    raceProjectionIntentSchema.parse({
      expectedEvent: { id, revision },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    }),
    budget,
  );
  if (result.status !== 'prepared_readonly')
    throw Error('PUBLIC_PREPARATION_BLOCKED:' + result.status);
  const preparation = {
    context: result.context,
    sourceInput: result.sourceInput,
    candidate: result.candidate,
  };
  const inventory = enumerateRaceManualReviewFullCopiedSourcesV2(preparation);
  expect(inventory.inventoryState).toBe('mapped');
  expect(inventory.blockers).toEqual([]);
  return { preparation, inventory };
}
async function prepare(athlete: string, id: string, revision = 1) {
  return snapshot(athlete, (tx) => prepareIn(tx, id, revision, { bytes: 0n, sources: 0 }));
}
async function countWrites(tx: Transaction) {
  return z
    .strictObject({
      receipts: z.string(),
      outbox: z.string(),
      outboxDigest: z.string().regex(/^[a-f0-9]{64}$/),
      nutrition: z.string(),
      training: z.string(),
    })
    .parse(
      (
        await tx.query(
          `SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox,(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]'::jsonb)::text,'UTF8')),'hex') FROM (SELECT * FROM outbox WHERE athlete_id=$1 ORDER BY id LIMIT 101) q) AS "outboxDigest",(SELECT count(*)::text FROM nutrition_plan_history WHERE athlete_id=$1) AS nutrition,(SELECT count(*)::text FROM plan_history WHERE athlete_id=$1) AS training`,
          [tx.athleteId],
        )
      ).rows[0],
    );
}
async function seed(athlete = randomUUID()) {
  const saved = await event(athlete),
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
it('public normal107 producers reconcile actual owned DTOs in the same RR snapshot and shared budget without writes', async () => {
  const f = await seed();
  const r = await recovery(f.athlete);
  await snapshot(f.athlete, async (tx) => {
    expect((await tx.query('SHOW transaction_isolation')).rows[0]?.['transaction_isolation']).toBe(
      'repeatable read',
    );
    const before = await countWrites(tx),
      budget = { bytes: 0n, sources: 0 };
    expect(Number(before.outbox)).toBeLessThanOrEqual(100);
    const p = await prepareIn(tx, f.saved.id, 2, budget),
      capturedBytes = budget.bytes,
      capturedVisits = budget.sources;
    const queries: string[] = [];
    const traced: Transaction = {
      athleteId: tx.athleteId,
      query: (sql, values) => {
        queries.push(sql);
        return tx.query(sql, values);
      },
    };
    const result = await captureRaceManualReviewFullOwnedSourceInventoryV2In(
      traced,
      p.inventory,
      p.preparation,
      budget,
    );
    expect(result.status).toBe('observed_correspondence');
    expect(result.facts.every((row) => row.state === 'matched')).toBe(true);
    expect(
      result.facts.find((row) => row.identity.kind === 'food-definition-version'),
    ).toMatchObject({ dtoDigest: impactDependencyDigest(f.food) });
    expect(
      result.facts.find((row) => row.identity.kind === 'nutrition-plan-version'),
    ).toMatchObject({ dtoDigest: impactDependencyDigest(f.plan) });
    expect(
      result.facts.find((row) => row.identity.kind === 'recovery-method-version'),
    ).toMatchObject({ dtoDigest: impactDependencyDigest(r.method) });
    expect(
      result.facts.find((row) => row.identity.kind === 'recovery-strategy-version'),
    ).toMatchObject({ dtoDigest: impactDependencyDigest(r.strategy) });
    expect(result).toMatchObject({
      sqlRowDigest: 'not_captured',
      authority: 'none',
      freshness: 'not_checked',
      sourceAuthentication: 'unverified',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      coverage: { complete: false },
    });
    expect(result.coverage.missing).toHaveLength(5);
    expect(budget.bytes).toBeGreaterThan(capturedBytes);
    expect(budget.sources).toBeGreaterThan(capturedVisits);
    expect(queries.every((sql) => !/^\s*(INSERT|UPDATE|DELETE|CALL)\b/i.test(sql))).toBe(true);
    expect(await countWrites(tx)).toEqual(before);
  });
});
it('advanced public heads preserve exact historical food/training bodies and separately reconcile new current training', async () => {
  const f = await seed();
  const current = await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.first.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), title: 'New own head' },
  });
  await f.nutrition.saveFood(f.athlete, {
    ...f.request,
    idempotencyKey: randomUUID(),
    expectedVersionId: f.food.versionId,
    definition: { ...f.request.definition, name: 'New own food' },
  });
  await snapshot(f.athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 },
      p = await prepareIn(tx, f.saved.id, 2, budget);
    expect(p.preparation.context.linkedPlan).toEqual(f.first);
    expect(p.preparation.context.currentTraining?.snapshot).toEqual(current);
    expect(
      p.preparation.context.sourcePermissionManifest.nestedNutritionSources[0]?.foods[0]?.state,
    ).toBe('historical');
    const result = await captureRaceManualReviewFullOwnedSourceInventoryV2In(
      tx,
      p.inventory,
      p.preparation,
      budget,
    );
    expect(result.status).toBe('observed_correspondence');
    for (const body of [f.first, current])
      expect(
        result.facts.find(
          (row) => row.identity.kind === 'plan-snapshot' && row.identity.sourceId === body.id,
        ),
      ).toMatchObject({ state: 'matched', dtoDigest: impactDependencyDigest(body) });
    expect(
      result.facts.find((row) => row.identity.kind === 'food-definition-version'),
    ).toMatchObject({ state: 'matched', dtoDigest: impactDependencyDigest(f.food) });
  });
});
it('reusing an original preparation after an actual public race revision changes rejects its current source tuple', async () => {
  const f = await seed(),
    p = await prepare(f.athlete, f.saved.id, 2),
    r = await f.races.getRaceEvent(f.athlete, f.saved.id);
  if (!r) throw Error('EVENT_MISSING');
  const { id: _id, revision: _revision, ...values } = r;
  await f.races.updateRaceEvent(f.athlete, f.saved.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    values: { ...values, title: 'Changed actual source' },
  });
  const result = await snapshot(f.athlete, (tx) =>
    captureRaceManualReviewFullOwnedSourceInventoryV2In(tx, p.inventory, p.preparation, {
      bytes: 0n,
      sources: 0,
    }),
  );
  expect(result.status).toBe('blocked');
  expect(result.facts.find((row) => row.identity.kind === 'race-event')).toMatchObject({
    state: 'unavailable',
    reason: 'source_tuple_mismatch',
    dtoDigest: null,
  });
});
it('original copied race body is unavailable after public deletion without resurrecting its cleared payload', async () => {
  const f = await seed(),
    p = await prepare(f.athlete, f.saved.id, 2);
  await f.races.deleteRaceEvent(f.athlete, f.saved.id, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const result = await snapshot(f.athlete, (tx) =>
    captureRaceManualReviewFullOwnedSourceInventoryV2In(tx, p.inventory, p.preparation, {
      bytes: 0n,
      sources: 0,
    }),
  );
  expect(result.status).toBe('blocked');
  expect(result.facts.find((row) => row.identity.kind === 'race-event')).toMatchObject({
    state: 'unavailable',
    reason: 'source_deleted',
    dtoDigest: null,
  });
  expect(JSON.stringify(result)).not.toContain('Synthetic scope race');
});
it('foreign actual tenant cannot reuse an owned preparation and invokes no source SQL', async () => {
  const f = await seed(),
    p = await prepare(f.athlete, f.saved.id, 2),
    other = randomUUID();
  await app(other, true);
  const queries: string[] = [];
  await expect(
    snapshot(other, (tx) => {
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureRaceManualReviewFullOwnedSourceInventoryV2In(
        traced,
        p.inventory,
        p.preparation,
        { bytes: 0n, sources: 0 },
      );
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(queries).toEqual([]);
});
it('remaining request budget rejects exact food at scalar before any owned body transport', async () => {
  const f = await seed();
  const queries: string[] = [];
  await expect(
    snapshot(f.athlete, async (tx) => {
      const budget = { bytes: 0n, sources: 0 },
        p = await prepareIn(tx, f.saved.id, 2, budget);
      // Models reservations by other source response consumers in the same request;
      // no source body, query parameters or actual stored rows are tampered with.
      reserveSourceBudget(budget, 4194303n - budget.bytes);
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureRaceManualReviewFullOwnedSourceInventoryV2In(
        traced,
        p.inventory,
        p.preparation,
        budget,
      );
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('octet_length');
  expect(
    queries.some(
      (sql) => sql.includes('SELECT v.food_id') || sql.includes('manual_review_owned_v2 body'),
    ),
  ).toBe(false);
});
it('configured preparation service requires actual snapshot capability and never falls back to RC', async () => {
  const athlete = randomUUID(),
    saved = await event(athlete),
    { snapshotTenant: _snapshot, ...withoutSnapshot } = db;
  let rcCalls = 0;
  const rc: Database = {
    ...withoutSnapshot,
    tenant: async () => {
      rcCalls++;
      throw Error('RC_MUST_NOT_RUN');
    },
  };
  await expect(
    createRaceManualReviewCompatibleV4PreparationService(rc).prepare(athlete, {
      expectedEvent: { id: saved.id, revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(rcCalls).toBe(0);
  const actual = await createRaceManualReviewCompatibleV4PreparationService(db).prepare(athlete, {
    expectedEvent: { id: saved.id, revision: 1 },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' },
  });
  expect(actual.status).toBe('prepared_readonly');
});
