import { createRaceManualReviewFullOwnedBindingV2Service } from '../src/race-manual-review-full-owned-binding-consumer-v2.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { currentRestoreGeneration } from '../src/restore-generation.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import {
  approveRaceManualApplicationIn,
  createRaceManualApprovalRepository,
} from '../src/race-manual-approval.js';
import { raceManualApprovalCommandSchema } from '@workout/contracts/race-manual-approval';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
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
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `atomic_approval_${suffix}`,
  ownerRole = `atomic_approval_owner_${suffix}`,
  runtimeRole = `atomic_approval_app_${suffix}`;
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
    const after = (
      await migrationOwner.query(
        "SELECT proowner::text,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0];
    expect(after).toEqual(before);
    for (const signature of [
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
  const observed = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
  if (observed.status !== 'current_dependencies_captured') {
    const codes: Record<string, string> = {};
    const inspect = (value: unknown, path: string, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const record = z.record(z.string(), z.unknown()).parse(value);
      for (const key of [
        'status',
        'reason',
        'code',
        'bindingStatus',
        'preparationStatus',
        'originalStage',
        'originalReason',
      ]) {
        const code = record[key];
        if (typeof code === 'string' && /^[a-z_]{1,128}$/.test(code))
          codes[`${path}.${key}`] = code;
      }
      for (const key of [
        'prepared',
        'preparation',
        'retained',
        'candidate',
        'consumedScope',
        'binding',
      ])
        inspect(record[key], `${path}.${key}`, depth + 1);
    };
    inspect(observed, 'basis', 0);
    const binding = await createRaceManualReviewFullOwnedBindingV2Service(db).prepare(
      athlete,
      intent,
    );
    if ('sqlObservation' in binding) {
      const facts = binding.sqlObservation.rows.filter((row) => row.state !== 'observed');
      const dtoFacts = binding.owned.facts.filter((row) => row.state !== 'matched');
      for (const [index, fact] of facts.entries())
        codes[`sql.${index}.${fact.identity.kind}`] = fact.reason ?? 'unknown';
      for (const [index, fact] of dtoFacts.entries())
        codes[`dto.${index}.${fact.identity.kind}`] = fact.reason ?? 'unknown';
      for (const [index, blocker] of binding.inventory.blockers.entries()) {
        codes[`inventory.blocker.${index}`] = blocker.reason;
        codes[`inventory.path.${index}`] = blocker.location.replace(
          /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi,
          '[id]',
        );
      }
      codes['inventory.state'] = binding.inventory.inventoryState;
      codes['inventory.copies'] = String(binding.inventory.allCopiedBodiesIndexed);
      codes['dto.status'] = binding.owned.status;
    }
    throw Error(`ACTUAL_BASIS_UNAVAILABLE:${JSON.stringify(codes)}`);
  }
  const chain = await createRaceManualReviewChainV2Repository(db).store(athlete, {
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    intent,
    expectedBasis: observed.basis,
  });
  if (chain.status !== 'stored') throw Error('ACTUAL_CHAIN_UNAVAILABLE');
  const repo = createRaceManualApprovalRepository(db);
  const application = await repo
    .prepare(athlete, {
      schemaVersion: 1,
      chain: {
        evidenceId: chain.result.evidenceId,
        decisionId: chain.result.decisionId,
        proposalId: chain.result.proposalId,
        readonlyCandidateDigest: chain.result.candidateDigest,
      },
      intent,
      expectedBasis: observed.basis,
    })
    .catch((error: unknown) => {
      const diagnostic = z
        .object({ code: z.string().optional(), where: z.string().optional() })
        .safeParse(error);
      if (diagnostic.success) {
        const frames = [
          ...(diagnostic.data.where ?? '').matchAll(
            /PL\/pgSQL function ([a-z0-9_.]+)\([^\n]*?\) line (\d+)/g,
          ),
        ].map((match) => ({ function: match[1], line: match[2] }));
        console.error(
          'BOUNDED_SQL_DIAGNOSTIC',
          JSON.stringify({ code: diagnostic.data.code, frames }),
        );
      }
      throw error;
    });
  if (application.status !== 'prepared') throw Error('APPLICATION_NOT_READY');
  const candidate = application.candidate;
  if (candidate.applicationState !== 'ready_for_explicit_approval')
    throw Error('APPLICATION_BLOCKED');
  const command = raceManualApprovalCommandSchema.parse({
    schemaVersion: 1,
    confirmed: true,
    idempotencyKey: randomUUID(),
    candidateId: candidate.candidateId,
    applicationDigest: candidate.applicationDigest,
    chain: candidate.chain,
    raceChange: candidate.raceChange,
    expectation: candidate.expectation,
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
    repo,
    candidate,
    command,
  };
}
it('applies actual public all-four recipes plus linked race atomically, preserves old pin and original receipts', async () => {
  const f = await setup();
  expect(f.candidate.writes.map((w) => w.domain)).toEqual([
    'nutrition',
    'recovery',
    'routine_schedule',
    'training',
  ]);
  const committed = await f.repo.approve(f.athlete, f.command);
  expect(committed.status).toBe('committed');
  if (committed.status !== 'committed') throw Error('NOT_COMMITTED');
  expect(committed.versions).toHaveLength(4);
  const latest = (await f.planning.read(f.athlete)).head;
  expect(latest?.draft.sessions[0]?.date).toBe('2026-10-08');
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.planVersionId).toBe(latest?.id);
  const next = await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId);
  expect(next?.schemaVersion).toBe(4);
  expect(next?.head?.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
  const saved = nutritionPlanVersionV4Schema.parse(next?.head);
  const unchanged = saved.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1');
  const oldBinding = f.nutrition.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1');
  expect(unchanged).toEqual(oldBinding);
  expect(saved.itemRaceTimingBindings.find((b) => b.itemId === 'meal-0')?.binding).toMatchObject({
    state: 'captured',
    eventRevision: 2,
  });
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  expect(await f.repo.approve(f.athlete, f.command)).toEqual(committed);
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await f.repo.approve(f.athlete, { ...f.command, idempotencyKey: randomUUID() })).toEqual(
    committed,
  );
});
it('stale app revision fails without race or any domain mutation', async () => {
  const f = await setup();
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(f.repo.approve(f.athlete, f.command)).rejects.toBeDefined();
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
  expect((await f.planning.read(f.athlete)).head?.id).toBe(f.plan.id);
  expect(
    (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
  ).toEqual(f.nutrition);
});

it('standalone V4 RC writes retain old SQL110 behavior when no actual application context exists', async () => {
  const f = await setup(),
    prior = f.nutrition;
  const draft = {
    period: prior.period,
    timezone: prior.timezone,
    purpose: prior.purpose,
    linkedTrainingPlanVersionId: prior.linkedTrainingPlanVersionId,
    items: prior.items.map(({ planVersionId, ...item }) => {
      void planVersionId;
      return item;
    }),
  };
  const result = await createNutritionRacePlanV4Writer(db).savePlanV4(f.athlete, {
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: prior.planId,
        expectedHeadVersionId: prior.versionId,
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft,
      },
      expectedRaceHeads: [
        { namespace: 'race-event', eventId: f.event.id, revision: 1 },
        { namespace: 'race-event', eventId: f.other.id, revision: 2 },
      ].sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)),
      reconnectItemIds: [],
    },
  });
  expect(nutritionPlanVersionV4Schema.parse(result.plan).itemRaceTimingBindings).toEqual(
    prior.itemRaceTimingBindings,
  );
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
});
it('genuine race deletion after approval disconnects only race timing, preserves intake and receipt without resurrection', async () => {
  const f = await setup(),
    committed = await f.repo.approve(f.athlete, f.command);
  if (committed.status !== 'committed') throw Error('NOT_COMMITTED');
  await f.races.deleteRaceEvent(f.athlete, f.event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: committed.race.revision,
  });
  const read = await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId);
  expect(read?.head?.items.find((i) => i.id === 'meal-0')?.anchor).toEqual({
    kind: 'disconnected',
    entity: 'race',
  });
  expect(read?.head?.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
  expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  expect(await f.repo.approve(f.athlete, f.command)).toEqual(committed);
  expect(await f.races.getRaceEvent(f.athlete, f.event.id)).toBeNull();
});

