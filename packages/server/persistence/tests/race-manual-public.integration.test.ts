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
const name = `manual_public_${suffix}`,
  ownerRole = `manual_public_owner_${suffix}`,
  runtimeRole = `manual_public_app_${suffix}`;
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
async function setup() {
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
  const confirmed = await recovery.confirmStrategy(athlete, {
    strategyId: strategy.strategyId,
    expectedHeadVersionId: strategy.versionId,
    selectedOptionId: optionId,
    idempotencyKey: randomUUID(),
  });
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
 (SELECT count(*)::int FROM intake_entry WHERE athlete_id=$1) AS intake`,
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
it('reviews intent-only without plan/event/actual writes, then approves all four domains explicitly', async () => {
  const f = await setup(),
    repo = createRaceManualPublicRepository(db),
    command = reviewCommand(f),
    before = await domainCounts(f.athlete);
  const reviewed = await repo.review(f.athlete, command);
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  expect(await domainCounts(f.athlete)).toEqual(before);
  expect(await repo.review(f.athlete, command)).toEqual(reviewed);
  expect(await repo.read(f.athlete, reviewed.reference.candidateId)).toEqual({
    status: 'retained',
    reference: reviewed.reference,
    bodyState: 'present',
  });
  const approval = {
    schemaVersion: 1 as const,
    idempotencyKey: randomUUID(),
    candidateId: reviewed.reference.candidateId,
    applicationDigest: reviewed.reference.applicationDigest,
    confirmed: true as const,
  };
  const committed = await repo.approve(f.athlete, approval);
  expect(committed.status).toBe('committed');
  if (committed.status !== 'committed') throw Error('PUBLIC_APPROVAL_NOT_COMMITTED');
  expect(new Set(committed.versions.map((v) => v.domain))).toEqual(
    new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
  );
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(2);
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  expect(
    (
      await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId)
    )?.head?.items.map((i) => i.foods),
  ).toEqual(f.nutrition.items.map((i) => i.foods));
  expect(await repo.approve(f.athlete, approval)).toEqual(committed);
});
it('same review key conflicts on different intent and rejects caller basis/recipes before storing', async () => {
  const f = await setup(),
    repo = createRaceManualPublicRepository(db),
    command = reviewCommand(f);
  await repo.review(f.athlete, command);
  await expect(
    repo.review(f.athlete, {
      ...command,
      intent: { ...command.intent, newLocalDate: '2026-10-09' },
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const before = await privateCounts(f.athlete);
  for (const field of ['expectedBasis', 'privateContext', 'recipes', 'sourceFacts'])
    await expect(
      repo.review(f.athlete, { ...reviewCommand(f), [field]: { permitted: true } }),
    ).rejects.toThrow();
  expect(await privateCounts(f.athlete)).toEqual(before);
});
it('successful review replays after app withdrawal but fresh review processing is denied', async () => {
  const f = await setup(),
    repo = createRaceManualPublicRepository(db),
    command = reviewCommand(f),
    original = await repo.review(f.athlete, command);
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.review(f.athlete, command)).toEqual(original);
  await expect(repo.review(f.athlete, reviewCommand(f))).rejects.toMatchObject({
    code: 'APP_CONSENT_REQUIRED',
  });
});
it('genuine deletion purges copied candidate body; successful review and approval aliases remain minimal and never resurrect it', async () => {
  const f = await setup(),
    repo = createRaceManualPublicRepository(db),
    command = reviewCommand(f),
    reviewed = await repo.review(f.athlete, command);
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  const second = await repo.review(f.athlete, reviewCommand(f));
  if (second.status !== 'reviewed') throw Error('SECOND_PUBLIC_REVIEW_NOT_READY');
  const approval = {
    schemaVersion: 1 as const,
    idempotencyKey: randomUUID(),
    candidateId: reviewed.reference.candidateId,
    applicationDigest: reviewed.reference.applicationDigest,
    confirmed: true as const,
  };
  const committed = await repo.approve(f.athlete, approval);
  if (committed.status !== 'committed') throw Error('PUBLIC_APPROVAL_NOT_COMMITTED');
  await f.races.deleteRaceEvent(f.athlete, f.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: committed.race.revision,
  });
  expect(await repo.read(f.athlete, reviewed.reference.candidateId)).toEqual({
    status: 'retained',
    reference: reviewed.reference,
    bodyState: 'purged',
  });
  expect(await repo.review(f.athlete, command)).toEqual({ ...reviewed, bodyState: 'purged' });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const alias = { ...approval, idempotencyKey: randomUUID() };
  expect(await repo.approve(f.athlete, alias)).toEqual(committed);
  await expect(
    repo.approve(f.athlete, { ...alias, applicationDigest: 'f'.repeat(64) }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(
    repo.approve(f.athlete, {
      ...alias,
      candidateId: second.reference.candidateId,
      applicationDigest: second.reference.applicationDigest,
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(
    (
      await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId)
    )?.head?.items.find((i) => i.id === 'meal-0')?.anchor,
  ).toEqual({ kind: 'disconnected', entity: 'race' });
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  expect((await repo.read(f.athlete, reviewed.reference.candidateId))?.bodyState).toBe('purged');
});
it('concurrent review key creates one actual chain/candidate and different approval keys apply once', async () => {
  const f = await setup(),
    repo = createRaceManualPublicRepository(db),
    command = reviewCommand(f);
  const [a, b] = await Promise.all([
    repo.review(f.athlete, command),
    repo.review(f.athlete, command),
  ]);
  expect(b).toEqual(a);
  if (a.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  expect(await privateCounts(f.athlete)).toEqual([{ evidence: 1, candidates: 1 }]);
  const approval = {
    schemaVersion: 1 as const,
    candidateId: a.reference.candidateId,
    applicationDigest: a.reference.applicationDigest,
    confirmed: true as const,
  };
  const results = await Promise.all([
    repo.approve(f.athlete, { ...approval, idempotencyKey: randomUUID() }),
    repo.approve(f.athlete, { ...approval, idempotencyKey: randomUUID() }),
  ]);
  expect(results[1]).toEqual(results[0]);
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(2);
});
it('foreign candidate and stale original intent cannot create an approval or new review chain', async () => {
  const f = await setup(),
    other = await setup(),
    repo = createRaceManualPublicRepository(db),
    reviewed = await repo.review(f.athlete, reviewCommand(f));
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
  expect(await repo.read(other.athlete, reviewed.reference.candidateId)).toBeNull();
  await expect(
    repo.approve(other.athlete, {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      candidateId: reviewed.reference.candidateId,
      applicationDigest: reviewed.reference.applicationDigest,
      confirmed: true,
    }),
  ).rejects.toThrow('PUBLIC_APPLICATION_UNAVAILABLE');
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  await expect(
    repo.approve(f.athlete, {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      candidateId: reviewed.reference.candidateId,
      applicationDigest: reviewed.reference.applicationDigest,
      confirmed: true,
    }),
  ).rejects.toThrow('STALE_BASIS');
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
});
it('failure between actual chain and candidate rolls back orphan artifacts and permits same-key retry', async () => {
  const f = await setup(),
    command = reviewCommand(f),
    before = await privateCounts(f.athlete);
  let calls = 0;
  const failing = createRaceManualPublicRepository(db, {
    createId: () => {
      if (++calls === 4) throw Error('SYNTHETIC_PUBLIC_CANDIDATE_FAILURE');
      return randomUUID();
    },
  });
  await expect(failing.review(f.athlete, command)).rejects.toThrow(
    'SYNTHETIC_PUBLIC_CANDIDATE_FAILURE',
  );
  expect(await privateCounts(f.athlete)).toEqual(before);
  expect((await createRaceManualPublicRepository(db).review(f.athlete, command)).status).toBe(
    'reviewed',
  );
});

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
it('review fenced first commits before queued withdrawal and its successful reference replays afterwards', async () => {
  const f = await setup(),
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
  const command = reviewCommand(f),
    pending = createRaceManualPublicRepository(held).review(f.athlete, command);
  await Promise.race([
    reached.promise,
    pending.then(() => {
      throw Error('PUBLIC_REVIEW_FINISHED_BEFORE_BARRIER');
    }),
  ]);
  const withdrawn = f.consent.setConsent(f.athlete, {
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
  await withdrawn;
  expect(original.status).toBe('reviewed');
  expect(await createRaceManualPublicRepository(db).review(f.athlete, command)).toEqual(original);
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
});
it('withdrawal fenced first is visible to waiting review and creates no chain or candidate', async () => {
  const f = await setup(),
    reached = gate(),
    release = gate(),
    before = await privateCounts(f.athlete);
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
  const withdrawn = createConsentRepository(held).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await Promise.race([
    reached.promise,
    withdrawn.then(() => {
      throw Error('PUBLIC_WITHDRAWAL_FINISHED_BEFORE_BARRIER');
    }),
  ]);
  const pending = createRaceManualPublicRepository(db).review(f.athlete, reviewCommand(f));
  const denial = expect(pending).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  try {
    await waiter();
  } finally {
    release.resolve();
  }
  await withdrawn;
  await denial;
  expect(await privateCounts(f.athlete)).toEqual(before);
});
