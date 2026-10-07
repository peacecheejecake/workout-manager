import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { createActivityRepository } from '../src/activities.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { currentRestoreGeneration } from '../src/restore-generation.js';
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createPlanningRepository } from '../src/planning.js';
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
// Root-only actual PG: normal107 public all-four producers + explicit staged
// raw108..116/118/120/121/122. Identity-only owner seed; no health source bypass.
// No API/browser, provider or real-device evidence is claimed.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `manual_public_fresh_${suffix}`,
  ownerRole = `manual_public_fresh_owner_${suffix}`,
  runtimeRole = `manual_public_fresh_app_${suffix}`;
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
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
      '111_race_result_preserved_proof_updates.sql',
      '112_training_plan_aggregate_history.sql',
      '113_race_media_cleanup_source.sql',
      '114_manual_review_owned_source_bindings_v2.sql',
      '115_manual_review_full_owned_source_bindings_v2.sql',
      '116_manual_race_chain_v2.sql',
    ])
      await migrationOwner.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    const before = (
      await migrationOwner.query(
        "SELECT proowner::text,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0];
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/118_race_manual_atomic_approval.sql', import.meta.url),
        'utf8',
      ),
    );
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/120_manual_race_multi_owned_sources.sql', import.meta.url),
        'utf8',
      ),
    );
    const occurrenceInvariantQuery = `SELECT
      (SELECT jsonb_build_object('owner',p.proowner::text,'acl',p.proacl::text,'config',p.proconfig,'definer',p.prosecdef,'source',p.prosrc)
       FROM pg_proc p WHERE p.oid='public.routine_immutable()'::regprocedure) AS immutable_function,
      (SELECT jsonb_build_object('owner',c.relowner::text,'acl',c.relacl::text,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity)
       FROM pg_class c WHERE c.oid='public.routine_occurrence'::regclass) AS relation,
      (SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname)
       FROM pg_constraint c WHERE c.conrelid='public.routine_occurrence'::regclass AND c.conname NOT IN
        ('routine_occurrence_athlete_id_schedule_id_anchor_key_key','routine_occurrence_version_anchor_unique')) AS constraints,
      (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t
       WHERE t.tgrelid='public.routine_occurrence'::regclass AND NOT t.tgisinternal) AS triggers,
      (SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
       FROM pg_policy p WHERE p.polrelid='public.routine_occurrence'::regclass) AS policies`;
    const occurrenceBefore = (await migrationOwner.query(occurrenceInvariantQuery)).rows[0];
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/121_routine_versioned_occurrences.sql', import.meta.url),
        'utf8',
      ),
    );
    expect((await migrationOwner.query(occurrenceInvariantQuery)).rows[0]).toEqual(
      occurrenceBefore,
    );
    expect(
      (
        await migrationOwner.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.routine_occurrence'::regclass AND conname='routine_occurrence_version_anchor_unique'",
        )
      ).rows,
    ).toEqual([
      { definition: 'UNIQUE (athlete_id, schedule_id, schedule_version_id, anchor_key)' },
    ]);
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/122_race_manual_public_receipts.sql', import.meta.url),
        'utf8',
      ),
    );
    const after = (
      await migrationOwner.query(
        "SELECT proowner::text,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0];
    expect(after).toEqual(before);
    for (const signature of [
      'public.read_race_manual_public_receipt_v1(text,text,jsonb)',
      'public.finish_race_manual_public_review_v1(text,jsonb,uuid)',
      'public.read_race_manual_public_approval_v1(text,jsonb)',
      'public.finish_race_manual_public_approval_v1(text,jsonb)',
      'public.read_race_manual_public_candidate_v1(uuid)',
      'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
      'public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)',
      'public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_chain_receipt_v2(text,jsonb)',
      'public.read_manual_race_chain_v2(uuid)',
      'public.read_nutrition_disconnection_origin(uuid,uuid,text)',
      'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
      'public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.read_race_manual_application_v1(uuid)',
      'public.read_race_manual_application_receipt_v1(text,jsonb)',
      'public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.apply_race_manual_event_v1(uuid)',
      'public.race_manual_nutrition_affected_items_v1(uuid,jsonb)',
      'public.commit_race_manual_application_v1(uuid,jsonb)',
      'public.race_manual_nutrition_preserved_items_v1(uuid,jsonb)',
    ])
      await migrationOwner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
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
    // Existing identity-e2e.mts:632 / semantic-basis PG:102 seven-table composition.
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

// Public commands produce all health/plan rows. Owner setup below is identity-FK
// only; raw108..116/118 are explicit unregistered staging, not normal107 activation.
async function setup(options: { recovery?: boolean } = {}) {
  const athlete = randomUUID(),
    owner = new Pool({ connectionString: url(ownerRole) });
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
  const planning = createPlanningRepository(db);
  const draft = planDraftSchema.parse({
    title: 'Synthetic all-domain plan',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
      id: level,
      parentId: index ? ids[index - 1] : null,
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: '08:00',
        title: 'Planned only',
        sport: 'running',
        durationSeconds: 1800,
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
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const aggregateId = await db.tenant(athlete, async (tx) =>
    z
      .uuid()
      .parse(
        (
          await tx.query(
            'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
            [athlete, plan.id],
          )
        ).rows[0]?.['aggregate_id'],
      ),
  );
  const races = createRaceRepository(db);
  const values = {
    title: 'Synthetic race',
    localDate: '2026-10-06',
    localStartTime: '09:00',
    timezone: 'UTC',
    locationName: null,
    distance: { kind: 'standard' as const, class: '10k' as const },
    priority: null,
    participation: 'registered' as const,
    officialUrl: null,
    course: null,
    targetSeconds: null,
    planVersionId: plan.id,
  };
  const event = await races.createRaceEvent(athlete, { idempotencyKey: randomUUID(), values });
  const other = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: { ...values, title: 'Unchanged source', planVersionId: null },
  });
  const nutrition = nutritionPlanVersionV2Schema.parse(
    await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
      schemaVersion: 2,
      command: {
        kind: 'create',
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft: {
          period: { from: '2026-10-01', toInclusive: '2026-11-04' },
          timezone: 'UTC',
          purpose: 'Retained synthetic food',
          linkedTrainingPlanVersionId: plan.id,
          items: [event, other].map((r, index) => ({
            id: `meal-${index}`,
            category: 'before',
            title: 'Retained meal',
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: r.id,
              point: 'start',
              offsetMinutes: -30,
            },
            foods: [
              {
                foodVersionId: null,
                description: 'Retained food',
                quantity: 0,
                unit: 'g',
                sourceBasis: 'unknown',
              },
            ],
            targets: [],
            instructions: 'Record synthetic intake explicitly',
            evidenceIds: [],
            source: 'user_confirmed',
          })),
        },
      },
      expectedRaceHeads: [event, other]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({
          namespace: 'race-event',
          eventId: r.id,
          revision: r.revision,
        })),
    }),
  );
  await races.updateRaceEvent(athlete, other.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: other.revision,
    values: { ...values, title: 'Historical unrelated pin retained', planVersionId: null },
  });
  const intakeRepo = createNutritionRepository(db),
    generation = await db.tenant(athlete, currentRestoreGeneration);
  const unknown = <T extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: T) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const intake = await intakeRepo.createIntake(athlete, {
    idempotencyKey: randomUUID(),
    restoreGeneration: generation,
    intakeId: randomUUID(),
    confirmed: true,
    occurredAt: '2026-10-06T00:00:00Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Actual user food',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'unknown',
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
  const recovery = createRecoveryRepository(db),
    optionId = randomUUID();
  const createStrategy = async () => {
    const strategy = await recovery.createStrategy(athlete, {
      idempotencyKey: randomUUID(),
      draft: {
        title: 'Existing selected rest',
        goal: 'Keep user facts',
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-05',
        timezone: 'UTC',
        knownFacts: ['User reported'],
        missingInformation: [],
        priority: 'normal',
        observations: [],
        planRefs: [
          { kind: 'training', aggregateId, headVersionId: plan.id },
          { kind: 'nutrition', aggregateId: nutrition.planId, headVersionId: nutrition.versionId },
        ],
        options: [
          {
            id: optionId,
            title: 'Rest',
            kind: 'full_rest',
            methodVersionId: null,
            explanation: 'Existing user option',
          },
        ],
        reassessment: [
          {
            id: randomUUID(),
            trigger: 'plan_changed',
            description: 'Review existing facts',
            plannedAt: null,
            policyVersion: null,
          },
        ],
      },
    });
    return recovery.confirmStrategy(athlete, {
      strategyId: strategy.strategyId,
      expectedHeadVersionId: strategy.versionId,
      selectedOptionId: optionId,
      idempotencyKey: randomUUID(),
    });
  };
  const confirmed = options.recovery === false ? null : await createStrategy();
  const routine = createRoutineRepository(db),
    blueprint = (
      await routine.saveBlueprint(athlete, {
        confirmed: true,
        expectedVersionId: null,
        idempotencyKey: randomUUID(),
        blueprint: {
          schemaVersion: 4,
          routineId: randomUUID(),
          versionId: randomUUID(),
          title: 'Synthetic checklist',
          intent: 'Keep planned distinct',
          status: 'published',
          tags: [],
          estimatedDurationSeconds: null,
          createdAt: '2026-10-08T00:00:00Z',
          steps: [
            {
              id: 'step',
              title: 'Check',
              content: { kind: 'checklist', prompt: 'Synthetic question' },
              timing: { kind: 'ordered', afterStepId: null },
              required: true,
              choiceGroupId: null,
            },
          ],
          choiceGroups: [],
        },
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
        endDateExclusive: '2026-11-05',
        timezone: 'UTC',
        maxOccurrences: 10,
      },
      rule: {
        kind: 'period_days' as const,
        periodId: 'season',
        offsetsDays: [5],
        localTime: '08:00',
      },
      state: 'draft' as const,
    },
    sourcePlanVersionId: plan.id,
  };
  const preview = await routine.previewSchedule(athlete, scheduleInput);
  const approved = await routine.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const intent = raceProjectionIntentSchema.parse({
    expectedEvent: { id: event.id, revision: event.revision },
    newLocalDate: '2026-10-08',
    selection: {
      kind: 'move_period' as const,
      expectedCurrentPlanVersionId: plan.id,
      periodId: 'season',
      newStartDate: '2026-10-03',
      scope: 'descendants_and_sessions' as const,
    },
  });
  return {
    athlete,
    consent,
    planning,
    races,
    event,
    other,
    plan,
    nutrition,
    intake,
    intakeRepo,
    recovery,
    confirmed,
    routine,
    approved,
    intent,
  };
}

function reviewCommand(f: Awaited<ReturnType<typeof setup>>) {
  return { schemaVersion: 1 as const, idempotencyKey: randomUUID(), intent: f.intent };
}
async function domainCounts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT
 (SELECT count(*)::int FROM plan_snapshot WHERE athlete_id=$1) AS training,
 (SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS nutrition,
 (SELECT count(*)::int FROM recovery_strategy_version WHERE athlete_id=$1) AS recovery,
 (SELECT count(*)::int FROM routine_schedule_version WHERE athlete_id=$1) AS routine,
 (SELECT count(*)::int FROM race_event_revision WHERE athlete_id=$1) AS race,
 (SELECT count(*)::int FROM intake_entry WHERE athlete_id=$1) AS intake,
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY version_id) FROM plan_head h WHERE athlete_id=$1) AS training_heads,
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY plan_id) FROM nutrition_plan_head h WHERE athlete_id=$1) AS nutrition_heads,
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY strategy_id) FROM recovery_strategy_head h WHERE athlete_id=$1) AS recovery_heads,
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY schedule_id) FROM routine_schedule_head h WHERE athlete_id=$1) AS routine_heads`,
          [athlete],
        )
      ).rows,
  );
}
// Owner read-only inspection of private row counts is not a runtime capability or
// a source ownership witness. All source/admission writes remain public commands.
async function privateCounts(athlete: string) {
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const rows = (
      await owner.query(
        `SELECT
 (SELECT count(*)::int FROM manual_race_evidence_v2 WHERE athlete_id=$1) AS evidence,
 (SELECT count(*)::int FROM race_manual_application_candidate_v1 WHERE athlete_id=$1) AS candidates`,
        [athlete],
      )
    ).rows;
    await owner.query('COMMIT');
    return rows;
  } finally {
    await owner.end();
  }
}
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waiter() {
  await expect
    .poll(
      async () =>
        z
          .number()
          .parse(
            (
              await admin.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock' AND wait_event='advisory'",
                [name, runtimeRole],
              )
            ).rows[0]?.['count'],
          ),
      { timeout: 2000, interval: 10 },
    )
    .toBeGreaterThan(0);
}

type Fixture = Awaited<ReturnType<typeof setup>>;
const snapshot: Database['tenant'] = (athlete, operation) => {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_REQUIRED');
  return db.snapshotTenant(athlete, operation);
};
async function reviewed(f: Fixture) {
  const result = await createRaceManualPublicRepository(db).review(f.athlete, reviewCommand(f));
  if (result.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  return {
    schemaVersion: 1 as const,
    idempotencyKey: randomUUID(),
    candidateId: result.reference.candidateId,
    applicationDigest: result.reference.applicationDigest,
    confirmed: true as const,
  };
}
async function unchanged(f: Fixture, before: Awaited<ReturnType<typeof domainCounts>>) {
  expect(await domainCounts(f.athlete)).toEqual(before);
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  expect(
    (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
  ).toEqual(f.nutrition);
}
async function rest(f: Fixture) {
  const option = randomUUID();
  const strategy = await f.recovery.createStrategy(f.athlete, {
    idempotencyKey: randomUUID(),
    draft: {
      title: 'New actual recovery aggregate',
      goal: 'Existing user choice',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-05',
      timezone: 'UTC',
      knownFacts: ['Synthetic user report'],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [
        {
          kind: 'nutrition',
          aggregateId: f.nutrition.planId,
          headVersionId: f.nutrition.versionId,
        },
      ],
      options: [
        {
          id: option,
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'Existing rest choice',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'plan_changed',
          description: 'Review actual source change',
          plannedAt: null,
          policyVersion: null,
        },
      ],
    },
  });
  return f.recovery.confirmStrategy(f.athlete, {
    strategyId: strategy.strategyId,
    expectedHeadVersionId: strategy.versionId,
    selectedOptionId: option,
    idempotencyKey: randomUUID(),
  });
}

it('absent recovery roster becomes a real first public head and invalidates the original candidate', async () => {
  const f = await setup({ recovery: false }),
    command = await reviewed(f);
  expect(f.confirmed).toBeNull();
  const original = await domainCounts(f.athlete);
  expect(original[0]?.['recovery']).toBe(0);
  await rest(f);
  const before = await domainCounts(f.athlete);
  await expect(createRaceManualPublicRepository(db).approve(f.athlete, command)).rejects.toThrow(
    'STALE_BASIS',
  );
  await unchanged(f, before);
});

it('a second public recovery aggregate changes the whole roster without moving the original head', async () => {
  const f = await setup(),
    command = await reviewed(f);
  await rest(f);
  const before = await domainCounts(f.athlete);
  await expect(createRaceManualPublicRepository(db).approve(f.athlete, command)).rejects.toThrow(
    'STALE_BASIS',
  );
  await unchanged(f, before);
});

function manual(f: Fixture) {
  return createActivityRepository(db).createManualActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    confirmed: true,
    activity: {
      title: 'Synthetic live roster',
      kind: 'running',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'UTC',
      durationSeconds: 600,
      durationKind: 'timer',
      distanceMeters: 0,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
}
async function liveSummary(f: Fixture) {
  return db.tenant(f.athlete, async (tx) =>
    z
      .strictObject({ count: z.string(), sum: z.string() })
      .parse(
        (
          await tx.query(
            'SELECT count(*)::text AS count,coalesce(sum(revision),0)::text AS sum FROM activity_canonical WHERE athlete_id=$1 AND NOT deleted',
            [f.athlete],
          )
        ).rows[0],
      ),
  );
}
it('public delete/create with identical live count and revision sum changes exact Activity identity', async () => {
  const f = await setup(),
    a = await manual(f),
    command = await reviewed(f),
    summary = await liveSummary(f);
  await createActivityRepository(db).deleteActivity(f.athlete, a.activityId, {
    expectedRevision: a.revision,
  });
  const b = await manual(f);
  expect(b.activityId).not.toBe(a.activityId);
  expect(await liveSummary(f)).toEqual(summary);
  expect(summary).toEqual({ count: '1', sum: '1' });
  const before = await domainCounts(f.athlete);
  await expect(createRaceManualPublicRepository(db).approve(f.athlete, command)).rejects.toThrow(
    /STALE_BASIS|PARENT_UNAVAILABLE|APPLICATION_UNAVAILABLE/,
  );
  await unchanged(f, before);
});
it('a public mutable Activity overlay revision makes the captured original candidate stale', async () => {
  const f = await setup(),
    a = await manual(f),
    command = await reviewed(f),
    activities = createActivityRepository(db);
  await activities.updateOverlay(f.athlete, a.activityId, {
    expectedRevision: a.revision,
    title: 'Actual user correction',
    reason: 'Synthetic exact revision correction',
    idempotencyKey: randomUUID(),
  });
  const before = await domainCounts(f.athlete);
  await expect(createRaceManualPublicRepository(db).approve(f.athlete, command)).rejects.toThrow(
    'STALE_BASIS',
  );
  await unchanged(f, before);
});
it('unconsumed food head movement and unused AI consent do not repin saved nutrition or deny core approval', async () => {
  const f = await setup(),
    datum = <T extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: T, value: number | null) => ({
      unit,
      value,
      status: value === null ? ('unknown' as const) : ('reported' as const),
      evidenceIds: [],
    });
  const definition = {
    foodId: randomUUID(),
    name: 'Unconsumed food',
    basis: { kind: 'per_100g' as const },
    nutrients: {
      energy: datum('kcal', 0),
      carbohydrate: datum('g', null),
      protein: datum('g', null),
      fat: datum('g', null),
      fluid: datum('mL', null),
      sodium: datum('mg', null),
    },
    provenance: {
      kind: 'user_entered' as const,
      reference: null,
      capturedAt: '2026-10-06T00:00:00Z',
      reviewState: 'unreviewed' as const,
    },
  };
  const first = await f.intakeRepo.saveFood(f.athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    definition,
  });
  const command = await reviewed(f);
  await f.intakeRepo.saveFood(f.athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    expectedVersionId: first.versionId,
    definition: { ...definition, name: 'New unrelated food head' },
  });
  await f.consent.setConsent(f.athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const result = await createRaceManualPublicRepository(db).approve(f.athlete, command);
  expect(result.status).toBe('committed');
  if (result.status !== 'committed') throw Error('PUBLIC_APPROVAL_NOT_COMMITTED');
  expect(new Set(result.versions.map((v) => v.domain))).toEqual(
    new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
  );
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  const next = nutritionPlanVersionV4Schema.parse(
    (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
  );
  expect(next?.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
  expect(next.raceTimingPins.filter((p) => p.eventId === f.other.id)).toEqual(
    f.nutrition.raceTimingPins.filter((p) => p.eventId === f.other.id),
  );
});

it('approval fenced first commits all four domains before queued withdrawal and original replay remains readable', async () => {
  const f = await setup(),
    command = await reviewed(f),
    reached = gate(),
    release = gate();
  const held: Database = {
    ...db,
    snapshotTenant: async (athlete, operation) => {
      if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_REQUIRED');
      return db.snapshotTenant(athlete, async (tx) => {
        const result = await operation(tx);
        reached.resolve();
        await release.promise;
        return result;
      });
    },
  };
  const pending = createRaceManualPublicRepository(held).approve(f.athlete, command);
  await Promise.race([
    reached.promise,
    pending.then(() => {
      throw Error('APPROVAL_FINISHED_BEFORE_BARRIER');
    }),
  ]);
  const withdrawal = f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  try {
    await waiter();
  } finally {
    release.resolve();
  }
  const original = await pending;
  await withdrawal;
  expect(original.status).toBe('committed');
  if (original.status !== 'committed') throw Error('PUBLIC_APPROVAL_NOT_COMMITTED');
  expect(new Set(original.versions.map((v) => v.domain))).toEqual(
    new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
  );
  const before = await domainCounts(f.athlete);
  expect(
    await createRaceManualPublicRepository(db).approve(f.athlete, {
      ...command,
      idempotencyKey: randomUUID(),
    }),
  ).toEqual(original);
  expect(await domainCounts(f.athlete)).toEqual(before);
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
});
it('withdrawal fenced first denies waiting approval without any domain or original receipt writes', async () => {
  const f = await setup(),
    command = await reviewed(f),
    before = await domainCounts(f.athlete),
    reached = gate(),
    release = gate();
  const held: Database = {
    ...db,
    tenant: async (athlete, operation) =>
      db.tenant(athlete, async (tx) => {
        const result = await operation(tx);
        reached.resolve();
        await release.promise;
        return result;
      }),
  };
  const withdrawal = createConsentRepository(held).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await Promise.race([
    reached.promise,
    withdrawal.then(() => {
      throw Error('WITHDRAWAL_FINISHED_BEFORE_BARRIER');
    }),
  ]);
  const pending = createRaceManualPublicRepository(db).approve(f.athlete, command);
  const denied = expect(pending).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  try {
    await waiter();
  } finally {
    release.resolve();
  }
  await withdrawal;
  await denied;
  await unchanged(f, before);
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  await expect(createRaceManualPublicRepository(db).approve(f.athlete, command)).rejects.toThrow(
    'STALE_BASIS',
  );
  await unchanged(f, before);
});

// Owner SELECT captures actual durable records only for adversarial input. No
// private row mutation or synthetic positive context; runtime guards own checks.
async function attackInput(f: Fixture, id: string) {
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
    const row = z
      .strictObject({
        candidate: z.json(),
        basis: z.json(),
        lifecycle: z.json(),
        retained: z.json(),
      })
      .parse(
        (
          await owner.query(
            'SELECT c.candidate_json AS candidate,c.basis_json AS basis,c.lifecycle_json AS lifecycle,e.payload AS retained FROM race_manual_application_candidate_v1 c JOIN manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id WHERE c.athlete_id=$1 AND c.id=$2',
            [f.athlete, id],
          )
        ).rows[0],
      );
    await owner.query('COMMIT');
    return row;
  } finally {
    await owner.end();
  }
}
it.each(['training_recipe', 'nutrition_child_key'] as const)(
  'actual SQL118 rejects forged %s from a genuine owned candidate without writes',
  async (kind) => {
    const f = await setup(),
      command = await reviewed(f),
      input = await attackInput(f, command.candidateId),
      privateBefore = await privateCounts(f.athlete),
      before = await domainCounts(f.athlete);
    const path =
      kind === 'training_recipe'
        ? ['proposed', 'title']
        : ['intent', 'intent', 'command', 'idempotencyKey'];
    await expect(
      snapshot(f.athlete, (tx) =>
        tx.query(
          `WITH candidate AS (SELECT $1::jsonb AS c), slot AS (SELECT (ord-1)::text AS n FROM candidate CROSS JOIN LATERAL jsonb_array_elements(c->'writes') WITH ORDINALITY a(w,ord) WHERE w->>'domain'=$5) SELECT public.prepare_race_manual_application_v1(jsonb_set(c,ARRAY['writes',n]||$6::text[],to_jsonb('forged-synthetic-value'::text),false),$2::jsonb,$3::jsonb,$4::jsonb) FROM candidate CROSS JOIN slot`,
          [
            JSON.stringify(input.candidate),
            JSON.stringify(input.basis),
            JSON.stringify(input.retained),
            JSON.stringify(input.lifecycle),
            kind === 'training_recipe' ? 'training' : 'nutrition',
            path,
          ],
        ),
      ),
    ).rejects.toThrow('RACE_MANUAL_INVALID_RECIPE');
    expect(await privateCounts(f.athlete)).toEqual(privateBefore);
    await unchanged(f, before);
  },
);
it('a caller context UUID and synthetic GUC cannot authorize nutrition changed items or commit', async () => {
  const f = await setup(),
    command = await reviewed(f),
    before = await domainCounts(f.athlete),
    context = randomUUID();
  await expect(
    snapshot(f.athlete, async (tx) => {
      await tx.query("SELECT set_config('app.race_manual_application_context',$1,true)", [context]);
      await tx.query('SELECT public.race_manual_nutrition_affected_items_v1($1::uuid,$2::jsonb)', [
        context,
        JSON.stringify({ candidateId: command.candidateId }),
      ]);
    }),
  ).rejects.toThrow('RACE_MANUAL_CONTEXT_REQUIRED');
  await expect(
    snapshot(f.athlete, (tx) =>
      tx.query('SELECT public.commit_race_manual_application_v1($1::uuid,$2::jsonb)', [
        context,
        JSON.stringify({ status: 'committed' }),
      ]),
    ),
  ).rejects.toThrow('RACE_MANUAL_CONTEXT_REQUIRED');
  await unchanged(f, before);
});
