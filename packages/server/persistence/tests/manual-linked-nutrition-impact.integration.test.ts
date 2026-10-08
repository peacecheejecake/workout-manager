import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { raceManualInternalPersonalExportSchema } from '@workout/contracts/race-manual-internal-personal-export';
import { raceManualApprovalCommandSchema } from '@workout/contracts/race-manual-approval';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { grantCurrentRuntimeProfile } from '../src/current-runtime-grants.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository, createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualApprovalRepository } from '../src/race-manual-approval.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExport,
} from '../src/race-manual-internal-personal-export-renderer.js';
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
  grantSupplementaryCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root-only real PG: normal107 + actual installed17 + explicit129/narrowEXECUTE.
// Public sources/chain/application APIs produce every body; owner identity FK only.
// Internal sources never constitute source authentication or restore permission.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
describe('linked-only absolute nutrition approval impact', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `linked_nutrition_${suffix}`,
    ownerRole = `linked_nutrition_owner_${suffix}`,
    runtimeRole = `linked_nutrition_app_${suffix}`;
  const roles: string[] = [];
  let admin: Pool,
    db: Database,
    created = false;
  function url(role: string) {
    const u = new URL(z.string().min(1).parse(adminUrl));
    u.pathname = `/${name}`;
    u.username = role;
    u.password = 'isolated';
    return u.toString();
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: z.string().min(1).parse(adminUrl) });
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    created = true;
    await migrate(url(ownerRole), 107);
    await installCurrentRuntime(url(ownerRole));
    for (const grant of [
      grantCorePlanning,
      grantOperations,
      grantRaces,
      grantRoutineCore,
      grantRecoveryCore,
      grantCheckIns,
      grantCourses,
      grantNutritionCore,
      grantSupplementaryCore,
      grantResources,
      grantResourceRetrieval,
      grantGalleryMedia,
      grantGarminUnofficial,
    ])
      await grant(url(ownerRole), runtimeRole);
    await grantCurrentRuntimeProfile(url(ownerRole), runtimeRole);
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        await readFile(
          new URL('../migrations/129_manual_internal_retained_export.sql', import.meta.url),
          'utf8',
        ),
      );
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.read_manual_race_internal_personal_export_v1(integer) TO "${runtimeRole}"`,
      );
      expect(
        (await owner.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]?.['v'],
      ).toBe(107);
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM wm_runtime_installation.migration'))
          .rows[0]?.['n'],
      ).toBe(17);
    } finally {
      await owner.end();
    }
    db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  }, 60000);
  afterAll(async () => {
    await db?.close();
    if (created) await dropIsolatedDatabase(admin, name);
    for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
    await admin?.end();
  });
  async function tenant() {
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
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    return athlete;
  }
  function snapshot<T>(athlete: string, callback: (tx: Transaction) => Promise<T>) {
    if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
    return db.snapshotTenant(athlete, callback);
  }
  async function fixture(
    options: {
      confirmed?: boolean;
      linkage?: 'current' | 'historical' | 'absent';
      keepPlan?: boolean;
    } = {},
  ) {
    const athlete = await tenant();
    const draft = planDraftSchema.parse({
      title: 'Export planned',
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
      sessions: [],
    });
    const firstPlan = await createPlanningRepository(db).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      draft,
    });
    const plan =
      options.linkage === 'historical'
        ? await createPlanningRepository(db).save(athlete, {
            source: 'manual',
            confirmed: true,
            expectedVersionId: firstPlan.id,
            idempotencyKey: randomUUID(),
            draft: { ...draft, title: 'Current owned training' },
          })
        : firstPlan;
    const linkedPlan =
      options.linkage === 'absent'
        ? null
        : options.linkage === 'historical'
          ? firstPlan.id
          : plan.id;
    let nutritionId: string | undefined;
    let strategyId: string | undefined;
    let scheduleId: string | undefined;
    const races = createRaceRepository(db);
    const event = await races.createRaceEvent(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        title: 'Export race',
        localDate: '2026-10-06',
        localStartTime: '09:00',
        timezone: 'UTC',
        locationName: null,
        distance: { kind: 'standard', class: '10k' },
        priority: null,
        participation: 'registered',
        officialUrl: null,
        course: null,
        targetSeconds: null,
        planVersionId: plan.id,
      },
    });
    {
      const nutrition = await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
        schemaVersion: 2,
        command: {
          kind: 'create',
          confirmed: true,
          idempotencyKey: randomUUID(),
          draft: {
            period: { from: '2026-10-01', toInclusive: '2026-11-04' },
            timezone: 'UTC',
            purpose: 'Retained meal',
            linkedTrainingPlanVersionId: linkedPlan,
            items: [
              {
                id: 'meal',
                category: 'before',
                title: 'Meal',
                anchor: {
                  kind: 'absolute',
                  date: '2026-10-06',
                  localTime: '07:30',
                  timezone: 'UTC',
                },
                foods: [
                  {
                    foodVersionId: null,
                    description: 'Zero retained',
                    quantity: 0,
                    unit: 'g',
                    sourceBasis: 'unknown',
                  },
                ],
                targets: [],
                instructions: 'User meal',
                evidenceIds: [],
                source: 'user_confirmed',
              },
            ],
          },
        },
        expectedRaceHeads: [],
      });
      nutritionId = nutrition.planId;
      const recovery = createRecoveryRepository(db),
        optionId = randomUUID();
      const strategy = await recovery.createStrategy(athlete, {
        idempotencyKey: randomUUID(),
        draft: {
          title: 'Selected rest',
          goal: 'Retain user facts',
          startDate: '2026-10-01',
          endDateExclusive: '2026-11-05',
          timezone: 'UTC',
          knownFacts: ['User report'],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: [
            {
              kind: 'nutrition',
              aggregateId: nutrition.planId,
              headVersionId: nutrition.versionId,
            },
          ],
          options: [
            {
              id: optionId,
              title: 'Rest',
              kind: 'full_rest',
              methodVersionId: null,
              explanation: 'User option',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              description: 'Review facts',
              plannedAt: null,
              policyVersion: null,
            },
          ],
        },
      });
      strategyId = strategy.strategyId;
      if (options.confirmed !== false)
        await recovery.confirmStrategy(athlete, {
          strategyId: strategy.strategyId,
          expectedHeadVersionId: strategy.versionId,
          selectedOptionId: optionId,
          idempotencyKey: randomUUID(),
        });
      const routine = createRoutineRepository(db);
      const blueprint = (
        await routine.saveBlueprint(athlete, {
          confirmed: true,
          expectedVersionId: null,
          idempotencyKey: randomUUID(),
          blueprint: {
            schemaVersion: 4,
            routineId: randomUUID(),
            versionId: randomUUID(),
            title: 'Checklist',
            intent: 'Planned only',
            status: 'published',
            tags: [],
            estimatedDurationSeconds: null,
            createdAt: '2026-10-08T00:00:00Z',
            steps: [
              {
                id: 'step',
                title: 'Check',
                content: { kind: 'checklist', prompt: 'User question' },
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
      scheduleId = scheduleInput.schedule.id;
      const preview = await routine.previewSchedule(athlete, scheduleInput);
      await routine.approveSchedule(athlete, {
        ...scheduleInput,
        previewDigest: preview.previewDigest,
        confirmed: true,
        idempotencyKey: randomUUID(),
      });
    }
    const intent = raceProjectionIntentSchema.parse({
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: options.keepPlan
        ? { kind: 'keep_plan' }
        : {
            kind: 'move_period',
            expectedCurrentPlanVersionId: plan.id,
            periodId: 'season',
            newStartDate: '2026-10-03',
            scope: 'descendants_and_sessions',
          },
    });
    const generation = await db.tenant(athlete, async (tx) =>
      z
        .uuid()
        .parse(
          (await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id'],
        ),
    );
    const unknownMetric = <U extends 'g' | 'kcal' | 'mL' | 'mg'>(unit: U) => ({
      value: null,
      unit,
      status: 'unknown' as const,
      evidenceIds: [],
    });
    const actual = await createNutritionRepository(db).createIntake(athlete, {
      idempotencyKey: randomUUID(),
      restoreGeneration: generation,
      intakeId: randomUUID(),
      confirmed: true,
      occurredAt: '2026-10-07T00:00:00Z',
      timezone: 'UTC',
      foods: [
        {
          foodVersionId: null,
          description: 'Actual zero',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'manual_total',
        },
        {
          foodVersionId: null,
          description: 'Actual unknown',
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ],
      nutrientTotal: {
        energy: unknownMetric('kcal'),
        carbohydrate: unknownMetric('g'),
        protein: unknownMetric('g'),
        fat: unknownMetric('g'),
        fluid: unknownMetric('mL'),
        sodium: unknownMetric('mg'),
      },
      plannedItemId: null,
      relatedSessionIds: [],
      relatedActivityIds: [],
      source: 'user',
      sourceRecordId: null,
      notes: null,
    });
    const observed = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
    if (observed.status !== 'current_dependencies_captured') throw Error('BASIS_REQUIRED');
    const chainKey = randomUUID();
    const stored = await createRaceManualReviewChainV2Repository(db).store(athlete, {
      schemaVersion: 2,
      idempotencyKey: chainKey,
      intent,
      expectedBasis: observed.basis,
    });
    if (stored.status !== 'stored') throw Error('CHAIN_REQUIRED');
    if (!nutritionId || !strategyId || !scheduleId) throw Error('PUBLIC_DOMAIN_PRODUCERS_REQUIRED');
    return {
      nutritionId,
      strategyId,
      scheduleId,
      actual,
      plan,
      firstPlan,
      linkedPlan,
      athlete,
      races,
      event,
      intent,
      basis: observed.basis,
      result: stored.result,
      chainKey,
    };
  }
  async function read(athlete: string, limit = 8388608) {
    return snapshot(athlete, async (tx) => {
      const row = z.strictObject({ bytes: z.string().regex(/^\d+$/), source: z.unknown() }).parse(
        (
          await tx.query(
            `WITH observed AS MATERIALIZED (SELECT public.read_manual_race_internal_personal_export_v1($1::integer) AS source),
         measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
         SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`,
            [limit],
          )
        ).rows[0],
      );
      if (BigInt(row.bytes) > BigInt(limit) || row.source === null)
        throw Error('BOUNDED_INTERNAL_EXPORT_REQUIRED');
      return raceManualInternalPersonalExportSourceSchema.parse(row.source);
    });
  }
  async function publicReceiptCount(athlete: string) {
    const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
    try {
      await owner.query('BEGIN READ ONLY');
      await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const count = z
        .object({ n: z.number().int() })
        .parse(
          (
            await owner.query(
              'SELECT count(*)::int AS n FROM public.race_manual_public_receipt_v1 WHERE athlete_id=$1',
              [athlete],
            )
          ).rows[0],
        ).n;
      await owner.query('COMMIT');
      return count;
    } finally {
      await owner.end();
    }
  }
  async function application(f: Awaited<ReturnType<typeof fixture>>) {
    const prepared = await createRaceManualApprovalRepository(db).prepare(f.athlete, {
      schemaVersion: 1,
      chain: {
        evidenceId: f.result.evidenceId,
        decisionId: f.result.decisionId,
        proposalId: f.result.proposalId,
        readonlyCandidateDigest: f.result.candidateDigest,
      },
      intent: f.intent,
      expectedBasis: f.basis,
    });
    if (prepared.status !== 'prepared') throw Error('INTERNAL_APPLICATION_REQUIRED');
    return prepared.candidate;
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function observedState(f: Fixture) {
    return {
      versionCounts: await db.tenant(f.athlete, async (tx) =>
        z
          .strictObject({
            training: z.number().int(),
            nutrition: z.number().int(),
            recovery: z.number().int(),
            routines: z.number().int(),
            intakes: z.number().int(),
            activities: z.number().int(),
          })
          .parse(
            (
              await tx.query(
                `SELECT
        (SELECT count(*)::int FROM public.plan_snapshot WHERE athlete_id=$1) AS training,
        (SELECT count(*)::int FROM public.nutrition_plan_version WHERE athlete_id=$1) AS nutrition,
        (SELECT count(*)::int FROM public.recovery_strategy_version WHERE athlete_id=$1) AS recovery,
        (SELECT count(*)::int FROM public.routine_schedule_version WHERE athlete_id=$1) AS routines,
        (SELECT count(*)::int FROM public.intake_entry WHERE athlete_id=$1) AS intakes,
        (SELECT count(*)::int FROM public.activity_canonical WHERE athlete_id=$1) AS activities`,
                [f.athlete],
              )
            ).rows[0],
          ),
      ),
      training: await createPlanningRepository(db).read(f.athlete),
      nutrition: await createNutritionPlanV4Reader(db).readPlanV4(f.athlete, f.nutritionId),
      recovery: await createRecoveryRepository(db).readStrategy(f.athlete, f.strategyId),
      routines: await createRoutineRepository(db).listSchedules(f.athlete),
      event: await f.races.getRaceEvent(f.athlete, f.event.id),
      actual: await createNutritionRepository(db).readIntake(f.athlete, f.actual.intakeId),
    };
  }
  async function frozenBodies(f: Fixture, nutritionVersionId: string, recoveryVersionId: string) {
    return snapshot(f.athlete, async (tx) => {
      const nutrition = nutritionPlanVersionCompatibleV4Schema.parse(
        (
          await tx.query(
            'SELECT record_json FROM public.nutrition_plan_version WHERE athlete_id=$1 AND plan_id=$2::uuid AND version_id=$3::uuid',
            [f.athlete, f.nutritionId, nutritionVersionId],
          )
        ).rows[0]?.['record_json'],
      );
      const recovery = recoveryStrategyVersionSchema.parse(
        (
          await tx.query(
            'SELECT record_json FROM public.recovery_strategy_version WHERE athlete_id=$1 AND strategy_id=$2::uuid AND version_id=$3::uuid',
            [f.athlete, f.strategyId, recoveryVersionId],
          )
        ).rows[0]?.['record_json'],
      );
      return { nutrition, recovery };
    });
  }
  function approveCommand(candidate: Awaited<ReturnType<typeof application>>) {
    return raceManualApprovalCommandSchema.parse({
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      confirmed: true,
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      raceChange: candidate.raceChange,
      expectation: candidate.expectation,
    });
  }
  async function impact(f: Fixture) {
    const result = await createRaceManualPublicRepository(db).impact(f.athlete, {
      schemaVersion: 1,
      intent: f.intent,
    });
    if (result.status !== 'projected') throw Error('ACTUAL_PROJECTED_IMPACT_REQUIRED');
    expect(result.approvalAllowed).toBe(false);
    expect(result.persistence).toBe('not_stored');
    if (result.nutrition.state !== 'present' || result.recovery.state !== 'present')
      throw Error('ACTUAL_DOMAIN_FACTS_REQUIRED');
    for (const item of result.nutrition.members.flatMap((row) => row.timings)) {
      expect(item.state).toBe('unchanged');
      expect(item.after).toEqual(item.before);
    }
    return result;
  }
  it('declares linked-only absolute nutrition and downstream recovery then explicitly commits all four domains without touching actuals', async () => {
    const f = await fixture();
    const before = await observedState(f);
    expect(before.nutrition?.head?.linkedTrainingPlanVersionId).toBe(f.plan.id);
    expect(before.recovery?.draft.planRefs).toEqual([
      {
        kind: 'nutrition',
        aggregateId: f.nutritionId,
        headVersionId: before.nutrition?.head?.versionId,
      },
    ]);
    expect(before.actual).toEqual(f.actual);
    if (!before.nutrition?.head || !before.recovery) throw Error('OWN_FROZEN_VERSIONS_REQUIRED');
    const originalBodies = await frozenBodies(
      f,
      before.nutrition.head.versionId,
      before.recovery.versionId,
    );
    const diagnostic = await impact(f);
    expect(new Set(diagnostic.affected.map((row) => row.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    if (diagnostic.nutrition.state !== 'present' || diagnostic.recovery.state !== 'present')
      throw Error('DOMAIN_FACTS_REQUIRED');
    expect(diagnostic.nutrition.members[0]?.after.linkedTraining.kind).toBe(
      'follows_training_approval',
    );
    expect(diagnostic.recovery.members[0]?.state).toBe('affected');
    expect(diagnostic.recovery.members[0]?.after.planLinks[0]?.version.kind).toBe(
      'follows_approval',
    );
    expect(await observedState(f)).toEqual(before);
    const candidate = await application(f);
    if (candidate.applicationState !== 'ready_for_explicit_approval')
      throw Error('READY_CANDIDATE_REQUIRED');
    expect(new Set(candidate.writes.map((row) => row.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    expect(new Set(candidate.affected.map((row) => JSON.stringify(row)))).toEqual(
      new Set(diagnostic.affected.map((row) => JSON.stringify(row))),
    );
    expect(await observedState(f)).toEqual(before);
    const command = approveCommand(candidate);
    const repository = createRaceManualApprovalRepository(db);
    const committed = await repository.approve(f.athlete, command);
    if (committed.status !== 'committed') throw Error('ACTUAL_COMMIT_REQUIRED');
    const after = await observedState(f);
    const training = committed.versions.find((row) => row.domain === 'training');
    const nutrition = committed.versions.find((row) => row.domain === 'nutrition');
    expect(after.training.head?.id).toBe(training?.versionId);
    expect(after.training.head?.id).not.toBe(before.training.head?.id);
    expect(after.versionCounts).toEqual({
      ...before.versionCounts,
      training: before.versionCounts.training + 1,
      nutrition: before.versionCounts.nutrition + 1,
      recovery: before.versionCounts.recovery + 1,
      routines: before.versionCounts.routines + 1,
    });
    expect(after.nutrition?.head).toMatchObject({ schemaVersion: 4 });
    expect(after.nutrition?.head?.versionId).toBe(nutrition?.versionId);
    expect(after.nutrition?.head?.versionId).not.toBe(before.nutrition.head.versionId);
    expect(after.recovery?.versionId).not.toBe(before.recovery.versionId);
    expect(after.nutrition?.head?.linkedTrainingPlanVersionId).toBe(training?.versionId);
    expect(
      after.nutrition?.head?.items.map(({ anchor, foods, targets, instructions }) => ({
        anchor,
        foods,
        targets,
        instructions,
      })),
    ).toEqual(
      before.nutrition?.head?.items.map(({ anchor, foods, targets, instructions }) => ({
        anchor,
        foods,
        targets,
        instructions,
      })),
    );
    expect(after.nutrition?.head?.items[0]?.foods[0]?.quantity).toBe(0);
    expect(after.recovery?.draft.planRefs).toEqual([
      { kind: 'nutrition', aggregateId: f.nutritionId, headVersionId: nutrition?.versionId },
    ]);
    expect(after.recovery?.selectedOptionId).toBe(before.recovery?.selectedOptionId);
    expect(after.actual).toEqual(f.actual);
    expect(
      await frozenBodies(f, before.nutrition.head.versionId, before.recovery.versionId),
    ).toEqual(originalBodies);
    expect(after.actual?.status).toBe('active');
    const frozen = await createRaceManualReviewChainV2Repository(db).read(
      f.athlete,
      f.result.evidenceId,
    );
    expect(frozen?.result).toEqual(f.result);
    expect(frozen?.payload?.state).toBe('present');
    const source = await read(f.athlete);
    expect(source.approvalHistory).toHaveLength(4);
    expect(source.approvalResults).toEqual([committed]);
    const rendered = renderRaceManualInternalPersonalExport(source);
    expect(raceManualInternalPersonalExportSchema.parse(rendered)).toEqual(rendered);
    expect(rendered.manualInternalChains[0]?.proposalApplied).toBe(false);
    expect(await publicReceiptCount(f.athlete)).toBe(0);
    expect(await repository.approve(f.athlete, command)).toEqual(committed);
    expect(
      await repository.approve(f.athlete, { ...command, idempotencyKey: randomUUID() }),
    ).toEqual(committed);
    expect(await observedState(f)).toEqual(after);
  });
  it('does not confirm an affected unconfirmed recovery strategy or apply any domain during blocked preparation', async () => {
    const f = await fixture({ confirmed: false });
    const before = await observedState(f);
    expect(before.recovery?.status).not.toBe('user_confirmed');
    expect(before.recovery?.selectedOptionId).toBeNull();
    const result = await createRaceManualApprovalRepository(db).prepare(f.athlete, {
      schemaVersion: 1,
      chain: {
        evidenceId: f.result.evidenceId,
        decisionId: f.result.decisionId,
        proposalId: f.result.proposalId,
        readonlyCandidateDigest: f.result.candidateDigest,
      },
      intent: f.intent,
      expectedBasis: f.basis,
    });
    expect(result).toEqual({ status: 'blocked', reason: 'affected_timing_unresolved' });
    expect(await observedState(f)).toEqual(before);
    const retained = await read(f.athlete);
    expect(retained.candidates).toEqual([]);
    expect(retained.approvalResults).toEqual([]);
    expect(retained.approvalHistory).toEqual([]);
    expect(await publicReceiptCount(f.athlete)).toBe(0);
  });
  it('preserves historical and absent nutrition training links instead of repinning them to a changed current training head', async () => {
    for (const linkage of ['historical', 'absent'] as const) {
      const f = await fixture({ linkage });
      const before = await observedState(f);
      expect(before.nutrition?.head?.linkedTrainingPlanVersionId).toBe(f.linkedPlan);
      if (linkage === 'historical') {
        expect(f.firstPlan.id).not.toBe(f.plan.id);
        expect(await createPlanningRepository(db).readVersion(f.athlete, f.firstPlan.id)).toEqual(
          f.firstPlan,
        );
      }
      const diagnostic = await impact(f);
      expect(new Set(diagnostic.affected.map((row) => row.domain))).toEqual(
        new Set(['training', 'routine_schedule']),
      );
      const candidate = await application(f);
      if (candidate.applicationState !== 'ready_for_explicit_approval')
        throw Error('READY_REQUIRED');
      expect(new Set(candidate.writes.map((row) => row.domain))).toEqual(
        new Set(['training', 'routine_schedule']),
      );
      expect(await observedState(f)).toEqual(before);
      const result = await createRaceManualApprovalRepository(db).approve(
        f.athlete,
        approveCommand(candidate),
      );
      if (result.status !== 'committed') throw Error('COMMIT_REQUIRED');
      expect(new Set(result.versions.map((row) => row.domain))).toEqual(
        new Set(['training', 'routine_schedule']),
      );
      const after = await observedState(f);
      expect(after.nutrition).toEqual(before.nutrition);
      expect(after.recovery).toEqual(before.recovery);
      expect(after.actual).toEqual(f.actual);
    }
  }, 30000);
  it('keeps absolute nutrition and its dependent recovery unchanged when the explicit intent keeps training', async () => {
    const f = await fixture({ keepPlan: true });
    const before = await observedState(f);
    const diagnostic = await impact(f);
    expect(diagnostic.affected).toEqual([]);
    const candidate = await application(f);
    if (candidate.applicationState !== 'ready_for_explicit_approval') throw Error('READY_REQUIRED');
    expect(candidate.writes).toEqual([]);
    expect(await observedState(f)).toEqual(before);
    const result = await createRaceManualApprovalRepository(db).approve(
      f.athlete,
      approveCommand(candidate),
    );
    if (result.status !== 'committed') throw Error('COMMIT_REQUIRED');
    expect(result.versions).toEqual([]);
    const after = await observedState(f);
    expect(after.event?.localDate).toBe('2026-10-08');
    expect(after.training).toEqual(before.training);
    expect(after.nutrition).toEqual(before.nutrition);
    expect(after.recovery).toEqual(before.recovery);
    expect(after.routines).toEqual(before.routines);
    expect(after.actual).toEqual(f.actual);
    expect(after.versionCounts).toEqual(before.versionCounts);
  });
});
