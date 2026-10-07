import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createConsentRepository } from '../src/repositories.js';
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
import { prepareRaceManualReviewFullOwnedBindingV2In } from '../src/race-manual-review-full-owned-binding-consumer-v2.js';
import { prepareRaceManualReviewRetainedPayloadV2 } from '../src/race-manual-review-retained-payload-v2.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';

// Root executes: normal registry107 plus explicit raw115 observer staging. No public writer activation.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `lifecycle_review_v2_${suffix}`,
  owner = `lifecycle_review_owner_${suffix}`,
  runtime = `lifecycle_review_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const r of [owner, runtime]) {
    await admin.query(
      `CREATE ROLE "${r}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(r);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
  created = true;
  await migrate(url(owner), 107);
  const pool = new Pool({ connectionString: url(owner) });
  try {
    await pool.query(
      await readFile(
        new URL(
          '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtime}"`,
    );
  } finally {
    await pool.end();
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
    await grant(url(owner), runtime);
  db = createDatabase({ connectionString: url(runtime), max: 4 });
}, 30000);
afterAll(async () => {
  if (db) await db.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const r of roles.reverse()) await admin.query(`DROP ROLE "${r}"`);
  await admin.end();
});
async function snapshot<T>(athlete: string, callback: (tx: Transaction) => Promise<T>) {
  const port = db.snapshotTenant;
  if (!port) throw Error('FIXTURE_SNAPSHOT_PORT_MISSING');
  return port(athlete, callback);
}
const raceValues = {
  title: 'Synthetic lifecycle race',
  localDate: '2026-10-06',
  localStartTime: '09:00',
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard' as const, class: '10k' as const },
  priority: null,
  participation: 'registered' as const,
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
};
async function fixture() {
  const athlete = randomUUID();
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    values: raceValues,
    idempotencyKey: randomUUID(),
  });
  return { athlete, race };
}
async function retained(tx: Transaction, eventId: string) {
  const prepared = await prepareRaceManualReviewFullOwnedBindingV2In(
    tx,
    {
      expectedEvent: { id: eventId, revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    },
    { bytes: 0n, sources: 0 },
  );
  if (prepared.status !== 'observed_readonly' && prepared.status !== 'observed_blocked')
    throw Error('FIXTURE_BINDING_UNAVAILABLE');
  if (
    prepared.preparation.status !== 'prepared_readonly' &&
    prepared.preparation.status !== 'prepared_blocked'
  )
    throw Error('FIXTURE_PREPARATION_UNAVAILABLE');
  return prepareRaceManualReviewRetainedPayloadV2({
    state: 'present',
    preparation: {
      context: prepared.preparation.context,
      sourceInput: prepared.preparation.sourceInput,
      candidate: prepared.preparation.candidate,
    },
    inventory: prepared.inventory,
    dtoObservations: prepared.owned,
    sqlObservations: prepared.sqlObservation,
    currentAuthority: {
      authority: 'none',
      freshness: 'not_checked',
      permissionAuthority: 'none',
      lifecycleAuthority: 'none',
      admissionAllowed: false,
      approvalAllowed: false,
    },
  });
}
async function counts(tx: Transaction) {
  return (
    await tx.query(
      'SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM race_command_receipt WHERE athlete_id=$1) AS race_receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox',
      [tx.athleteId],
    )
  ).rows;
}
it('actual owned race parent binds in same snapshot without receipts/outbox or authority', async () => {
  const f = await fixture();
  await snapshot(f.athlete, async (tx) => {
    const body = await retained(tx, f.race.id),
      before = await counts(tx);
    const result = await captureRaceManualReviewLifecycleInventoryV2In(tx, body, {
      bytes: 0n,
      sources: 0,
    });
    expect(result).toMatchObject({
      status: 'dependency_correspondence',
      originalEventAuthentication: 'unverified_original_event',
      authority: 'none',
      storage: 'not_persisted',
      approvalAllowed: false,
    });
    expect(result.facts).toMatchObject([
      {
        identity: { kind: 'race-event', sourceId: f.race.id, revision: 1 },
        edges: [{ family: 'race-event', sourceId: f.race.id, versionKey: '1' }],
      },
    ]);
    expect(await counts(tx)).toEqual(before);
  });
});
it('app withdrawal retains the captured body read but does not grant new processing', async () => {
  const f = await fixture(),
    body = await snapshot(f.athlete, (tx) => retained(tx, f.race.id));
  await createConsentRepository(db).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await snapshot(f.athlete, async (tx) => {
    expect(
      await captureRaceManualReviewLifecycleInventoryV2In(tx, body, { bytes: 0n, sources: 0 }),
    ).toMatchObject({
      status: 'dependency_correspondence',
      appWithdrawal: 'retained_read_allowed',
      approvalAllowed: false,
    });
  });
});
it('foreign actor mismatch rejects before a source query', async () => {
  const f = await fixture(),
    body = await snapshot(f.athlete, (tx) => retained(tx, f.race.id));
  await snapshot(randomUUID(), async (tx) => {
    let queries = 0;
    const instrumented: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    await expect(
      captureRaceManualReviewLifecycleInventoryV2In(instrumented, body, { bytes: 0n, sources: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(queries).toBe(0);
  });
});
it('normal race deletion leaves the parent unavailable rather than inventing an event witness', async () => {
  const f = await fixture(),
    body = await snapshot(f.athlete, (tx) => retained(tx, f.race.id));
  await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await snapshot(f.athlete, async (tx) => {
    expect(
      await captureRaceManualReviewLifecycleInventoryV2In(tx, body, { bytes: 0n, sources: 0 }),
    ).toMatchObject({
      status: 'blocked',
      facts: [{ state: 'unavailable', reason: 'owned_parent_unavailable' }],
      originalEventAuthentication: 'unverified_original_event',
    });
  });
});
it('near-cap shared budget rejects before parent metadata transport', async () => {
  const f = await fixture();
  await snapshot(f.athlete, async (tx) => {
    const body = await retained(tx, f.race.id);
    await expect(
      captureRaceManualReviewLifecycleInventoryV2In(tx, body, { bytes: 4194304n, sources: 0 }),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });
});

it('public manual intake original-event target is its first revision UUID, not opaque intake ID', async () => {
  const f = await fixture(),
    nutrition = createNutritionRepository(db),
    routines = createRoutineRepository(db);
  const meal = await nutrition.savePlan(f.athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'UTC',
      purpose: 'Synthetic intake source',
      linkedTrainingPlanVersionId: null,
      items: [],
    },
  });
  const generation = await db.tenant(f.athlete, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
  const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const intake = await nutrition.createIntake(f.athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
    intakeId: 'Intake-한글-"opaque\\',
    confirmed: true,
    occurredAt: '2026-10-06T00:00:00Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Synthetic reported unknown',
        quantity: null,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: unknown('kcal'),
      carbohydrate: unknown('g'),
      protein: unknown('g'),
      fat: unknown('g'),
      fluid: unknown('mL'),
      sodium: unknown('mg'),
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  const blueprint = (
    await routines.saveBlueprint(f.athlete, {
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Synthetic intake source',
        intent: 'Retained source',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'nutrition',
            title: 'Nutrition',
            content: {
              kind: 'nutrition_template',
              ref: { id: meal.planId, versionId: meal.versionId },
            },
            timing: { kind: 'user_scheduled' },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-10-01T00:00:00Z',
      }),
    })
  ).blueprint;
  const run = await routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  await routines.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'nutrition',
    state: 'partial',
    actualRefs: [{ kind: 'intake', id: intake.intakeId, revisionId: intake.revisionId }],
    occurredAt: intake.occurredAt,
    reason: null,
    expectedRevision: 0,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  await snapshot(f.athlete, async (tx) => {
    const body = await retained(tx, f.race.id),
      before = await counts(tx);
    const result = await captureRaceManualReviewLifecycleInventoryV2In(tx, body, {
      bytes: 0n,
      sources: 0,
    });
    const fact = result.facts.find((r) => r.identity.kind === 'intake-revision');
    expect(fact).toMatchObject({
      state: 'bound',
      identity: { sourceId: intake.intakeId, revisionId: intake.revisionId },
    });
    expect(fact?.edges).toContainEqual({
      family: 'intake-origin',
      sourceId: intake.revisionId,
      versionKey: null,
      role: 'origin',
      membershipKey: null,
    });
    expect(
      fact?.edges.some((e) => e.family === 'intake-origin' && e.sourceId === intake.intakeId),
    ).toBe(false);
    expect(await counts(tx)).toEqual(before);
  });
});

it('public workout target parent uses exact frozen membership; equal-count metadata substitution is blocked', async () => {
  const f = await fixture(),
    catalog = createSupplementaryRepository(db),
    routines = createRoutineRepository(db);
  const exercise = await catalog.saveExercise(f.athlete, {
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
      resourceVersionIds: [],
      reviewState: 'unreviewed',
      description: 'Synthetic retained movement',
      safetyNotes: '',
      supportedMetrics: ['duration'],
      createdAt: '2026-10-01T00:00:00Z',
    },
    expectedVersionId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const versionId = randomUUID();
  const template = await catalog.saveRoutine(f.athlete, {
    template: {
      schemaVersion: 2,
      routineId: randomUUID(),
      versionId,
      title: 'Synthetic workout',
      purpose: 'Retained targets',
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
            restBetweenRoundsSeconds: null,
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
          },
        ],
      },
      createdAt: '2026-10-01T00:00:00Z',
    },
    expectedVersionId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const blueprint = (
    await routines.saveBlueprint(f.athlete, {
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Synthetic frozen target',
        intent: 'Retained source',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'workout',
            title: 'Workout',
            content: {
              kind: 'workout_template',
              ref: { id: template.template.routineId, versionId },
            },
            timing: { kind: 'user_scheduled' },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-10-01T00:00:00Z',
      }),
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
    })
  ).blueprint;
  await routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  await snapshot(f.athlete, async (tx) => {
    const body = await retained(tx, f.race.id);
    const normal = await captureRaceManualReviewLifecycleInventoryV2In(tx, body, {
      bytes: 0n,
      sources: 0,
    });
    expect(normal.facts.find((r) => r.identity.kind === 'workout-template-version')).toMatchObject({
      state: 'bound',
      edges: expect.arrayContaining([
        {
          family: 'supplementary-exercise',
          sourceId: exercise.definition.exerciseId,
          versionKey: exercise.definition.versionId,
          role: 'target',
          membershipKey: [versionId, 'set'],
        },
      ]),
    });
    const instrumented: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        const actual = await tx.query(sql, values);
        if (
          sql.includes('SELECT * FROM parents') &&
          sql.includes('supplementary_routine_target_ref')
        )
          return {
            ...actual,
            rows: actual.rows.map((r) =>
              r['role'] === 'target'
                ? { ...r, membershipKey: [versionId, 'different-target-same-count'] }
                : r,
            ),
          };
        return actual;
      },
    };
    const result = await captureRaceManualReviewLifecycleInventoryV2In(instrumented, body, {
      bytes: 0n,
      sources: 0,
    });
    expect(result.facts.find((r) => r.identity.kind === 'workout-template-version')).toMatchObject({
      state: 'unavailable',
      reason: 'parent_membership_mismatch',
    });
    expect(result.status).toBe('blocked'); // Actual query response tamper boundary, not mutated source-row truth.
  });
});
