import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExport,
} from '../src/race-manual-internal-personal-export-renderer.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntimeV4 } from '../src/current-runtime-installation-v4.js';
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import { grantCurrentRuntimeV4Profile } from '../src/current-runtime-grants-v4.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { readFile } from 'node:fs/promises';
import {
  mapManualSourcePersonalExportV1,
  readManualSourcePersonalExportV1In,
} from '../src/manual-source-personal-export.js';
import { readRaceManualInternalPersonalExportV1In } from '../src/race-manual-internal-personal-export-reader.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { createOperationsRepository } from '../src/operations.js';
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
// Root executes actual PG. This is personal JSON export, not authenticated restore.
// Public producers create all retained bodies; identity-only FK metadata uses owner.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
describe('SQL132 same-RR retained source batch metadata', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `manual_retained_batch_${suffix}`,
    ownerRole = `manual_retained_batch_owner_${suffix}`,
    runtimeRole = `manual_retained_batch_app_${suffix}`;
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
    await installCurrentRuntimeV4(url(ownerRole));
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
    await grantCurrentRuntimeV4Profile(url(ownerRole), runtimeRole);
    await installCurrentRuntimeV5(url(ownerRole));
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        await readFile(
          new URL('../migrations/132_manual_retained_source_export_batch.sql', import.meta.url),
          'utf8',
        ),
      );
      for (const fn of [
        'read_manual_race_retained_source_batch_v1',
        'read_nutrition_disconnection_personal_export_v1',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION public.${fn}(integer) TO "${runtimeRole}"`);
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) TO "${runtimeRole}"`,
      );
      const catalog = await owner.query(
        "SELECT p.prosecdef, p.proconfig, coalesce((SELECT bool_or(a.grantee=0 AND a.privilege_type='EXECUTE') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) public_execute FROM pg_proc p WHERE p.oid='public.read_manual_race_retained_source_batch_v1(integer)'::regprocedure",
      );
      expect(catalog.rows).toHaveLength(1);
      expect(catalog.rows[0]?.['prosecdef']).toBe(true);
      expect(catalog.rows[0]?.['public_execute']).toBe(false);
      expect(catalog.rows[0]?.['proconfig']).toEqual([
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC',
        'DateStyle=ISO,YMD',
      ]);
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
  // Timed-out callbacks must finish before a later fixture mutates this DB or cleanup runs.
  let lane: Promise<void> = Promise.resolve();
  function sequential(body: () => Promise<void>) {
    const pending = lane.then(body);
    lane = pending.catch(() => undefined);
    return pending;
  }
  afterAll(async () => {
    await lane;
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
  async function reviewFixture(
    allFour = false,
    historicalSessionId: string | null = null,
    historicalChannel: 'nutrition' | 'ended_routine' = 'nutrition',
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
    const planning = createPlanningRepository(db);
    let plan = await planning.save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      draft,
    });
    let historicalPlan: typeof plan | null = null;
    if (historicalSessionId !== null) {
      const session = {
        id: historicalSessionId,
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: '08:00',
        title: 'Frozen session',
        sport: 'running' as const,
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal' as const,
        locks: { date: false, time: false, intensity: false },
        steps: [],
      };
      plan = await planning.save(athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: plan.id,
        idempotencyKey: randomUUID(),
        draft: { ...draft, sessions: [session] },
      });
      historicalPlan = plan;
      if (historicalChannel === 'ended_routine') {
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
              title: 'Historical frozen',
              intent: '',
              status: 'published',
              tags: [],
              estimatedDurationSeconds: null,
              createdAt: '2026-10-08T00:00:00Z',
              steps: [
                {
                  id: 'step',
                  title: 'Check',
                  content: { kind: 'checklist', prompt: 'Synthetic' },
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
              endDateExclusive: '2026-11-01',
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
        await routine.changeSchedule(athlete, {
          scheduleId: approved.schedule.id,
          expectedVersionId: approved.schedule.versionId,
          action: 'end',
          previewDigest: approved.impactDigest,
          confirmed: true,
          idempotencyKey: randomUUID(),
        });
      }
      plan = await planning.save(athlete, {
        source: 'manual',
        confirmed: true,
        expectedVersionId: plan.id,
        idempotencyKey: randomUUID(),
        draft: {
          ...draft,
          title: 'Current successor',
          sessions: [
            {
              ...session,
              id:
                historicalSessionId === 'shared-session' ? historicalSessionId : 'current-session',
            },
          ],
        },
      });
    }
    if (
      historicalPlan !== null &&
      historicalSessionId !== null &&
      historicalChannel === 'nutrition'
    ) {
      // T2 already exists: public nutrition independently selects the exact
      // immutable owned T1, without bypassing a linked-session timing CAS.
      await createNutritionRepository(db).savePlan(athlete, {
        kind: 'create',
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft: {
          period: { from: '2026-10-01', toInclusive: '2026-10-31' },
          timezone: 'UTC',
          purpose: 'Frozen historical training source',
          linkedTrainingPlanVersionId: historicalPlan.id,
          items: [
            {
              id: 'historical-meal',
              category: 'before',
              title: 'Retained meal',
              anchor: {
                kind: 'relative',
                entity: 'session',
                entityId: historicalSessionId,
                point: 'start',
                offsetMinutes: 0,
              },
              foods: [
                {
                  foodVersionId: null,
                  description: 'Synthetic zero',
                  quantity: 0,
                  unit: 'g',
                  sourceBasis: 'unknown',
                },
              ],
              targets: [],
              instructions: 'Synthetic explicit meal',
              evidenceIds: [],
              source: 'user_confirmed',
            },
          ],
        },
      });
    }
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
    let nutritionPlanId: string | null = null;
    if (allFour) {
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
            linkedTrainingPlanVersionId: plan.id,
            items: [
              {
                id: 'meal',
                category: 'before',
                title: 'Meal',
                anchor: {
                  kind: 'relative',
                  entity: 'race',
                  entityId: event.id,
                  point: 'start',
                  offsetMinutes: -30,
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
        expectedRaceHeads: [
          { namespace: 'race-event', eventId: event.id, revision: event.revision },
        ],
      });
      nutritionPlanId = nutrition.planId;
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
            { kind: 'training', aggregateId, headVersionId: plan.id },
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
      const preview = await routine.previewSchedule(athlete, scheduleInput);
      await routine.approveSchedule(athlete, {
        ...scheduleInput,
        previewDigest: preview.previewDigest,
        confirmed: true,
        idempotencyKey: randomUUID(),
      });
    }
    const repo = createRaceManualPublicRepository(db);
    const reviewed = await repo.review(athlete, {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: '2026-10-08',
        selection: {
          kind: 'move_period',
          expectedCurrentPlanVersionId: plan.id,
          periodId: 'season',
          newStartDate: '2026-10-03',
          scope: 'descendants_and_sessions',
        },
      },
    });
    if (reviewed.status !== 'reviewed') {
      const observed = await snapshot(athlete, (tx) =>
        prepareRaceManualConsumedUseV2In(
          tx,
          {
            expectedEvent: { id: event.id, revision: event.revision },
            newLocalDate: '2026-10-08',
            selection: {
              kind: 'move_period',
              expectedCurrentPlanVersionId: plan.id,
              periodId: 'season',
              newStartDate: '2026-10-03',
              scope: 'descendants_and_sessions',
            },
          },
          { bytes: 0n, sources: 0 },
        ),
      );
      // Synthetic fixture diagnostics contain only finite status/reason metadata.
      // No source body, health values, identifiers or copied DTO is logged.
      throw Error(
        'PUBLIC_REVIEW_NOT_READY ' +
          JSON.stringify({
            status: reviewed.status,
            stage: reviewed.stage,
            bindingStatus: observed.bindingStatus,
            preparationStatus: observed.preparationStatus,
            originalStage: observed.originalStage,
            originalReason: observed.originalReason,
            consumedScope:
              observed.consumedScope === null
                ? null
                : {
                    status: observed.consumedScope.status,
                    reasons:
                      observed.consumedScope.status === 'blocked'
                        ? observed.consumedScope.blockers.slice(0, 32).map((b) => b.reason)
                        : [],
                  },
            reason: 'reason' in observed ? observed.reason : null,
          }),
      );
    }
    return {
      athlete,
      historicalPlan,
      currentPlan: plan,
      nutritionPlanId,
      races,
      event,
      repo,
      reviewed,
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: '2026-10-08',
        selection: {
          kind: 'move_period',
          expectedCurrentPlanVersionId: plan.id,
          periodId: 'season',
          newStartDate: '2026-10-03',
          scope: 'descendants_and_sessions',
        },
      },
    };
  }
  const jsonRecord = z.record(z.string(), z.json());
  const sourceMetadata = z.strictObject({
    schemaVersion: z.literal(1),
    chains: z.array(jsonRecord),
    refs: z.array(jsonRecord),
    parents: z.array(jsonRecord),
    suppressions: z.array(jsonRecord),
  });
  const batchSchema = z.strictObject({
    schemaVersion: z.literal(1),
    internal: raceManualInternalPersonalExportSourceSchema,
    sourceMetadata,
  });
  async function rpc(
    tx: Transaction,
    name:
      | 'read_manual_race_retained_source_batch_v1'
      | 'read_manual_race_internal_personal_export_v1'
      | 'read_manual_race_source_personal_export_v1'
      | 'read_nutrition_disconnection_personal_export_v1',
    limit = 8388608,
  ) {
    const out = await tx.query(
      `WITH observed AS MATERIALIZED (SELECT public.${name}($1::integer) value), measured AS MATERIALIZED (SELECT value,octet_length(value::text)::bigint bytes FROM observed) SELECT bytes::text bytes,CASE WHEN bytes<=$1 THEN value ELSE NULL END value FROM measured`,
      [limit],
    );
    const measured = z
      .strictObject({ bytes: z.string().regex(/^[0-9]+$/), value: z.unknown() })
      .parse(out.rows[0]);
    expect(out.rows).toHaveLength(1);
    expect(BigInt(measured.bytes)).toBeLessThanOrEqual(BigInt(limit));
    return measured.value;
  }
  async function comparison(tx: Transaction) {
    const batch = batchSchema.parse(await rpc(tx, 'read_manual_race_retained_source_batch_v1'));
    const internal = raceManualInternalPersonalExportSourceSchema.parse(
      await rpc(tx, 'read_manual_race_internal_personal_export_v1'),
    );
    const old = jsonRecord.parse(await rpc(tx, 'read_manual_race_source_personal_export_v1'));
    const nutrition = await rpc(tx, 'read_nutrition_disconnection_personal_export_v1');
    expect(batch.internal).toEqual(internal);
    const metadata = batch.sourceMetadata;
    const oldChains = z.array(jsonRecord).parse(old['chains']);
    expect(metadata.chains).toHaveLength(internal.chains.length);
    const hydrated = metadata.chains.map((chain) => {
      const parent = internal.chains.find((c) => c.evidenceId === chain['evidenceId']);
      if (!parent) throw Error('BATCH_PARENT_MISSING');
      expect(chain['decisionId']).toBe(parent.decisionId);
      expect(chain['proposalId']).toBe(parent.proposalId);
      const binding = z
        .strictObject({
          state: z.enum(['present', 'purged']),
          digestMethod: z.literal('postgres-jsonb-v1'),
          digest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        })
        .parse(chain['preparationBinding']);
      expect(binding.state).toBe(parent.bodyState);
      const { preparationBinding: ignored, ...plain } = chain;
      expect(ignored).toBeDefined();
      return { ...plain, preparation: parent.preparation };
    });
    expect(hydrated).toEqual(oldChains);
    for (const chain of metadata.chains) {
      const parent = internal.chains.find((c) => c.evidenceId === chain['evidenceId']);
      if (!parent) throw Error('BATCH_PARENT_MISSING');
      const binding = jsonRecord.parse(chain['preparationBinding']);
      if (parent.preparation === null) expect(binding['digest']).toBeNull();
      else {
        // Same actual PGJSONB namespace, never Node canonical DTO/auth digest.
        const expected = await tx.query(
          "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') digest",
          [JSON.stringify(parent.preparation)],
        );
        expect(binding['digest']).toBe(expected.rows[0]?.['digest']);
      }
    }
    const hydratedMetadata = { ...metadata, chains: hydrated };
    expect(hydratedMetadata).toEqual(old);
    expect(renderRaceManualInternalPersonalExport(batch.internal)).toEqual(
      await readRaceManualInternalPersonalExportV1In(tx),
    );
    expect(mapManualSourcePersonalExportV1(hydratedMetadata, nutrition)).toEqual(
      await readManualSourcePersonalExportV1In(tx),
    );
    for (const chain of metadata.chains) expect(chain).not.toHaveProperty('preparation');
    expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(8388608);
    return batch;
  }
  it(
    'preserves exact old129 raw and old130 census/fullroles/hash/presentation from public four-domain review',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const batch = await snapshot(f.athlete, comparison);
        expect(batch.internal.chains).toHaveLength(1);
        expect(batch.internal.candidates).toHaveLength(1);
        expect(batch.sourceMetadata.refs.length).toBeGreaterThan(0);
        expect(batch.sourceMetadata.parents.length).toBeGreaterThan(0);
        expect(batch.sourceMetadata.suppressions).toEqual([]);
        expect(batch.sourceMetadata.chains[0]?.['savedRefCount']).toBe(
          batch.sourceMetadata.refs.length,
        );
        expect(batch.sourceMetadata.chains[0]?.['savedParentCount']).toBe(
          batch.sourceMetadata.parents.length,
        );
      }),
    60000,
  );
  it(
    'preserves original committed results/history and exact before/proposed sources after explicit approval',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const committed = await f.repo.approve(f.athlete, {
          schemaVersion: 1,
          candidateId: f.reviewed.reference.candidateId,
          applicationDigest: f.reviewed.reference.applicationDigest,
          confirmed: true,
          idempotencyKey: randomUUID(),
        });
        if (committed.status !== 'committed') throw Error('APPROVAL_REQUIRED');
        const batch = await snapshot(f.athlete, comparison);
        expect(batch.internal.approvalResults).toEqual([committed]);
        expect(batch.internal.approvalHistory).toHaveLength(4);
      }),
    60000,
  );
  it.each(['nutrition', 'ended_routine'] as const)(
    'keeps exact historical %s source tuple while only current frozen before is rendered',
    (channel) =>
      sequential(async () => {
        const f = await reviewFixture(false, 'shared-session', channel);
        const batch = await snapshot(f.athlete, comparison);
        if (!f.historicalPlan) throw Error('HISTORICAL_REQUIRED');
        expect(
          batch.sourceMetadata.refs.some(
            (ref) => jsonRecord.parse(ref['identity'])['sourceId'] === f.historicalPlan?.id,
          ),
        ).toBe(true);
      }),
    60000,
  );
  it(
    'keeps original deletion event and bodyNULL/minimalrefs without resurrecting any preparation',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const before = await snapshot(f.athlete, comparison);
        await f.races.deleteRaceEvent(f.athlete, f.event.id, {
          expectedRevision: f.event.revision,
          idempotencyKey: randomUUID(),
        });
        const after = await snapshot(f.athlete, comparison);
        expect(after.internal.chains[0]?.preparation).toBeNull();
        expect(after.internal.candidates[0]?.candidate).toBeNull();
        expect(after.sourceMetadata.refs).toHaveLength(before.sourceMetadata.refs.length);
        expect(after.sourceMetadata.parents).toEqual(before.sourceMetadata.parents);
        expect(after.sourceMetadata.suppressions.length).toBeGreaterThan(0);
        expect(after.sourceMetadata.chains[0]?.['preparationBinding']).toEqual({
          state: 'purged',
          digestMethod: 'postgres-jsonb-v1',
          digest: null,
        });
      }),
    60000,
  );
  it(
    'reads retained sameowned metadata after app withdrawal and never returns another tenant rows',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const before = await snapshot(f.athlete, comparison);
        await createConsentRepository(db).setConsent(f.athlete, {
          kind: 'app',
          granted: false,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        });
        expect(await snapshot(f.athlete, comparison)).toEqual(before);
        const other = await tenant();
        const empty = await snapshot(other, comparison);
        expect(empty.internal.chains).toEqual([]);
        expect(empty.sourceMetadata.refs).toEqual([]);
      }),
    60000,
  );
  it(
    'rejects invalid/small byte bounds, non-RR processing context and erased tenant',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        for (const limit of [0, -1, 8388609])
          await expect(
            snapshot(f.athlete, (tx) =>
              rpc(tx, 'read_manual_race_retained_source_batch_v1', limit),
            ),
          ).rejects.toThrow('MANUAL_SOURCE_EXPORT_INVALID_BOUND');
        await expect(
          snapshot(f.athlete, (tx) => rpc(tx, 'read_manual_race_retained_source_batch_v1', 1024)),
        ).rejects.toThrow('MANUAL_SOURCE_EXPORT_TOO_LARGE');
        await expect(
          db.tenant(f.athlete, (tx) => rpc(tx, 'read_manual_race_retained_source_batch_v1')),
        ).rejects.toThrow('MANUAL_SOURCE_EXPORT_SNAPSHOT_REQUIRED');
        await createOperationsRepository(db).eraseAccount(f.athlete);
        await expect(
          snapshot(f.athlete, (tx) => rpc(tx, 'read_manual_race_retained_source_batch_v1')),
        ).rejects.toThrow('ACCOUNT_ERASED');
      }),
    60000,
  );
  it(
    'does not let runtime forge saved tuple/body/census through direct DML',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const before = await snapshot(f.athlete, comparison);
        await expect(
          db.tenant(f.athlete, (tx) =>
            tx.query(
              "UPDATE public.manual_race_chain_source_ref_v2 SET dto_digest=repeat('a',64) WHERE evidence_id=$1::uuid",
              [f.reviewed.reference.chain.evidenceId],
            ),
          ),
        ).rejects.toThrow();
        expect(await snapshot(f.athlete, comparison)).toEqual(before);
      }),
    60000,
  );
  it(
    'keeps one RR batch stable while a genuine race deletion waits on the tenant fence',
    () =>
      sequential(async () => {
        const f = await reviewFixture(true);
        const writerUrl = new URL(url(runtimeRole));
        const writerName = `manual_retained_batch_writer_${suffix}`;
        writerUrl.searchParams.set('application_name', writerName);
        const writerDb = createDatabase({ connectionString: writerUrl.toString(), max: 1 });
        const observer = new Pool({ connectionString: url(ownerRole) });
        const deletions: Promise<unknown>[] = [];
        try {
          await snapshot(f.athlete, async (tx) => {
            const before = await comparison(tx);
            const deletion = createRaceRepository(writerDb).deleteRaceEvent(f.athlete, f.event.id, {
              expectedRevision: f.event.revision,
              idempotencyKey: randomUUID(),
            });
            // Drain rejection even if the barrier assertion fails before releasing the snapshot.
            deletions.push(deletion);
            void deletion.catch(() => undefined);
            const deadline = Date.now() + 5000;
            let waiting = false;
            while (Date.now() < deadline) {
              const observed = await observer.query(
                "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity s JOIN pg_catalog.pg_locks l ON l.pid=s.pid WHERE s.application_name=$1 AND l.locktype='advisory' AND NOT l.granted) waiting",
                [writerName],
              );
              waiting = observed.rows[0]?.['waiting'] === true;
              if (waiting) break;
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            expect(await comparison(tx)).toEqual(before);
          });
          await Promise.all(deletions);
          const after = await snapshot(f.athlete, comparison);
          expect(after.internal.chains[0]?.bodyState).toBe('purged');
          expect(after.sourceMetadata.chains[0]?.['preparationBinding']).toEqual({
            state: 'purged',
            digestMethod: 'postgres-jsonb-v1',
            digest: null,
          });
        } finally {
          await Promise.allSettled(deletions);
          await writerDb.close();
          await observer.end();
        }
      }),
    60000,
  );
});
