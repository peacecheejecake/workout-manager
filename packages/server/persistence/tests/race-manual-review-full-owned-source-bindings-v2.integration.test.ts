import type { ActivityImport } from '@workout/contracts/activity';
import { courseContentDigest } from '@workout/server-courses/digest';
import { createCourseRepository, type PreparedCourseContent } from '../src/courses.js';
import { createActivityTrackRepository } from '../src/activity-tracks.js';
import { createActivityRepository } from '../src/activities.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
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
  grantActivityTracks,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root executes: normal registered107 plus explicit unregistered115. Separate V4 staging.
// DB-recorded metadata only, no provider requests, object bytes or external deletion.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `full_binding_${suffix}`,
  ownerRole = `full_binding_owner_${suffix}`,
  runtimeRole = `full_binding_app_${suffix}`;
const stagedName = `full_binding_stage_${suffix}`,
  stagedOwner = `full_binding_stage_owner_${suffix}`,
  stagedRuntime = `full_binding_stage_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const createdRoles: string[] = [];
const createdDatabases: string[] = [];
let db: Database, staged: Database;
function url(role: string, databaseName = name) {
  const u = new URL(adminUrl);
  u.pathname = `/${databaseName}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
const grants = [
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
  grantActivityTracks,
];
beforeAll(async () => {
  for (const [databaseName, owner, runtime, stage] of [
    [name, ownerRole, runtimeRole, false],
    [stagedName, stagedOwner, stagedRuntime, true],
  ] as const) {
    for (const role of [owner, runtime]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      createdRoles.push(role);
    }
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${owner}"`);
    createdDatabases.push(databaseName);
    await migrate(url(owner, databaseName), 107);
    const installer = new Pool({ connectionString: url(owner, databaseName) });
    try {
      if (stage)
        for (const file of [
          '108_nutrition_race_disconnection.sql',
          '109_race_result_proof_lifecycle.sql',
          '110_nutrition_disconnection_lineage.sql',
          '113_race_media_cleanup_source.sql',
        ])
          await installer.query(
            await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
          );
      await installer.query(
        await readFile(
          new URL(
            '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await installer.query(
        `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtime}"`,
      );
      if (stage)
        await installer.query(
          `GRANT EXECUTE ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text),public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb),public.read_race_media_cleanup(uuid,integer) TO "${runtime}"`,
        );
      // Exact configured activities producer grants, as existing course-source fixtures.
      // Public helpers currently expose activities SELECT but no equivalent DML helper.
      await installer.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtime}"`,
      );
      expect(
        (await installer.query('SELECT max(version)::int AS version FROM schema_migrations'))
          .rows[0]?.['version'],
      ).toBe(107);
    } finally {
      await installer.end();
    }
    for (const grant of grants) await grant(url(owner, databaseName), runtime);
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  staged = createDatabase({ connectionString: url(stagedRuntime, stagedName), max: 4 });
});
afterAll(async () => {
  await db?.close();
  await staged?.close();
  for (const n of createdDatabases.reverse()) await dropIsolatedDatabase(admin, n);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function identity(database: Database, athlete: string) {
  const owner = new Pool({
    connectionString: url(
      database === staged ? stagedOwner : ownerRole,
      database === staged ? stagedName : name,
    ),
  });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, randomUUID()],
    );
  } finally {
    await owner.end();
  }
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

async function grantApp(database: Database, athlete: string) {
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}
const raceValues = {
  title: 'Synthetic owned source race',
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
async function coherentSources(database: Database, sessionId = 'session') {
  const athlete = randomUUID();
  await identity(database, athlete);
  await grantApp(database, athlete);
  const planning = createPlanningRepository(database),
    routines = createRoutineRepository(database),
    completions = createSessionCompletionRepository(database);
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(),
      sessions: draft().sessions.map((session) => ({ ...session, id: sessionId })),
    },
  });
  const race = await createRaceRepository(database).createRaceEvent(athlete, {
    values: { ...raceValues, planVersionId: plan.id },
    idempotencyKey: randomUUID(),
  });
  const nutrition = await createNutritionRepository(database).savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic retained source meal',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
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
  const blueprint = (
    await routines.saveBlueprint(athlete, {
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: plan.id,
        versionId: randomUUID(),
        title: 'Synthetic immutable checklist',
        intent: 'Read source',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'step',
            title: 'Check',
            content: { kind: 'checklist', prompt: 'Synthetic checklist' },
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
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: plan.id,
  };
  const preview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const occurrence = approved.occurrences[0];
  if (!occurrence) throw Error('FIXTURE_OCCURRENCE_ABSENT');
  const run = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const completion = await completions.write(athlete, sessionId, {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: plan.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  return {
    athlete,
    plan,
    race,
    nutrition,
    blueprint,
    approved,
    occurrence,
    run,
    completion,
    routines,
    completions,
    planning,
  };
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relationSchema = z.strictObject({
  role: z.string().min(1),
  relation: z.string().min(1),
  key: z.array(z.union([z.string(), z.number(), z.null()])),
  hashMethod: z.literal('postgres-owned-relation-row-jsonb-utc-v2'),
  sourceRowDigest: hash,
});
const identitySchema = z.record(z.string(), z.union([z.string(), z.number()]));
const rowSchema = z.strictObject({
  ordinal: z.number().int().min(1),
  identity: identitySchema,
  state: z.enum(['observed', 'unavailable']),
  reason: z
    .enum([
      'source_unavailable',
      'historical_observation_unavailable',
      'cleanup_observation_unavailable',
    ])
    .nullable(),
  relations: z.array(relationSchema),
  relationGroupHashMethod: z.literal('postgres-owned-relation-group-jsonb-v2'),
  relationGroupDigest: hash.nullable(),
  cleanupHashMethod: z.literal('postgres-narrow-cleanup-observation-jsonb-v1'),
  cleanupObservationDigest: hash.nullable(),
});
const observationSchema = z.strictObject({
  bindingVersion: z.literal(2),
  scope: z.literal('prepared_full_context_relation_groups_only'),
  hashMethod: z.literal('postgres-owned-relation-row-jsonb-utc-v2'),
  sqlRefsDigest: hash,
  transactionId: z.string().regex(/^[0-9]+$/),
  callerRole: z.string().min(1),
  athleteId: z.string().min(1),
  rows: z.array(rowSchema),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  sourceCompleteness: z.literal('unverified'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
type Ref = z.infer<typeof identitySchema>;
async function snapshot<T>(
  database: Database,
  athlete: string,
  callback: (tx: Transaction) => Promise<T>,
) {
  if (!database.snapshotTenant) throw Error('SNAPSHOT_CAPABILITY_REQUIRED');
  return database.snapshotTenant(athlete, callback);
}
async function observe(tx: Transaction, refs: readonly Ref[]) {
  const result = await tx.query(
    'SELECT public.observe_manual_review_full_owned_source_bindings_v2($1::jsonb) AS observed',
    [JSON.stringify(refs)],
  );
  return observationSchema.parse(result.rows[0]?.['observed']);
}
const eventRef = (race: { id: string; revision: number }): Ref => ({
  kind: 'race-event',
  sourceId: race.id,
  revision: race.revision,
});
function coreRefs(f: Awaited<ReturnType<typeof coherentSources>>): Ref[] {
  return [
    eventRef(f.race),
    { kind: 'plan-snapshot', sourceId: f.plan.id, version: f.plan.version },
    {
      kind: 'nutrition-plan-version',
      sourceId: f.nutrition.planId,
      versionId: f.nutrition.versionId,
    },
    {
      kind: 'routine-blueprint-version',
      sourceId: f.blueprint.routineId,
      versionId: f.blueprint.versionId,
    },
    {
      kind: 'routine-schedule-version',
      sourceId: f.approved.schedule.id,
      versionId: f.approved.schedule.versionId,
    },
    { kind: 'routine-occurrence', sourceId: f.occurrence.id },
    { kind: 'routine-run', sourceId: f.run.run.id, revision: 0 },
    {
      kind: 'session-completion',
      sourceId: 'session',
      planVersionId: f.plan.id,
      revision: f.completion.report.revision,
    },
  ];
}
async function counts(database: Database, athlete: string) {
  return database.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox`,
          [athlete],
        )
      ).rows,
  );
}

it('normal107 public eight source families have exact ordered SQL relation observations without writes', async () => {
  const f = await coherentSources(db),
    refs = coreRefs(f),
    before = await counts(db, f.athlete);
  await snapshot(db, f.athlete, async (tx) => {
    const first = await observe(tx, refs),
      second = await observe(tx, refs);
    expect(first).toEqual(second);
    expect(first.rows.map((r) => r.identity)).toEqual(refs);
    const refsDigest = await tx.query(
      "SELECT encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') AS digest",
      [JSON.stringify(refs)],
    );
    expect(first.sqlRefsDigest).toBe(refsDigest.rows[0]?.['digest']);
    const reordered = await observe(tx, [...refs].reverse());
    expect(reordered.sqlRefsDigest).not.toBe(first.sqlRefsDigest);
    expect(reordered.rows.map((r) => r.identity)).toEqual([...refs].reverse());
    expect(first.rows.every((r) => r.state === 'observed')).toBe(true);
    expect(first.callerRole).toBe(runtimeRole);
    expect(first.athleteId).toBe(f.athlete);
    expect(first.rows.every((r) => r.relations.length > 0 && r.relationGroupDigest !== null)).toBe(
      true,
    );
    const raw = await tx.query(
      `SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS hash FROM race_event r WHERE athlete_id=$1 AND id=$2`,
      [f.athlete, f.race.id],
    );
    expect(first.rows[0]?.relations[0]?.sourceRowDigest).toBe(raw.rows[0]?.['hash']);
    await tx.query("SET LOCAL TimeZone='America/New_York'");
    expect(await observe(tx, refs)).toEqual(first);
    await tx.query(
      'SELECT public.observe_manual_review_full_owned_source_bindings_v2($1::jsonb) AS ignored',
      [JSON.stringify(refs)],
    );
  });
  expect(await counts(db, f.athlete)).toEqual(before);
});

it('strict all27 identities retain every absent fact rather than inventing sources or history', async () => {
  const f = await coherentSources(db),
    id = randomUUID(),
    version = randomUUID();
  const refs: Ref[] = [
    eventRef(f.race),
    { kind: 'plan-snapshot', sourceId: id, version: 1 },
    { kind: 'nutrition-plan-version', sourceId: id, versionId: version },
    { kind: 'routine-schedule-version', sourceId: id, versionId: version },
    { kind: 'routine-blueprint-version', sourceId: id, versionId: version },
    { kind: 'routine-occurrence', sourceId: id },
    { kind: 'routine-run', sourceId: id, revision: 0 },
    { kind: 'session-completion', sourceId: 'absent', planVersionId: version, revision: 1 },
    ...[
      'recovery-method-version',
      'recovery-strategy-version',
      'workout-template-version',
      'supplementary-exercise-version',
      'resource-text-version',
    ].map((kind) => ({ kind, sourceId: id, versionId: version })),
    { kind: 'food-definition-version', sourceId: 'opaque 식품 "\\', versionId: version },
    { kind: 'supplementary-session-copy', sourceId: id, sessionId: 'absent' },
    { kind: 'manual-activity-source', sourceId: id, sourceRecordId: 'absent', sourceRevision: 1 },
    { kind: 'activity-canonical-values', sourceId: id, revision: 1 },
    { kind: 'activity-overlay', sourceId: id, revision: 1 },
    { kind: 'intake-revision', sourceId: 'absent', revisionId: version },
    { kind: 'checkin-revision', sourceId: id, revision: 1 },
    {
      kind: 'checklist-confirmation',
      sourceId: id,
      revisionId: version,
      runId: id,
      stepId: 'step',
    },
    { kind: 'course-revision', sourceId: id, revisionId: version, revision: 1 },
    { kind: 'activity-track-descriptor', sourceId: id, trackId: version, revision: 1 },
    { kind: 'course-head-descriptor', sourceId: id, revision: 1 },
    { kind: 'race-timing-pin-fragment', sourceId: id, revision: 1 },
    { kind: 'gallery-descriptor', sourceId: id, accessRevision: 1 },
    { kind: 'routine-timer', sourceId: id, stepId: 'step', revision: 1 },
  ];
  expect(new Set(refs.map((r) => r['kind'])).size).toBe(27);
  const result = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(result.rows).toHaveLength(27);
  expect(result.rows[0]?.state).toBe('observed');
  for (const row of result.rows.slice(1))
    expect(row).toMatchObject({ state: 'unavailable', relations: [], relationGroupDigest: null });
});

it('foreign populated sources and wrong tuple are contentless unavailable under runtime RLS', async () => {
  const own = await coherentSources(db),
    foreign = await coherentSources(db);
  const foreignRefs = coreRefs(foreign).slice(1),
    wrong = {
      kind: 'nutrition-plan-version',
      sourceId: own.nutrition.planId,
      versionId: foreign.nutrition.versionId,
    };
  const result = await snapshot(db, own.athlete, (tx) =>
    observe(tx, [eventRef(own.race), ...foreignRefs, wrong]),
  );
  for (const row of result.rows.slice(1))
    expect(row).toMatchObject({ state: 'unavailable', relations: [], relationGroupDigest: null });
});
it.each([
  { kind: 'race-event', sourceId: randomUUID(), revision: 1, unknown: 'extra' },
  { kind: 'checkin-revision', sourceId: randomUUID(), revision: '1' },
  { kind: 'checkin-revision', sourceId: randomUUID(), revision: null },
  { kind: 'intake-revision', sourceId: 'intake', revisionId: 'not-uuid' },
  { kind: 'unknown', sourceId: 'x' },
])(
  'strict identity rejects malformed fields before any source facts ($kind)',
  async (malformed) => {
    const f = await coherentSources(db);
    await expect(
      snapshot(db, f.athlete, (tx) =>
        tx.query('SELECT public.observe_manual_review_full_owned_source_bindings_v2($1::jsonb)', [
          JSON.stringify([eventRef(f.race), malformed]),
        ]),
      ),
    ).rejects.toThrow('MANUAL_FULL_BINDING_');
  },
);
it('rejects aliases/duplicate, oversized5001 refs, missingrace, RC and missingtenant without authority', async () => {
  const f = await coherentSources(db),
    ref = eventRef(f.race);
  for (const refs of [
    [ref, { ...ref, sourceId: f.race.id.toUpperCase() }],
    Array.from({ length: 5001 }, () => ref),
    [{ kind: 'routine-run', sourceId: randomUUID(), revision: 0 }],
  ])
    await expect(snapshot(db, f.athlete, (tx) => observe(tx, refs))).rejects.toThrow(
      'MANUAL_FULL_BINDING_',
    );
  await expect(db.tenant(f.athlete, (tx) => observe(tx, [ref]))).rejects.toThrow(
    'MANUAL_FULL_BINDING_SNAPSHOT_REQUIRED',
  );
  const runtime = new Pool({ connectionString: url(runtimeRole) });
  try {
    await expect(
      runtime.query(
        'SELECT public.observe_manual_review_full_owned_source_bindings_v2($1::jsonb)',
        [JSON.stringify([ref])],
      ),
    ).rejects.toThrow('MANUAL_FULL_BINDING_TENANT_REQUIRED');
  } finally {
    await runtime.end();
  }
});
it('invoker function keeps plain owner and PUBLIC execute revoked, no registry activation', async () => {
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (
        await owner.query(
          `SELECT p.prosecdef, p.proowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AS owner,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_revoked FROM pg_proc p WHERE p.oid='public.observe_manual_review_full_owned_source_bindings_v2(jsonb)'::regprocedure`,
          [ownerRole],
        )
      ).rows[0],
    ).toEqual({ prosecdef: false, owner: true, public_revoked: true });
    expect(
      (
        await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [
          ownerRole,
        ])
      ).rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
});

const unknownNutrient = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
const nutrients = () => ({
  energy: unknownNutrient('kcal'),
  carbohydrate: unknownNutrient('g'),
  protein: unknownNutrient('g'),
  fat: unknownNutrient('g'),
  fluid: unknownNutrient('mL'),
  sodium: unknownNutrient('mg'),
});
it('public opaque food, recovery strategy and method, text versions retain exact historical relations', async () => {
  const f = await coherentSources(db),
    nutrition = createNutritionRepository(db),
    recovery = createRecoveryRepository(db),
    resources = createPrivateTextResourceRepository(db);
  const food = await nutrition.saveFood(f.athlete, {
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    definition: {
      foodId: '식품 "\\opaque',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: nutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-01-01T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  const newerFood = await nutrition.saveFood(f.athlete, {
    confirmed: true,
    expectedVersionId: food.versionId,
    idempotencyKey: randomUUID(),
    definition: {
      foodId: food.foodId,
      name: 'Changed food',
      basis: food.basis,
      nutrients: food.nutrients,
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: food.provenance.capturedAt,
        reviewState: 'unreviewed',
      },
    },
  });
  const method = await recovery.createMethod(f.athlete, {
    idempotencyKey: randomUUID(),
    title: 'Synthetic rest',
    category: 'rest',
    intendedUse: 'User report',
    applicability: [],
    cautions: [],
    sourceDescription: 'User record',
    evidenceLimitations: 'No efficacy proof',
  });
  const strategy = await recovery.createStrategy(f.athlete, {
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Synthetic strategy',
      goal: 'Read',
      startDate: '2026-10-01',
      endDateExclusive: '2026-10-31',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: randomUUID(),
          title: 'Method',
          kind: 'nonexercise_action',
          methodVersionId: method.versionId,
          explanation: 'Synthetic',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'user_report_changed',
          plannedAt: null,
          description: 'Explicit',
          policyVersion: null,
        },
      ],
    },
  });
  const text = await resources.create(f.athlete, {
    sourceKind: 'text',
    title: 'Synthetic text',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'First.\n\nSecond paragraph.',
    idempotencyKey: randomUUID(),
  });
  if (text.status !== 'available') throw Error('TEXT_FIXTURE_UNAVAILABLE');
  const newer = await resources.appendVersion(f.athlete, text.resource.id, {
    expectedCurrentVersionId: text.version.id,
    text: 'Current text.',
    idempotencyKey: randomUUID(),
  });
  if (newer.status !== 'available') throw Error('TEXT_FIXTURE_UNAVAILABLE');
  const refs: Ref[] = [
    eventRef(f.race),
    { kind: 'food-definition-version', sourceId: food.foodId, versionId: food.versionId },
    { kind: 'recovery-method-version', sourceId: method.methodId, versionId: method.versionId },
    {
      kind: 'recovery-strategy-version',
      sourceId: strategy.strategyId,
      versionId: strategy.versionId,
    },
    { kind: 'resource-text-version', sourceId: text.resource.id, versionId: text.version.id },
  ];
  const result = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(result.rows.every((r) => r.state === 'observed')).toBe(true);
  expect(result.rows[1]?.identity['sourceId']).toBe(food.foodId);
  expect(newerFood.versionId).not.toBe(food.versionId);
  expect(result.rows[1]?.relations.map((r) => r.role)).toEqual([
    'current_head',
    'immutable_version',
  ]);
  expect(result.rows[4]?.relations.map((r) => r.role)).toEqual([
    'current_head',
    'immutable_version',
  ]);
  await resources.softDelete(f.athlete, text.resource.id, {
    expectedAccessRevision: newer.resource.accessRevision,
    expectedCurrentVersionId: newer.version.id,
    idempotencyKey: randomUUID(),
  });
  const deleted = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(deleted.rows[4]).toMatchObject({
    state: 'unavailable',
    relations: [],
    relationGroupDigest: null,
  });
});

it('current/manual Activity, delta overlay, historical checkin and intake use distinct exact revision namespaces', async () => {
  const f = await coherentSources(db),
    activities = createActivityRepository(db),
    checks = createCheckInRepository(db),
    nutrition = createNutritionRepository(db);
  const activity = await activities.createManualActivity(f.athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Synthetic report',
      kind: 'unknown',
      startedAt: '2026-01-01T00:00:00Z',
      durationSeconds: 0,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: null,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const source = await db.tenant(f.athlete, async (tx) =>
    z
      .strictObject({ source_id: z.string(), source_revision: z.number().int() })
      .parse(
        (
          await tx.query(
            "SELECT source_id,source_revision FROM activity_source_head WHERE athlete_id=$1 AND activity_id=$2 AND kind='manual'",
            [f.athlete, activity.activityId],
          )
        ).rows[0],
      ),
  );
  const changed = await activities.updateOverlay(f.athlete, activity.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    title: 'Correction',
    reason: 'Synthetic correction',
  });
  const values = {
    observedAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: null,
  };
  const check = await checks.createCheckIn(f.athlete, { values, idempotencyKey: randomUUID() });
  await checks.updateCheckIn(f.athlete, check.id, {
    expectedRevision: 1,
    values: { ...values, fatigue: 1 },
    reason: 'Synthetic',
    idempotencyKey: randomUUID(),
  });
  const generation = await db.tenant(f.athlete, async (tx) =>
    z
      .uuid()
      .parse(
        (await tx.query('SELECT public.current_restore_generation() AS value')).rows[0]?.['value'],
      ),
  );
  const intakeFood = await nutrition.saveFood(f.athlete, {
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    definition: {
      foodId: 'synthetic-intake-food',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: nutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-01-01T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  const intake = await nutrition.createIntake(f.athlete, {
    intakeId: '섭취 "opaque\\id',
    confirmed: true,
    occurredAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: intakeFood.versionId,
        description: 'Synthetic food',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'per_100g',
      },
    ],
    nutrientTotal: nutrients(),
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user',
    sourceRecordId: null,
    notes: null,
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
  });
  const refs: Ref[] = [
    eventRef(f.race),
    {
      kind: 'manual-activity-source',
      sourceId: activity.activityId,
      sourceRecordId: source.source_id,
      sourceRevision: source.source_revision,
    },
    {
      kind: 'activity-canonical-values',
      sourceId: activity.activityId,
      revision: changed.revision,
    },
    { kind: 'activity-overlay', sourceId: activity.activityId, revision: changed.revision },
    { kind: 'checkin-revision', sourceId: check.id, revision: 1 },
    { kind: 'intake-revision', sourceId: intake.intakeId, revisionId: intake.revisionId },
  ];
  const result = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(result.rows.every((r) => r.state === 'observed')).toBe(true);
  expect(result.rows[1]?.relations.some((r) => r.relation === 'activity_source_revision')).toBe(
    true,
  );
  expect(result.rows[3]?.relations.map((r) => r.role)).toEqual([
    'current_overlay',
    'overlay_revision',
  ]);
  const historical = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [
      eventRef(f.race),
      { kind: 'activity-overlay', sourceId: activity.activityId, revision: 1 },
      { kind: 'activity-canonical-values', sourceId: activity.activityId, revision: 1 },
    ]),
  );
  expect(
    historical.rows.slice(1).every((r) => r.reason === 'historical_observation_unavailable'),
  ).toBe(true);
});

it('public checklist and timer require exact frozen run/step membership and do not invent historical timers', async () => {
  const f = await coherentSources(db);
  const recorded = await f.routines.recordStep(f.athlete, {
    runId: f.run.run.id,
    stepId: 'step',
    state: 'performed',
    actualRefs: [],
    occurredAt: '2026-10-07T00:00:00Z',
    reason: null,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const confirmation = await db.tenant(f.athlete, async (tx) =>
    z
      .strictObject({ id: z.uuid(), revision_id: z.uuid() })
      .parse(
        (
          await tx.query(
            'SELECT id,revision_id FROM routine_checklist_confirmation WHERE athlete_id=$1 AND run_id=$2 AND step_id=$3',
            [f.athlete, f.run.run.id, 'step'],
          )
        ).rows[0],
      ),
  );
  const timer = await f.routines.commandTimer(f.athlete, {
    runId: f.run.run.id,
    stepId: 'step',
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  const refs: Ref[] = [
    eventRef(f.race),
    { kind: 'routine-run', sourceId: recorded.run.id, revision: 0 },
    {
      kind: 'checklist-confirmation',
      sourceId: confirmation.id,
      revisionId: confirmation.revision_id,
      runId: recorded.run.id,
      stepId: 'step',
    },
    { kind: 'routine-timer', sourceId: recorded.run.id, stepId: 'step', revision: timer.revision },
  ];
  expect(
    (await snapshot(db, f.athlete, (tx) => observe(tx, refs))).rows.every(
      (r) => r.state === 'observed',
    ),
  ).toBe(true);
  const changed = await f.routines.commandTimer(f.athlete, {
    runId: recorded.run.id,
    stepId: 'step',
    action: 'pause',
    durationSeconds: null,
    expectedRevision: timer.revision,
    idempotencyKey: randomUUID(),
  });
  const after = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [
      ...refs,
      {
        kind: 'routine-timer',
        sourceId: recorded.run.id,
        stepId: 'step',
        revision: changed.revision,
      },
    ]),
  );
  expect(after.rows[3]?.reason).toBe('historical_observation_unavailable');
  expect(after.rows[4]?.state).toBe('observed');
  const wrong = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [eventRef(f.race), { ...refs[2], runId: randomUUID() }]),
  );
  expect(wrong.rows[1]?.state).toBe('unavailable');
});

it('public full workout and embedded strength session preserve exact target relational membership', async () => {
  const f = await coherentSources(db),
    catalog = createSupplementaryRepository(db);
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
      description: 'Synthetic',
      safetyNotes: '',
      supportedMetrics: ['duration'],
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const versionId = randomUUID();
  const spec = {
    schemaVersion: 2 as const,
    kind: 'supplementary' as const,
    routineVersionId: versionId,
    blocks: [
      {
        id: 'block',
        mode: 'single' as const,
        rounds: 1,
        sets: [
          {
            id: 'set',
            exerciseVersionId: exercise.definition.versionId,
            side: 'unspecified' as const,
            count: null,
            durationSeconds: {
              min: 30,
              max: 30,
              unit: 's' as const,
              basis: 'user_confirmed' as const,
              evidenceIds: [],
            },
            externalResistance: { kind: 'no_added_load' as const },
            restAfterSeconds: 0,
            tempo: null,
            effort: null,
          },
        ],
        restBetweenRoundsSeconds: null,
      },
    ],
  };
  const workout = await catalog.saveRoutine(f.athlete, {
    template: {
      schemaVersion: 2,
      routineId: randomUUID(),
      versionId,
      title: 'Synthetic template',
      purpose: 'User choice',
      requiredEquipment: ['bodyweight'],
      spec,
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const strength = await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...draft(), sessions: draft().sessions.map((s) => ({ ...s, sport: 'strength' })) },
    supplementaryLinks: [
      {
        plannedSessionId: 'session',
        content: { kind: 'embedded', spec: { ...spec, routineVersionId: null } },
      },
    ],
  });
  const refs: Ref[] = [
    eventRef(f.race),
    {
      kind: 'supplementary-exercise-version',
      sourceId: exercise.definition.exerciseId,
      versionId: exercise.definition.versionId,
    },
    {
      kind: 'workout-template-version',
      sourceId: workout.template.routineId,
      versionId: workout.template.versionId,
    },
    { kind: 'supplementary-session-copy', sourceId: strength.id, sessionId: 'session' },
  ];
  const result = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(result.rows.every((r) => r.state === 'observed')).toBe(true);
  expect(result.rows[2]?.relations.map((r) => r.role)).toEqual(['immutable_version', 'target']);
  expect(result.rows[3]?.relations.map((r) => r.role)).toEqual(['source_fragment', 'target']);
  const wrong = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [eventRef(f.race), { ...refs[3], sessionId: 'missing' }]),
  );
  expect(wrong.rows[1]?.state).toBe('unavailable');
});

async function storedImage(database: Database, athlete: string) {
  const gallery = createGalleryMediaRepository(database),
    hash = 'a'.repeat(64);
  const reservation = await gallery.reserveCreate(
    athlete,
    {
      mediaKind: 'image',
      album: null,
      caption: 'Synthetic metadata',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    randomUUID(),
  );
  const storageRef = `private/v1/tenants/${athlete}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${hash}.png`;
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef,
    file: { originalFileName: 'synthetic.png', mediaType: 'image/png', byteSize: 2, sha256: hash },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  const finalized = await gallery.finalize(athlete, reservation.uploadId);
  if (finalized.status !== 'available') throw Error('MEDIA_FIXTURE_UNAVAILABLE');
  return { gallery, item: finalized.item };
}
it('gallery descriptor has explicit113 capability absence and normal ledger grant, no locator output', async () => {
  const f = await coherentSources(db),
    media = await storedImage(db, f.athlete);
  const result = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [
      eventRef(f.race),
      {
        kind: 'gallery-descriptor',
        sourceId: media.item.id,
        accessRevision: media.item.accessRevision,
      },
    ]),
  );
  expect(result.rows[1]).toMatchObject({
    state: 'unavailable',
    reason: 'cleanup_observation_unavailable',
    cleanupObservationDigest: null,
  });
  expect(result.rows[1]?.relations.some((r) => r.role === 'original_ledger')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private/v1/');
  expect(JSON.stringify(result)).not.toContain('synthetic.png');
  const stage = await coherentSources(staged),
    owned = await storedImage(staged, stage.athlete);
  const current = await snapshot(staged, stage.athlete, (tx) =>
    observe(tx, [
      eventRef(stage.race),
      {
        kind: 'gallery-descriptor',
        sourceId: owned.item.id,
        accessRevision: owned.item.accessRevision,
      },
    ]),
  );
  expect(current.rows[1]).toMatchObject({
    state: 'observed',
    reason: null,
    cleanupObservationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const updated = await owned.gallery.update(stage.athlete, owned.item.id, {
    album: null,
    caption: 'Changed caption',
    activityId: null,
    expectedAccessRevision: 1,
    idempotencyKey: randomUUID(),
  });
  if (updated.status !== 'available') throw Error('MEDIA_FIXTURE_UNAVAILABLE');
  const old = await snapshot(staged, stage.athlete, (tx) =>
    observe(tx, [
      eventRef(stage.race),
      { kind: 'gallery-descriptor', sourceId: owned.item.id, accessRevision: 1 },
    ]),
  );
  expect(old.rows[1]).toMatchObject({
    state: 'unavailable',
    reason: 'historical_observation_unavailable',
    relations: [],
  });
  await owned.gallery.softDelete(stage.athlete, owned.item.id, {
    expectedAccessRevision: updated.item.accessRevision,
    idempotencyKey: randomUUID(),
  });
  const deleted = await snapshot(staged, stage.athlete, (tx) =>
    observe(tx, [
      eventRef(stage.race),
      {
        kind: 'gallery-descriptor',
        sourceId: owned.item.id,
        accessRevision: updated.item.accessRevision + 1,
      },
    ]),
  );
  expect(deleted.rows[1]?.state).toBe('unavailable');
});
const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

function importInput(sourceId = randomUUID()): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Course run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

function finalRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

/** Store one recording, as the API's upload lifecycle does. */
async function storeTrack(athleteId: string, activityId: string, expectedActivityRevision: number) {
  const tracks = createActivityTrackRepository(db);
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${reservation.uploadId}`);
  const normalizedSha = hashOf(`normalized-${reservation.uploadId}`);
  const mapPathSha = hashOf(`map-${reservation.uploadId}`);
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: finalRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'map_path',
        sha256: mapPathSha,
        extension: 'json',
      }),
      sizeBytes: 1024,
      sha256: mapPathSha,
    },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${reservation.uploadId}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { trackId: reservation.trackId, mapPathSha };
}

const coordinates: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function content(input: {
  activityId: string;
  trackId: string;
  name?: string;
  trackRevision?: number;
  mapPathSha?: string;
  endSampleId?: string;
  coordinates?: [number, number][];
}): PreparedCourseContent {
  const line = input.coordinates ?? coordinates;
  const [startPosition] = line;
  const endPosition = line[line.length - 1];
  if (startPosition === undefined || endPosition === undefined)
    throw new Error('a course needs at least two vertices');
  const generation = {
    kind: 'recorded-segment',
    activityId: input.activityId,
    trackId: input.trackId,
    trackRevision: input.trackRevision ?? 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: input.endSampleId ?? '0:2',
    vertexCount: line.length,
    mapPathContentSha256: input.mapPathSha ?? 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  } as const;
  const lineage = [
    {
      activityId: input.activityId,
      trackId: input.trackId,
      trackRevision: input.trackRevision ?? 1,
    },
  ];
  const name = input.name ?? 'Seoul loop';
  const result: PreparedCourseContent = {
    name,
    coordinates: line,
    waypoints: [
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0', locked: false },
      {
        role: 'finish',
        position: endPosition,
        name: null,
        sourceSampleId: generation.endSampleId,
        locked: false,
      },
    ],
    generation,
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: '',
  };
  return { ...result, contentDigest: courseContentDigest(result) };
}

it('public course and track descriptors bind ordered exact lineage and retained historical revision', async () => {
  const f = await coherentSources(db),
    activities = createActivityRepository(db),
    courses = createCourseRepository(db);
  const input = importInput(),
    imported = await activities.importActivity(f.athlete, input),
    stored = await storeTrack(f.athlete, imported.activityId, imported.revision);
  const body = content({
    activityId: imported.activityId,
    trackId: stored.trackId,
    mapPathSha: stored.mapPathSha,
  });
  const saved = await courses.create(f.athlete, body, randomUUID());
  if (saved.status !== 'available') throw Error('COURSE_FIXTURE_UNAVAILABLE');
  const refs: Ref[] = [
    eventRef(f.race),
    {
      kind: 'course-revision',
      sourceId: saved.course.courseId,
      revisionId: saved.revision.revisionId,
      revision: saved.revision.courseRevision,
    },
    {
      kind: 'course-head-descriptor',
      sourceId: saved.course.courseId,
      revision: saved.revision.courseRevision,
    },
    {
      kind: 'activity-track-descriptor',
      sourceId: imported.activityId,
      trackId: stored.trackId,
      revision: 1,
    },
    {
      kind: 'activity-canonical-values',
      sourceId: imported.activityId,
      revision: imported.revision,
    },
  ];
  const observed = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(observed.rows.every((r) => r.state === 'observed')).toBe(true);
  expect(observed.rows[1]?.relations.map((r) => r.role)).toEqual(['immutable_revision', 'lineage']);
  expect(JSON.stringify(observed)).not.toContain('126.9779');
  expect(JSON.stringify(observed)).not.toContain('private/v1/');
  const wrong = await snapshot(db, f.athlete, (tx) =>
    observe(tx, [
      eventRef(f.race),
      { ...refs[1], revisionId: randomUUID() },
      { ...refs[3], trackId: randomUUID() },
    ]),
  );
  expect(wrong.rows.slice(1).every((r) => r.state === 'unavailable')).toBe(true);
  await courses.remove(f.athlete, saved.course.courseId, 1);
  const gone = await snapshot(db, f.athlete, (tx) => observe(tx, refs));
  expect(gone.rows[1]?.state).toBe('unavailable');
  expect(gone.rows[2]?.state).toBe('unavailable');
});
it('explicit V4 staging binds old/current pin fragments through exact saved nutrition membership, never a current-race substitute', async () => {
  const f = await coherentSources(staged);
  const { athlete, race } = f;
  const races = createRaceRepository(staged);
  const values = { ...raceValues, planVersionId: f.plan.id };
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

  const refs: Ref[] = [
    eventRef(changed),
    {
      kind: 'nutrition-plan-version',
      sourceId: saved.plan.planId,
      versionId: saved.plan.versionId,
    },
    { kind: 'race-timing-pin-fragment', sourceId: race.id, revision: 1 },
    { kind: 'race-timing-pin-fragment', sourceId: race.id, revision: 2 },
  ];
  const before = await counts(staged, athlete);
  const result = await snapshot(staged, athlete, (tx) => observe(tx, refs));
  expect(result.rows.every((r) => r.state === 'observed')).toBe(true);
  expect(result.rows[2]?.relations.map((r) => r.role)).toEqual(['pin_membership']);
  expect(result.rows[3]?.relations.map((r) => r.role)).toEqual(['pin_membership']);
  expect(result.rows[0]?.identity).toEqual(eventRef(changed));
  expect(result.rows[2]?.identity).not.toEqual(result.rows[0]?.identity);
  // Membership must originate in one of the explicitly consumed nutrition versions.
  const unrelated = await snapshot(staged, athlete, (tx) =>
    observe(tx, [
      eventRef(changed),
      { kind: 'race-timing-pin-fragment', sourceId: race.id, revision: 1 },
    ]),
  );
  expect(unrelated.rows[1]).toMatchObject({
    state: 'unavailable',
    relations: [],
    relationGroupDigest: null,
  });
  expect(saved.plan.raceTimingPins.map((p) => p.eventRevision)).toEqual([1, 2]);
  expect(await counts(staged, athlete)).toEqual(before);
});

it('all actual full-row bytes are preflight bounded before hashing or returning oversized groups', async () => {
  const f = await coherentSources(db),
    refs: Ref[] = [eventRef(f.race)];
  for (let index = 0; index < 9; index++) {
    const blueprint = await f.routines.saveBlueprint(f.athlete, {
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      blueprint: {
        ...f.blueprint,
        routineId: randomUUID(),
        versionId: randomUUID(),
        steps: f.blueprint.steps.map((step) => ({
          ...step,
          content: { kind: 'checklist', prompt: 'x'.repeat(500000) },
        })),
      },
    });
    refs.push({
      kind: 'routine-blueprint-version',
      sourceId: blueprint.blueprint.routineId,
      versionId: blueprint.blueprint.versionId,
    });
  }
  const before = await counts(db, f.athlete);
  await expect(snapshot(db, f.athlete, (tx) => observe(tx, refs))).rejects.toThrow(
    'MANUAL_FULL_BINDING_SOURCE_BOUND',
  );
  expect(await counts(db, f.athlete)).toEqual(before);
});