for (const failureAt of [2, 4, 5])
  it(`rolls all affected writes back when injected write ID production fails at ${failureAt}`, async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_REQUIRED');
    let ids = 0;
    await expect(
      db.snapshotTenant(f.athlete, (tx) =>
        approveRaceManualApplicationIn(
          tx,
          f.command,
          { bytes: 0n, sources: 0 },
          {
            createId: () => {
              ids++;
              if (ids === failureAt) throw Error('SYNTHETIC_WRITE_FAILURE');
              return randomUUID();
            },
          },
        ),
      ),
    ).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
    expect((await f.planning.read(f.athlete)).head?.id).toBe(f.plan.id);
    expect(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    ).toEqual(f.nutrition);
    expect((await f.recovery.readStrategy(f.athlete, f.confirmed.strategyId))?.versionId).toBe(
      f.confirmed.versionId,
    );
    expect(
      (await f.routine.readSchedule(f.athlete, f.approved.schedule.id))?.schedule.versionId,
    ).toBe(f.approved.schedule.versionId);
    expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
    // A failed transaction leaves neither child receipts nor an active private
    // context. The same original public command can then commit once normally.
    expect((await f.repo.approve(f.athlete, f.command)).status).toBe('committed');
  });
it('concurrent distinct outer receipt keys apply one candidate once and return the original approval identity', async () => {
  const f = await setup();
  const results = await Promise.all([
    f.repo.approve(f.athlete, f.command),
    f.repo.approve(f.athlete, { ...f.command, idempotencyKey: randomUUID() }),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(2);
  expect((await f.planning.read(f.athlete)).head?.version).toBe(f.plan.version + 1);
});
