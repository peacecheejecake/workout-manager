import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { captureRaceManualReviewCompatibleLifecycleInventoryIn } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { storeRaceManualPooledChainTransportV1In } from '../src/race-manual-pooled-chain-transport-v1.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { createRaceManualReviewFullOwnedBindingV2Service } from '../src/race-manual-review-full-owned-binding-consumer-v2.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { currentRestoreGeneration } from '../src/restore-generation.js';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import {
  approveRaceManualApplicationIn,
  prepareRaceManualApprovalIn,
  prepareRaceManualPooledApprovalIn,
  approveRaceManualPooledApplicationIn,
  createRaceManualApprovalRepository,
} from '../src/race-manual-approval.js';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalNutritionKey,
  raceManualApprovalCommandSchema,
} from '@workout/contracts/race-manual-approval';
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
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import { grantCurrentRuntimeV5Profile } from '../src/current-runtime-grants-v5.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_application_${suffix}`,
  ownerRole = `pooled_application_owner_${suffix}`,
  runtimeRole = `pooled_application_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let pending: Promise<void> = Promise.resolve();
function fixtureIt(label: string, apply: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(apply);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    60000,
  );
}

let created = false,
  db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
const appRecipe = [
  baseline.grantIdentityFunctions,
  baseline.grantAiSettings,
  baseline.grantOperations,
  baseline.grantNutritionCore,
  baseline.grantSupplementaryCore,
  baseline.grantRoutineCore,
  baseline.grantStretchingCore,
  baseline.grantRecoveryCore,
  baseline.grantCheckIns,
  baseline.grantSessionCompletions,
  baseline.grantPlanScenarios,
  baseline.grantCoachingConstraints,
  baseline.grantCoachingThreads,
  baseline.grantCoreEvidenceSnapshots,
  baseline.grantCoachingRuns,
  baseline.grantCoachingCandidates,
  baseline.grantIntegratedApprovalV4,
  baseline.grantResources,
  baseline.grantResourceRetrieval,
  baseline.grantGalleryMedia,
  baseline.grantActivityTracks,
  baseline.grantCourses,
  baseline.grantRaces,
  baseline.grantCorePlanning,
  baseline.grantGarmin,
  baseline.grantGarminUnofficial,
];
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await baseline.migrate(url(ownerRole), 107);
  await installCurrentRuntimeV5(url(ownerRole));
  for (const grant of appRecipe) await grant(url(ownerRole), runtimeRole);
  await grantCurrentRuntimeV5Profile(url(ownerRole), runtimeRole);
  const migrationOwner = new Pool({ connectionString: url(ownerRole) });
  const originalQuery = `SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid IN (
    'public.race_manual_relative_membership_v1(jsonb)'::regprocedure,
    'public.race_manual_routine_expansion_v1(jsonb,jsonb,jsonb,text)'::regprocedure,
    'public.race_manual_application_validate_recipes_v1(jsonb,jsonb)'::regprocedure,
    'public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)'::regprocedure,
    'public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)'::regprocedure)`;
  try {
    const before = (await migrationOwner.query(originalQuery)).rows[0]?.['value'];
    for (const file of [
      '134_manual_pooled_preparation_resolver.sql',
      '135_manual_pooled_store_and_basis.sql',
      '136_manual_pooled_chain_reader_and_ack.sql',
      '137_manual_pooled_application.sql',
    ])
      await migrationOwner.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    expect((await migrationOwner.query(originalQuery)).rows[0]?.['value']).toEqual(before);
    for (const signature of [
      'public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_pooled_chain_v1(uuid)',
      'public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
    ])
      await migrationOwner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    expect(
      (await migrationOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await migrationOwner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
}, 180000);
afterAll(async () => {
  await pending;
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
  const application = await snapshot(athlete, (tx) =>
    prepareRaceManualApprovalIn(successorTx(tx), {
      schemaVersion: 1,
      chain: {
        evidenceId: chain.result.evidenceId,
        decisionId: chain.result.decisionId,
        proposalId: chain.result.proposalId,
        readonlyCandidateDigest: chain.result.candidateDigest,
      },
      intent,
      expectedBasis: observed.basis,
    }),
  ).catch((error: unknown) => {
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
    intent,
  };
}

// Only the exact old RPC call is redirected to the named successor, retaining
// the actual transaction, measured response, and all existing Node write logic.
// This is a fixture adapter, not public activation or an authority witness.
function successorTx(tx: Transaction): Transaction {
  return {
    athleteId: tx.athleteId,
    query: async (sql, values) => {
      if (
        sql.includes('public.begin_race_manual_application_v1(') ||
        sql.includes('public.prepare_race_manual_application_v1(')
      ) {
        if (!values || typeof values[2] !== 'string') throw Error('EXACT_RPC_REQUIRED');
        const next = [...values];
        next[2] = JSON.stringify(toDatabase(encode(JSON.parse(values[2]))));
        return tx.query(
          sql
            .replace(
              'public.begin_race_manual_application_v1(',
              'public.begin_race_manual_pooled_application_v1(',
            )
            .replace(
              'public.prepare_race_manual_application_v1(',
              'public.prepare_race_manual_pooled_application_v1(',
            ),
          next,
        );
      }
      return tx.query(sql, values);
    },
  };
}
async function snapshot<T>(athlete: string, action: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, action);
}
async function pooled(f: Awaited<ReturnType<typeof setup>>, tx: Transaction) {
  const budget = { bytes: 0n, sources: 0 };
  const current = await prepareRaceManualSemanticBasisV2In(tx, f.intent, null, budget);
  if (current.status !== 'current_dependencies_captured') throw Error('ACTUAL_CURRENT_UNAVAILABLE');
  const logical = current.prepared.retained;
  const lifecycle = await captureRaceManualReviewCompatibleLifecycleInventoryIn(
    tx,
    logical,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence') throw Error('ACTUAL_LIFECYCLE_UNAVAILABLE');
  const parent = await storeRaceManualPooledChainTransportV1In(
    tx,
    {
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      intent: f.intent,
      expectedBasis: current.basis,
    },
    logical,
    current.basis,
    lifecycle,
    budget,
  );
  const candidateId = randomUUID();
  const { applicationDigest: _digest, ...old } = f.candidate;
  void _digest;
  const unsigned = {
    ...old,
    candidateId,
    chain: {
      evidenceId: parent.result.evidenceId,
      decisionId: parent.result.decisionId,
      proposalId: parent.result.proposalId,
      readonlyCandidateDigest: parent.result.candidateDigest,
    },
    writes: old.writes.map((w) =>
      w.domain === 'nutrition'
        ? {
            ...w,
            intent: {
              ...w.intent,
              intent: {
                ...w.intent.intent,
                command: {
                  ...w.intent.intent.command,
                  idempotencyKey: raceManualApprovalNutritionKey(candidateId, w.aggregateId),
                },
              },
            },
          }
        : w,
    ),
  };
  const candidate = raceManualApprovalCandidateSchema.parse({
    ...unsigned,
    applicationDigest: impactDependencyDigest(unsigned),
  });
  if (candidate.applicationState !== 'ready_for_explicit_approval')
    throw Error('APPLICATION_NOT_READY');
  return { candidate, current, lifecycle, wire: toDatabase(encode(logical)), parent };
}
async function prepare(
  tx: Transaction,
  p: Awaited<ReturnType<typeof pooled>>,
  candidate: unknown = p.candidate,
  wire: unknown = p.wire,
) {
  return (
    await tx.query(
      'SELECT public.prepare_race_manual_pooled_application_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) AS value',
      [
        JSON.stringify(candidate),
        JSON.stringify(p.current.basis),
        JSON.stringify(wire),
        JSON.stringify(p.lifecycle),
      ],
    )
  ).rows[0]?.['value'];
}
function command(p: Awaited<ReturnType<typeof pooled>>) {
  return raceManualApprovalCommandSchema.parse({
    schemaVersion: 1,
    confirmed: true,
    idempotencyKey: randomUUID(),
    candidateId: p.candidate.candidateId,
    applicationDigest: p.candidate.applicationDigest,
    chain: p.candidate.chain,
    raceChange: p.candidate.raceChange,
    expectation: p.candidate.expectation,
  });
}
async function begin(
  tx: Transaction,
  p: Awaited<ReturnType<typeof pooled>>,
  raw: unknown = command(p),
) {
  return (
    await tx.query(
      'SELECT public.begin_race_manual_pooled_application_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) AS value',
      [
        JSON.stringify(raw),
        JSON.stringify(p.current.basis),
        JSON.stringify(p.wire),
        JSON.stringify(p.lifecycle),
      ],
    )
  ).rows[0]?.['value'];
}
fixtureIt(
  'genuine all-four copied pooled parent prepares and begins with exact actual parent correspondence; rollback leaves plans/event unchanged',
  async () => {
    const f = await setup();
    await expect(
      snapshot(f.athlete, async (tx) => {
        const p = await pooled(f, tx);
        expect(p.candidate.writes.map((w) => w.domain)).toEqual([
          'nutrition',
          'recovery',
          'routine_schedule',
          'training',
        ]);
        expect(await prepare(tx, p)).toEqual(p.candidate);
        expect(z.uuid().safeParse(await begin(tx, p)).success).toBe(true);
        throw Error('INTENTIONAL_ATOMIC_ROLLBACK');
      }),
    ).rejects.toThrow('INTENTIONAL_ATOMIC_ROLLBACK');
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
    expect((await f.planning.read(f.athlete)).head?.id).toBe(f.plan.id);
    expect(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    ).toEqual(f.nutrition);
    expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
  },
);
fixtureIt(
  'legacy immutable parent remains readable and fresh encoded begin drives actual four writes once',
  async () => {
    const f = await setup();
    const result = await snapshot(f.athlete, (tx) =>
      approveRaceManualApplicationIn(successorTx(tx), f.command),
    );
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw Error('NOT_COMMITTED');
    expect(result.versions).toHaveLength(4);
    expect((await f.planning.read(f.athlete)).head?.draft.sessions[0]?.date).toBe('2026-10-08');
    const next = nutritionPlanVersionV4Schema.parse(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    );
    expect(next.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
    expect(next.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1')).toEqual(
      f.nutrition.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1'),
    );
    expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
    expect(
      await snapshot(f.athlete, (tx) => approveRaceManualApplicationIn(successorTx(tx), f.command)),
    ).toEqual(result);
  },
);
fixtureIt(
  'named pooled caller prepares and actually commits all four domains from genuine135 parent without JSON authority',
  async () => {
    const f = await setup();
    const p = await snapshot(f.athlete, (tx) => pooled(f, tx));
    const ready = await snapshot(f.athlete, (tx) =>
      prepareRaceManualPooledApprovalIn(tx, {
        schemaVersion: 1,
        chain: p.candidate.chain,
        intent: f.intent,
        expectedBasis: p.current.basis,
      }),
    );
    if (
      ready.status !== 'prepared' ||
      ready.candidate.applicationState !== 'ready_for_explicit_approval'
    )
      throw Error('APPLICATION_NOT_READY');
    const candidate = ready.candidate;
    const approvedCommand = raceManualApprovalCommandSchema.parse({
      schemaVersion: 1,
      confirmed: true,
      idempotencyKey: randomUUID(),
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      raceChange: candidate.raceChange,
      expectation: candidate.expectation,
    });
    const result = await snapshot(f.athlete, (tx) =>
      approveRaceManualPooledApplicationIn(tx, approvedCommand),
    );
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw Error('NOT_COMMITTED');
    expect(result.versions).toHaveLength(4);
    const latest = (await f.planning.read(f.athlete)).head;
    expect(latest?.draft.sessions[0]?.date).toBe('2026-10-08');
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.planVersionId).toBe(latest?.id);
    const next = nutritionPlanVersionV4Schema.parse(
      (await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutrition.planId))?.head,
    );
    expect(next.items.map((i) => i.foods)).toEqual(f.nutrition.items.map((i) => i.foods));
    expect(next.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1')).toEqual(
      f.nutrition.itemRaceTimingBindings.find((b) => b.itemId === 'meal-1'),
    );
    expect(await f.intakeRepo.readIntake(f.athlete, f.intake.intakeId)).toEqual(f.intake);
    expect(
      await snapshot(f.athlete, (tx) => approveRaceManualPooledApplicationIn(tx, approvedCommand)),
    ).toEqual(result);
    await f.consent.setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      await snapshot(f.athlete, (tx) =>
        approveRaceManualPooledApplicationIn(tx, {
          ...approvedCommand,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toEqual(result);
  },
);
fixtureIt('pooled malformed discriminator fails without falling back to legacy', async () => {
  const f = await setup();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await pooled(f, tx);
      const wire = structuredClone(p.wire);
      const malformed = {
        ...wire,
        payload: {
          ...wire.payload,
          preparation: { ...wire.payload.preparation, encodingVersion: 2 },
        },
      };
      await prepare(tx, p, p.candidate, malformed);
    }),
  ).rejects.toThrow();
  expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
});
fixtureIt('forged recipe with unchanged digest cannot mint a pooled application', async () => {
  const f = await setup();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await pooled(f, tx);
      const candidate = structuredClone(p.candidate);
      candidate.writes = [];
      await prepare(tx, p, candidate);
    }),
  ).rejects.toThrow();
});
fixtureIt(
  'SQL recipes reject a forged nutrition child receipt key even with a recomputed candidate digest',
  async () => {
    const f = await setup();
    await expect(
      snapshot(f.athlete, async (tx) => {
        const p = await pooled(f, tx);
        const candidate = structuredClone(p.candidate);
        const nutrition = candidate.writes.find((w) => w.domain === 'nutrition');
        if (!nutrition || nutrition.domain !== 'nutrition') throw Error('NUTRITION_REQUIRED');
        nutrition.intent.intent.command.idempotencyKey = 'forged-child-key';
        const { applicationDigest: _digest, ...unsigned } = candidate;
        void _digest;
        await prepare(tx, p, { ...unsigned, applicationDigest: impactDependencyDigest(unsigned) });
      }),
    ).rejects.toThrow();
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
  },
);
fixtureIt(
  'pooled begin refuses foreign immutable chain tuple and leaves event untouched',
  async () => {
    const f = await setup();
    await expect(
      snapshot(f.athlete, async (tx) => {
        const p = await pooled(f, tx);
        await prepare(tx, p);
        const c = command(p);
        await begin(tx, p, { ...c, chain: { ...c.chain, decisionId: randomUUID() } });
      }),
    ).rejects.toThrow();
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
  },
);
fixtureIt(
  'actual app withdrawal rejects a new pooled begin and retains previously frozen legacy parent',
  async () => {
    const f = await setup();
    await f.consent.setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await expect(
      snapshot(f.athlete, (tx) => approveRaceManualApplicationIn(successorTx(tx), f.command)),
    ).rejects.toBeDefined();
    expect((await f.races.getRaceEvent(f.athlete, f.event.id))?.revision).toBe(1);
  },
);
fixtureIt(
  'atomic installation refuses changed predecessor strict metadata before creating any successor',
  async () => {
    const owner = new Pool({ connectionString: url(ownerRole) });
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const signature of [
        'public.race_manual_pooled_relative_membership_v1(jsonb)',
        'public.race_manual_pooled_routine_expansion_v1(jsonb,jsonb,jsonb,text)',
        'public.race_manual_pooled_validate_recipes_v1(jsonb,jsonb)',
        'public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
        'public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
      ])
        await client.query(`DROP FUNCTION ${signature}`);
      await client.query('ALTER FUNCTION public.race_manual_relative_membership_v1(jsonb) STRICT');
      await client.query('SAVEPOINT attempt');
      await expect(
        client.query(
          await readFile(
            new URL('../migrations/137_manual_pooled_application.sql', import.meta.url),
            'utf8',
          ),
        ),
      ).rejects.toThrow('POOLED_APPLICATION_PREDECESSOR_MISMATCH');
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      expect(
        (
          await client.query(
            "SELECT to_regprocedure('public.race_manual_pooled_relative_membership_v1(jsonb)') AS value",
          )
        ).rows[0]?.['value'],
      ).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await owner.end();
    }
  },
);
