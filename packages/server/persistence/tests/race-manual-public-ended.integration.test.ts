import { routineOccurrenceSchema } from '@workout/contracts/routines';
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
const name = `manual_ended_${suffix}`,
  ownerRole = `manual_ended_owner_${suffix}`,
  runtimeRole = `manual_ended_app_${suffix}`;
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
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/124_race_manual_public_preview_source.sql', import.meta.url),
        'utf8',
      ),
    );
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/126_manual_race_checklist_uuid_comparison.sql', import.meta.url),
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
      'public.read_race_manual_public_preview_source_v1(uuid)',
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
async function setup(options: { firstItemId?: string; unresolvedSession?: boolean } = {}) {
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
        localStartTime: options.unresolvedSession ? null : '08:00',
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
            id: index === 0 ? (options.firstItemId ?? `meal-${index}`) : `meal-${index}`,
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
        localTime: null,
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

// Public approveSchedule stores unresolved planned timing without inventing an
// instant. Public changeSchedule end then preserves those original occurrences.
// This source evidence is prepared only; Root runs actual PG. No owner body seed.
async function endedFixture() {
  const f = await setup(),
    schedule = await f.routine.readSchedule(f.athlete, f.approved.schedule.id);
  if (!schedule) throw Error('SYNTHETIC_SCHEDULE_MISSING');
  expect(schedule.occurrences.length).toBeGreaterThan(0);
  expect(
    schedule.occurrences.every((o) => o.scheduledAt === null && o.timingStatus === 'unresolved'),
  ).toBe(true);
  // An explicit unplanned run isolates run/actual preservation from the separate
  // active historical planned-started unresolved policy not assigned here.
  const started = await f.routine.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: schedule.schedule.blueprint.versionId,
    occurrenceId: null,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const recorded = await f.routine.recordStep(f.athlete, {
    runId: started.run.id,
    stepId: 'step',
    state: 'performed',
    actualRefs: [],
    occurredAt: '2026-10-01T08:00:00Z',
    reason: null,
    expectedRevision: started.run.revision,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  expect(recorded.run.progress[0]?.actualRefs[0]?.kind).toBe('checklist_confirmation');
  const stopped = await f.routine.changeRun(f.athlete, {
    runId: recorded.run.id,
    action: 'end',
    expectedRevision: recorded.run.revision,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const endCommand = {
    scheduleId: schedule.schedule.id,
    action: 'end' as const,
    expectedVersionId: schedule.schedule.versionId,
    previewDigest: schedule.impactDigest,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  const ended = await f.routine.changeSchedule(f.athlete, endCommand);
  expect(await f.routine.changeSchedule(f.athlete, endCommand)).toEqual(ended);
  expect(ended.schedule.state).toBe('ended');
  expect(ended.schedule.versionId).not.toBe(schedule.schedule.versionId);
  // The new ended head has no newly minted occurrences; old immutable rows
  // remain attached to the original approved schedule version.
  expect(ended.occurrences).toEqual([]);
  const originalOccurrences = await db.tenant(f.athlete, async (tx) =>
    routineOccurrenceSchema
      .array()
      .parse(
        (
          await tx.query(
            'SELECT record_json FROM routine_occurrence WHERE athlete_id=$1 AND schedule_version_id=$2 ORDER BY scheduled_at NULLS LAST,anchor_key,id',
            [f.athlete, schedule.schedule.versionId],
          )
        ).rows.map((row) => row['record_json']),
      ),
  );
  expect(originalOccurrences).toEqual(schedule.occurrences);
  return { ...f, originalSchedule: schedule, ended, stopped };
}
async function frozenRows(athlete: string) {
  return db.tenant(athlete, async (tx) => {
    // Digests avoid printing fixture actual bodies or metadata on a failed
    // equality assertion. Exact SQL source rows including timestamps are covered.
    const facts = [];
    for (const relation of [
      'routine_schedule_head',
      'routine_schedule_version',
      'routine_occurrence',
      'routine_run',
      'routine_run_revision',
      'routine_checklist_confirmation',
      'intake_entry',
    ]) {
      const rows = (
        await tx.query(
          `SELECT count(*)::int AS count,
        encode(pg_catalog.sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS digest
        FROM ${relation} t WHERE athlete_id=$1`,
          [athlete],
        )
      ).rows;
      facts.push({ relation, rows });
    }
    return facts;
  });
}
it('genuine ended unresolved public schedule retains original rows/runs/actuals while other domains approve and replay', async () => {
  const f = await endedFixture(),
    repo = createRaceManualPublicRepository(db),
    before = await frozenRows(f.athlete);
  const impact = await repo.impact(f.athlete, { schemaVersion: 1, intent: f.intent });
  expect(impact.status).toBe('projected');
  if (impact.status !== 'projected' || impact.routines.state !== 'present')
    throw Error('PUBLIC_ENDED_IMPACT_UNAVAILABLE');
  const member = impact.routines.members.find((m) => m.aggregateId === f.ended.schedule.id);
  expect(member).toMatchObject({
    state: 'retained_ended',
    requirement: 'none',
    resolution: 'absent',
  });
  expect(member?.after).toEqual(member?.before);
  expect(impact.affected).not.toContainEqual({
    domain: 'routine_schedule',
    aggregateId: f.ended.schedule.id,
  });
  expect(impact.retainedUnplanned).toContainEqual({
    runId: f.stopped.run.id,
    blueprintVersionId: f.stopped.run.blueprint.versionId,
    preservation: 'unplanned_run_unchanged',
  });
  const reviewed = await repo.review(f.athlete, {
    schemaVersion: 1,
    idempotencyKey: randomUUID(),
    intent: f.intent,
  });
  expect(reviewed.status).toBe('reviewed');
  if (reviewed.status !== 'reviewed') throw Error('PUBLIC_ENDED_REVIEW_UNAVAILABLE');
  const command = {
    schemaVersion: 1,
    idempotencyKey: randomUUID(),
    candidateId: reviewed.reference.candidateId,
    applicationDigest: reviewed.reference.applicationDigest,
    confirmed: true,
  };
  const approved = await repo.approve(f.athlete, command);
  expect(approved.status).toBe('committed');
  expect(await repo.approve(f.athlete, command)).toEqual(approved);
  expect(await frozenRows(f.athlete)).toEqual(before);
  const race = await f.races.getRaceEvent(f.athlete, f.event.id);
  expect(race).toMatchObject({ revision: f.event.revision + 1, localDate: f.intent.newLocalDate });
  const training = await f.planning.read(f.athlete);
  expect(training.head?.id).not.toBe(f.plan.id);
  const nutrition = await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId);
  expect(nutrition?.head?.versionId).not.toBe(f.nutrition.versionId);
});
it('public ended resolution stays unsupported without changing frozen records or minting a review', async () => {
  const f = await endedFixture(),
    repo = createRaceManualPublicRepository(db),
    before = await frozenRows(f.athlete);
  const intent = {
    ...f.intent,
    resolutions: {
      nutrition: [],
      routines: [
        {
          scheduleVersionId: f.ended.schedule.versionId,
          action: 'replace_rule',
          rule: f.ended.schedule.rule,
          window: f.ended.schedule.window,
          sourcePlanVersionId: f.ended.sourcePlanVersionId,
        },
      ],
    },
  };
  expect((await repo.impact(f.athlete, { schemaVersion: 1, intent })).status).toBe('blocked');
  expect(
    (await repo.review(f.athlete, { schemaVersion: 1, idempotencyKey: randomUUID(), intent }))
      .status,
  ).toBe('blocked');
  expect(await frozenRows(f.athlete)).toEqual(before);
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(f.event.revision);
});
it('ended state keeps public schedule CAS and fresh race revision checks', async () => {
  const f = await endedFixture(),
    before = await frozenRows(f.athlete);
  await expect(
    f.routine.changeSchedule(f.athlete, {
      scheduleId: f.ended.schedule.id,
      action: 'end',
      expectedVersionId: f.originalSchedule.schedule.versionId,
      previewDigest: f.originalSchedule.impactDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow('STALE_SCHEDULE');
  await expect(
    createRaceManualPublicRepository(db).impact(f.athlete, {
      schemaVersion: 1,
      intent: { ...f.intent, expectedEvent: { id: f.event.id, revision: f.event.revision + 1 } },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await frozenRows(f.athlete)).toEqual(before);
});
