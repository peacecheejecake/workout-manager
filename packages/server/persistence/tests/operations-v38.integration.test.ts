import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountExportV38Schema } from '@workout/contracts/operations';
import { planDraftSchema, planSnapshotSchema } from '@workout/contracts/planning';
import { mapManualSourcePersonalExportV1 } from '../src/manual-source-personal-export.js';
import { renderRaceManualInternalPersonalExport } from '../src/race-manual-internal-personal-export-renderer.js';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntimeV4 } from '../src/current-runtime-installation-v4.js';
import { grantCurrentRuntimeV3Profile } from '../src/current-runtime-grants-v3.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { createNutritionPlanV4Reader } from '../src/nutrition-core.js';
import {
  saveNutritionPlanV4IntentSchema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createOperationsV38Repository } from '../src/operations.js';
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
describe('V38 coherent retained personal export', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `operations_v38_${suffix}`,
    ownerRole = `operations_v38_owner_${suffix}`,
    runtimeRole = `operations_v38_app_${suffix}`;
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
    await grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole);
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      // Explicit fixture-only composition: no grantV4 activation is claimed.
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.read_manual_race_source_personal_export_v1(integer),public.read_nutrition_disconnection_personal_export_v1(integer) TO "${runtimeRole}"`,
      );
      expect(
        (
          await owner.query(
            'SELECT source_ddl_id FROM wm_runtime_installation.profile_extension_v4',
          )
        ).rows,
      ).toEqual([{ source_ddl_id: 130 }]);
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
  const content = {
    definitionVersion: 'checkin-v1',
    source: 'user',
    method: 'self_report',
    title: 'Retained prompts',
    instructions: null,
    fields: ['fatigue', 'note'],
  };
  async function reviewFixture(allFour = false, historicalSessionId: string | null = null) {
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
    if (reviewed.status !== 'reviewed') throw Error('PUBLIC_REVIEW_NOT_READY');
    return {
      athlete,
      races,
      event,
      repo,
      reviewed,
      nutritionPlanId,
      historicalPlan,
      currentPlan: plan,
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
  async function auditCount(athlete: string) {
    return db.tenant(
      athlete,
      async (tx) =>
        z
          .object({ n: z.number().int() })
          .parse(
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM operations_audit WHERE athlete_id=$1 AND action='export_requested'",
                [athlete],
              )
            ).rows[0],
          ).n,
    );
  }
  it('exports exact template chain and public approval facts coherently after app withdrawal', async () => {
    const f = await reviewFixture(),
      templates = createCheckInTemplateRepository(db),
      templateId = randomUUID();
    const first = await templates.save(f.athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 0,
      content,
    });
    const second = await templates.save(f.athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 1,
      content: { ...content, title: 'Second retained' },
    });
    const committed = await f.repo.approve(f.athlete, {
      schemaVersion: 1,
      candidateId: f.reviewed.reference.candidateId,
      applicationDigest: f.reviewed.reference.applicationDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    if (committed.status !== 'committed') throw Error('APPROVAL_REQUIRED');
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const rpcLimits: number[] = [];
    const observedDb: Database = {
      ...db,
      snapshotTenant: (id, operation) =>
        snapshot(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              if (sql.includes('WITH observed AS MATERIALIZED')) {
                const limit = values?.[0];
                if (typeof limit !== 'number') throw Error('LIMIT_REQUIRED');
                rpcLimits.push(limit);
              }
              return tx.query(sql, values);
            },
          }),
        ),
    };
    const value = await createOperationsV38Repository(observedDb).exportAccount(f.athlete);
    expect(rpcLimits).toHaveLength(5);
    expect(
      rpcLimits.every((limit, index) => index === 0 || limit < (rpcLimits[index - 1] ?? 0)),
    ).toBe(true);
    expect(rpcLimits[2]).toBeLessThan(rpcLimits[1] ?? 0);
    expect(rpcLimits[0]).toBeLessThan(8388608);
    expect(rpcLimits[1]).toBeLessThan(rpcLimits[0] ?? 0);
    expect(accountExportV38Schema.parse(value)).toEqual(value);
    expect(value.data.manualInternalChains).toHaveLength(1);
    expect(value.data.sourceProvenanceCoverage).toBe('saved_safe_dependency_facts');
    expect(value.schemaVersion).toBe(38);
    expect(value.data.checkInTemplateVersions.map((row) => row.record_json)).toEqual([
      first,
      second,
    ]);
    expect(value.data.checkInTemplateHeads).toEqual([
      { template_id: templateId, version_id: second.versionId, version: 2 },
    ]);
    expect(value.data.manualRaceReviews[0]?.preview?.status).toBe('present');
    expect(
      value.data.manualRaceCommandResults.find((row) => row.operation === 'approve')?.result,
    ).toEqual(committed);
    expect(value.data.manualRaceApprovalHistory.map((row) => row.domain)).toEqual(['training']);
    expect(value.data.manualInternalApprovalResults).toEqual([committed]);
    expect(value.data.manualInternalApprovalHistory).toEqual(value.data.manualRaceApprovalHistory);
    const training = committed.versions.find((row) => row.domain === 'training');
    if (!training) throw Error('TRAINING_REQUIRED');
    expect(value.data.trainingPlanAggregates).toContainEqual({
      version_id: training.versionId,
      aggregate_id: training.aggregateId,
    });
    expect(value.data.planSnapshots.map((row) => row['id'])).toContain(
      committed.versions.find((row) => row.domain === 'training')?.versionId,
    );
    expect(await auditCount(f.athlete)).toBe(1);
    expect(JSON.stringify(value)).not.toContain('basis_json');
    expect(JSON.stringify(value)).not.toContain('request_digest');
    expect(value.data.sourceAuthentication).toBe('not_authenticated');
    expect(value.data.originalEventAuthentication).toBe('not_authenticated');
    expect(value.data.manualSourceChains.map((r) => r.evidenceId).sort()).toEqual(
      value.data.manualInternalChains.map((r) => r.evidenceId).sort(),
    );
    for (const row of value.data.manualSourceChains) {
      expect(
        value.data.manualSavedSourceRefs.filter((r) => r.evidenceId === row.evidenceId),
      ).toHaveLength(row.savedRefCount);
    }
    expect(JSON.stringify(value.data.manualSavedSourceRefs)).not.toMatch(
      /copied_locations|sourceRecordId.*sensitive|dto_digest|sql_relations/,
    );
  });
  it('exports source-purged contentless review and original successful receipt', async () => {
    const f = await reviewFixture(),
      repo = createOperationsV38Repository(db);
    const before = await repo.exportAccount(f.athlete);
    expect(before.data.manualSourceChains).toHaveLength(1);
    expect(before.data.manualSavedSourceRefs.length).toBeGreaterThan(0);
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: f.event.revision,
    });
    const after = await repo.exportAccount(f.athlete);
    expect(after.data.manualRaceReviews).toEqual([
      {
        reference: f.reviewed.reference,
        createdAt: f.reviewed.reference.createdAt,
        bodyState: 'purged',
        preview: null,
      },
    ]);
    expect(after.data.manualRaceCommandResults).toEqual(before.data.manualRaceCommandResults);
    expect(after.data.manualInternalChains).toHaveLength(1);
    expect(after.data.manualInternalCandidates).toHaveLength(1);
    expect(after.data.manualInternalChains[0]?.body.state).toBe('purged');
    expect(after.data.manualInternalCandidates[0]?.body.state).toBe('purged');
    expect(after.data.manualInternalApprovalResults).toEqual(
      before.data.manualInternalApprovalResults,
    );
    expect(after.data.manualSourceChains[0]?.body.state).toBe('purged');
    expect(
      after.data.manualSavedSourceRefs.map((r) => ({ ordinal: r.ordinal, identity: r.identity })),
    ).toEqual(
      before.data.manualSavedSourceRefs.map((r) => ({ ordinal: r.ordinal, identity: r.identity })),
    );
    expect(after.data.manualSavedSourceSuppressions.length).toBeGreaterThan(0);
    expect(await auditCount(f.athlete)).toBe(2);
  });
  it('does not expose another tenant retained records and refuses RC fallback before any query', async () => {
    const f = await reviewFixture(),
      other = await tenant();
    const empty = await createOperationsV38Repository(db).exportAccount(other);
    expect(empty.data.manualRaceReviews).toEqual([]);
    expect(empty.data.manualInternalChains).toEqual([]);
    expect(empty.data.manualInternalCandidates).toEqual([]);
    expect(empty.data.checkInTemplateVersions).toEqual([]);
    const noSnapshot: Database = {
      tenant: db.tenant,
      exclusiveTenant: db.exclusiveTenant,
      close: async () => {},
    };
    expect(() => createOperationsV38Repository(noSnapshot).exportAccount(f.athlete)).toThrow(
      'OPERATIONS_SNAPSHOT_REQUIRED',
    );
    expect(await auditCount(f.athlete)).toBe(0);
  });
  it('rolls back audit on outer failure even after successful export', async () => {
    const athlete = await tenant();
    const rollbackDatabase: Database = {
      ...db,
      snapshotTenant: async (id, operation) =>
        snapshot(id, async (tx) => {
          await operation(tx);
          throw Error('FORCED_EXPORT_ROLLBACK');
        }),
    };
    await expect(
      createOperationsV38Repository(rollbackDatabase).exportAccount(athlete),
    ).rejects.toThrow('FORCED_EXPORT_ROLLBACK');
    expect(await auditCount(athlete)).toBe(0);
  });
  it.each([
    'read_manual_race_source_personal_export_v1',
    'read_nutrition_disconnection_personal_export_v1',
  ] as const)(
    'unavailable source reader %s aborts the entire export without recording success or fabricating empty sets',
    async (reader) => {
      const athlete = await tenant(),
        owner = new Pool({ connectionString: url(ownerRole) });
      try {
        await owner.query(
          `REVOKE EXECUTE ON FUNCTION public.${reader}(integer) FROM "${runtimeRole}"`,
        );
        await expect(createOperationsV38Repository(db).exportAccount(athlete)).rejects.toThrow(
          'UNSUPPORTED',
        );
        expect(await auditCount(athlete)).toBe(0);
      } finally {
        await owner.query(
          `GRANT EXECUTE ON FUNCTION public.${reader}(integer) TO "${runtimeRole}"`,
        );
        await owner.end();
      }
    },
  );
  it('refuses retained export after genuine account erasure', async () => {
    const athlete = await tenant();
    const operations = createOperationsV38Repository(db);
    await createCheckInTemplateRepository(db).save(athlete, {
      idempotencyKey: randomUUID(),
      templateId: randomUUID(),
      expectedVersion: 0,
      content,
    });
    expect(await operations.eraseAccount(athlete)).toEqual({ erased: true });
    await expect(operations.exportAccount(athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
  it('exports every actual all-four approval body and domain history with unchanged original receipts', async () => {
    const f = await reviewFixture(true);
    const command = {
      schemaVersion: 1,
      candidateId: f.reviewed.reference.candidateId,
      applicationDigest: f.reviewed.reference.applicationDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    };
    const result = await f.repo.approve(f.athlete, command);
    if (result.status !== 'committed') throw Error('ALL_FOUR_REQUIRED');
    expect(new Set(result.versions.map((row) => row.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    const value = await createOperationsV38Repository(db).exportAccount(f.athlete);
    expect(accountExportV38Schema.parse(value)).toEqual(value);
    expect(value.data.manualInternalChains).toHaveLength(1);
    expect(value.data.sourceProvenanceCoverage).toBe('saved_safe_dependency_facts');
    expect(
      value.data.manualRaceCommandResults.find((row) => row.operation === 'approve')?.result,
    ).toEqual(result);
    expect(new Set(value.data.manualRaceApprovalHistory.map((row) => row.domain))).toEqual(
      new Set(result.versions.map((row) => row.domain)),
    );
    const nutrition = result.versions.find((row) => row.domain === 'nutrition');
    const body = value.data.nutritionPlanVersions.find(
      (row) => row.version_id === nutrition?.versionId,
    )?.record_json;
    expect(body).toMatchObject({ schemaVersion: 4 });
    expect(body?.items[0]?.foods[0]?.quantity).toBe(0);
    expect(
      value.data.recoveryStrategyVersions.some(
        (row) => row.version_id === result.versions.find((v) => v.domain === 'recovery')?.versionId,
      ),
    ).toBe(true);
    expect(
      value.data.genericRoutineScheduleVersions.some(
        (row) =>
          row.version_id ===
          result.versions.find((v) => v.domain === 'routine_schedule')?.versionId,
      ),
    ).toBe(true);
    expect(value.data.manualInternalApprovalResults).toEqual([result]);
    expect(value.data.manualInternalApprovalHistory).toEqual(value.data.manualRaceApprovalHistory);
    expect(value.data.manualInternalCandidates[0]?.body.state).toBe('present');
    expect(await f.repo.approve(f.athlete, command)).toEqual(result);
  });
  it('includes internal-only original chains without inventing a public review reference', async () => {
    const f = await reviewFixture(true);
    const originalRace = await f.races.getRaceEvent(f.athlete, f.event.id);
    const basis = await createRaceManualSemanticBasisV2Service(db).prepare(f.athlete, f.intent);
    if (basis.status !== 'current_dependencies_captured') throw Error('BASIS_REQUIRED');
    const key = randomUUID();
    const command = {
      schemaVersion: 2,
      idempotencyKey: key,
      intent: f.intent,
      expectedBasis: basis.basis,
    };
    const chain = await createRaceManualReviewChainV2Repository(db).store(f.athlete, command);
    if (chain.status !== 'stored') throw Error('CHAIN_REQUIRED');
    expect(await createRaceManualReviewChainV2Repository(db).store(f.athlete, command)).toEqual({
      ...chain,
      status: 'replayed',
    });
    const value = await createOperationsV38Repository(db).exportAccount(f.athlete);
    expect(value.data.manualRaceReviews).toHaveLength(1);
    expect(value.data.manualInternalChains).toHaveLength(2);
    expect(value.data.manualSourceChains.map((r) => r.evidenceId).sort()).toEqual(
      value.data.manualInternalChains.map((r) => r.evidenceId).sort(),
    );
    expect(
      value.data.manualInternalChains.find((row) => row.evidenceId === chain.result.evidenceId)
        ?.body.state,
    ).toBe('present');
    expect(value.data.manualInternalCandidates).toHaveLength(1);
    expect(value.data.manualInternalApprovalResults).toEqual([]);
    expect(value.data.manualInternalApprovalHistory).toEqual([]);
    expect(await f.races.getRaceEvent(f.athlete, f.event.id)).toEqual(originalRace);
  });
  it('serializes a real public writer after a snapshot barrier and returns the frozen head', async () => {
    const athlete = await tenant(),
      templateId = randomUUID();
    const first = await createCheckInTemplateRepository(db).save(athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 0,
      content,
    });
    let signalBase: () => void = () => {},
      release: () => void = () => {},
      signalWriter: () => void = () => {};
    const baseReady = new Promise<void>((resolve) => {
      signalBase = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writerReady = new Promise<void>((resolve) => {
      signalWriter = resolve;
    });
    const readerDb: Database = {
      ...db,
      snapshotTenant: (id, operation) =>
        snapshot(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.includes('WITH base AS MATERIALIZED')) {
                signalBase();
                await released;
              }
              return result;
            },
          }),
        ),
    };
    const writerDb: Database = {
      ...db,
      tenant: (id, operation) =>
        db.tenant(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              if (sql.includes('save_check_in_template_v1')) signalWriter();
              return tx.query(sql, values);
            },
          }),
        ),
    };
    const exporting = createOperationsV38Repository(readerDb).exportAccount(athlete);
    // Attach rejection handlers immediately; both operations are awaited below.
    const exportResult = exporting.then(
      (value) => ({ value }),
      (error: unknown) => {
        signalBase();
        release();
        return { error };
      },
    );
    await baseReady;
    const writing = createCheckInTemplateRepository(writerDb).save(athlete, {
      idempotencyKey: randomUUID(),
      templateId,
      expectedVersion: 1,
      content: { ...content, title: 'After snapshot' },
    });
    const writeResult = writing.then(
      (value) => ({ value }),
      (error: unknown) => {
        signalWriter();
        return { error };
      },
    );
    try {
      await writerReady;
    } finally {
      release();
    }
    const [frozen, updated] = await Promise.all([exportResult, writeResult]);
    if ('error' in frozen) throw frozen.error;
    if ('error' in updated) throw updated.error;
    expect(frozen.value.data.checkInTemplateHeads).toEqual([
      { template_id: templateId, version_id: first.versionId, version: 1 },
    ]);
    const next = await createOperationsV38Repository(db).exportAccount(athlete);
    expect(next.data.checkInTemplateHeads[0]?.version_id).toBe(updated.value.versionId);
    expect(next.data.checkInTemplateVersions.map((row) => row.record_json)).toEqual([
      first,
      updated.value,
    ]);
  });
  it('debits genuine near-8MiB families together and rolls back the failed request audit', async () => {
    const f = await reviewFixture(true),
      templates = createCheckInTemplateRepository(db),
      templateId = randomUUID();
    const originalRace = await f.races.getRaceEvent(f.athlete, f.event.id);
    // Exactly 1000 immutable versions stays within the family count cap. Korean
    // instructions make actual UTF8 substantially larger than JS string length.
    for (let version = 0; version < 1000; version++)
      await templates.save(f.athlete, {
        idempotencyKey: randomUUID(),
        templateId,
        expectedVersion: version,
        content: { ...content, instructions: '가'.repeat(2000) },
      });
    let internalRemaining = 0;
    const observed: Database = {
      ...db,
      snapshotTenant: (id, operation) =>
        snapshot(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              if (
                sql.includes('WITH observed AS MATERIALIZED') &&
                sql.includes('read_manual_race_internal_personal_export_v1')
              ) {
                internalRemaining = z.number().int().positive().parse(values?.[0]);
              }
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await createOperationsV38Repository(observed).exportAccount(f.athlete);
    expect(internalRemaining).toBeLessThan(3 * 1024 * 1024);
    expect(internalRemaining).toBeGreaterThan(1);
    const basis = await createRaceManualSemanticBasisV2Service(db).prepare(f.athlete, f.intent);
    if (basis.status !== 'current_dependencies_captured') throw Error('BASIS_REQUIRED');
    let rawBytes = 0;
    for (let index = 0; index < 120 && rawBytes <= internalRemaining; index++) {
      const stored = await createRaceManualReviewChainV2Repository(db).store(f.athlete, {
        schemaVersion: 2,
        idempotencyKey: randomUUID(),
        intent: f.intent,
        expectedBasis: basis.basis,
      });
      if (stored.status !== 'stored') throw Error('CHAIN_REQUIRED');
      // Measure only SQL UTF8 metadata, never fabricate body or driver bytes.
      rawBytes = await snapshot(
        f.athlete,
        async (tx) =>
          z
            .strictObject({ bytes: z.string().regex(/^[1-9]\d*$/) })
            .parse(
              (
                await tx.query(
                  'SELECT octet_length(public.read_manual_race_internal_personal_export_v1(8388608)::text)::text AS bytes',
                )
              ).rows[0],
            ).bytes,
      ).then(Number);
    }
    expect(rawBytes).toBeGreaterThan(internalRemaining);
    expect(rawBytes).toBeLessThan(8388608);
    const before = await auditCount(f.athlete);
    await expect(createOperationsV38Repository(db).exportAccount(f.athlete)).rejects.toThrow(
      'EXPORT_TOO_LARGE',
    );
    expect(await auditCount(f.athlete)).toBe(before);
    expect(await f.races.getRaceEvent(f.athlete, f.event.id)).toEqual(originalRace);
  }, 180000);
  it('maps genuine public template count exhaustion to EXPORT_TOO_LARGE with no success audit', async () => {
    const athlete = await tenant(),
      templates = createCheckInTemplateRepository(db),
      templateId = randomUUID();
    for (let version = 0; version <= 1000; version++)
      await templates.save(athlete, {
        idempotencyKey: randomUUID(),
        templateId,
        expectedVersion: version,
        content,
      });
    await expect(createOperationsV38Repository(db).exportAccount(athlete)).rejects.toThrow(
      'EXPORT_TOO_LARGE',
    );
    expect(await auditCount(athlete)).toBe(0);
  }, 120000);
  it('exports original SQL110 origin and retained/reconnected/carried versions without restoring deleted timing', async () => {
    const f = await reviewFixture(true);
    if (!f.nutritionPlanId) throw Error('NUTRITION_REQUIRED');
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      expectedRevision: f.event.revision,
      idempotencyKey: randomUUID(),
    });
    const readPlan = async () => {
      const value = await createNutritionPlanV4Reader(db).readPlanV4(
        f.athlete,
        z.uuid().parse(f.nutritionPlanId),
      );
      if (!value?.head) throw Error('HEAD_REQUIRED');
      return value.head;
    };
    const writer = createNutritionRacePlanV4Writer(db),
      prior = await readPlan();
    const update = (
      p: NutritionPlanVersionCompatibleV4,
      event?: { id: string; revision: number },
      reconnect = false,
    ) =>
      saveNutritionPlanV4IntentSchema.parse({
        schemaVersion: 4,
        intent: {
          schemaVersion: 3,
          command: {
            kind: 'update',
            planId: p.planId,
            expectedHeadVersionId: p.versionId,
            idempotencyKey: randomUUID(),
            confirmed: true,
            draft: {
              period: p.period,
              timezone: p.timezone,
              purpose: p.purpose,
              linkedTrainingPlanVersionId: p.linkedTrainingPlanVersionId,
              items: p.items.map(({ planVersionId, ...item }) => {
                void planVersionId;
                return reconnect && event
                  ? {
                      ...item,
                      anchor: {
                        kind: 'relative',
                        entity: 'race',
                        entityId: event.id,
                        point: 'start',
                        offsetMinutes: -30,
                      },
                    }
                  : item;
              }),
            },
          },
          expectedRaceHeads: event
            ? [{ namespace: 'race-event', eventId: event.id, revision: event.revision }]
            : [],
          reconnectItemIds: reconnect ? ['meal'] : [],
        },
      });
    const retained = await writer.savePlanV4(f.athlete, update(prior));
    const initial = (await createOperationsV38Repository(db).exportAccount(f.athlete)).data;
    expect(initial.nutritionDisconnectionOrigins).toHaveLength(1);
    const origin = initial.nutritionDisconnectionOrigins[0];
    if (!origin) throw Error('ORIGIN_REQUIRED');
    expect(initial.nutritionDisconnectionLineage[0]?.disposition).toBe('retained');
    const nextEvent = await f.races.createRaceEvent(f.athlete, {
      idempotencyKey: randomUUID(),
      values: {
        title: 'New own target',
        localDate: '2026-10-09',
        localStartTime: '09:00',
        timezone: 'UTC',
        distance: { kind: 'standard', class: '10k' },
        locationName: null,
        participation: 'registered',
        priority: null,
        officialUrl: null,
        course: null,
        targetSeconds: null,
        planVersionId: null,
      },
    });
    const reconnected = await writer.savePlanV4(f.athlete, update(retained.plan, nextEvent, true));
    const carried = await writer.savePlanV4(f.athlete, update(reconnected.plan, nextEvent));
    const value = (await createOperationsV38Repository(db).exportAccount(f.athlete)).data;
    expect(value.nutritionDisconnectionOrigins).toEqual(initial.nutritionDisconnectionOrigins);
    expect(value.nutritionDisconnectionLineage.map((r) => r.disposition)).toEqual([
      'retained',
      'reconnected',
      'carried',
    ]);
    expect(
      value.nutritionDisconnectionLineage.every(
        (r) =>
          r.originVersionId === origin.originVersionId &&
          r.eventId === origin.eventId &&
          r.itemId === 'meal',
      ),
    ).toBe(true);
    expect((await readPlan()).items[0]?.foods).toEqual(prior.items[0]?.foods);
    expect(carried.plan.items[0]?.anchor).toEqual(reconnected.plan.items[0]?.anchor);
    await f.races.deleteRaceEvent(f.athlete, nextEvent.id, {
      expectedRevision: nextEvent.revision,
      idempotencyKey: randomUUID(),
    });
    expect((await readPlan()).items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
    const deleted = (await createOperationsV38Repository(db).exportAccount(f.athlete)).data;
    expect(deleted.nutritionDisconnectionOrigins).toEqual(
      expect.arrayContaining(initial.nutritionDisconnectionOrigins),
    );
    expect(deleted.nutritionDisconnectionLineage).toEqual(value.nutritionDisconnectionLineage);
  });

  it('serializes genuine race deletion after a frozen retained-export snapshot without mixing postimages', async () => {
    const f = await reviewFixture(true);
    let release = () => {},
      signalRead = () => {},
      signalWriter = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readReady = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const writerReady = new Promise<void>((resolve) => {
      signalWriter = resolve;
    });
    const readerDb: Database = {
      ...db,
      snapshotTenant: (id, operation) =>
        snapshot(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (
                sql.includes('WITH observed AS MATERIALIZED') &&
                sql.includes('read_manual_race_source_personal_export_v1')
              ) {
                signalRead();
                await released;
              }
              return result;
            },
          }),
        ),
    };
    const exporting = createOperationsV38Repository(readerDb)
      .exportAccount(f.athlete)
      .then(
        (value) => ({ value }),
        (error: unknown) => {
          signalRead();
          release();
          return { error };
        },
      );
    await readReady;
    const writerDb: Database = {
      ...db,
      tenant: (id, operation) =>
        db.tenant(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              const pending = tx.query(sql, values);
              // The first tenant lock must wait for the frozen reader. Waiting
              // for delete_race_entity here would deadlock the test latch.
              if (sql.includes('pg_advisory_xact_lock(hashtextextended($1,0))')) signalWriter();
              return pending;
            },
          }),
        ),
    };
    let writerCompleted = false;
    const deleting = createRaceRepository(writerDb)
      .deleteRaceEvent(f.athlete, f.event.id, {
        expectedRevision: f.event.revision,
        idempotencyKey: randomUUID(),
      })
      .then(
        (value) => {
          writerCompleted = true;
          return { value };
        },
        (error: unknown) => {
          signalWriter();
          return { error };
        },
      );
    try {
      await writerReady;
      expect(writerCompleted).toBe(false);
    } finally {
      release();
    }
    const [old, deleted] = await Promise.all([exporting, deleting]);
    if ('error' in old) throw old.error;
    if ('error' in deleted) throw deleted.error;
    expect(old.value.data.manualSourceChains[0]?.body.state).toBe('present');
    expect(old.value.data.manualSavedSourceSuppressions).toEqual([]);
    const next = (await createOperationsV38Repository(db).exportAccount(f.athlete)).data;
    expect(next.manualSourceChains[0]?.body.state).toBe('purged');
    expect(
      next.manualSavedSourceRefs.map((r) => ({ ordinal: r.ordinal, identity: r.identity })),
    ).toEqual(
      old.value.data.manualSavedSourceRefs.map((r) => ({
        ordinal: r.ordinal,
        identity: r.identity,
      })),
    );
    expect(next.manualSavedSourceSuppressions).toHaveLength(1);
    expect(next.nutritionDisconnectionOrigins).toHaveLength(1);
  });
  it.each(['historical-session', 'shared-session'])(
    'keeps historical copied training %s private and identifies only the frozen current before',
    async (sessionId) => {
      const f = await reviewFixture(false, sessionId);
      const historical = f.historicalPlan;
      if (!historical) throw Error('HISTORICAL_FIXTURE_MISSING');
      const beforeAudit = await auditCount(f.athlete);
      // Diagnostic wrapper forwards every actual query/row unchanged and never
      // logs identifiers, planned values, raw envelope or digests. It changes no
      // schema/expectation and retains the genuine producer failure.
      let baseSnapshots: unknown[] = [],
        rawInternal: unknown = null,
        rawManual: unknown = null,
        rawNutrition: unknown = null;
      const observedDb: Database = {
        ...db,
        snapshotTenant: (id, operation) =>
          snapshot(id, (tx) =>
            operation({
              athleteId: tx.athleteId,
              query: async (sql, values) => {
                const result = await tx.query(sql, values);
                if (sql.includes('WITH base AS MATERIALIZED'))
                  baseSnapshots = z
                    .object({ data: z.object({ planSnapshots: z.array(z.unknown()) }) })
                    .parse(result.rows[0]).data.planSnapshots;
                if (sql.includes('WITH observed AS MATERIALIZED')) {
                  const source = z.object({ source: z.unknown() }).parse(result.rows[0]).source;
                  if (sql.includes('read_manual_race_internal_personal_export_v1'))
                    rawInternal = source;
                  if (sql.includes('read_manual_race_source_personal_export_v1'))
                    rawManual = source;
                  if (sql.includes('read_nutrition_disconnection_personal_export_v1'))
                    rawNutrition = source;
                }
                return result;
              },
            }),
          ),
      };
      const artifact = await createOperationsV38Repository(observedDb)
        .exportAccount(f.athlete)
        .catch((error: unknown) => {
          const mapped = mapManualSourcePersonalExportV1(rawManual, rawNutrition);
          const rendered = renderRaceManualInternalPersonalExport(rawInternal);
          const physicalSchema = z.strictObject({
            id: planSnapshotSchema.shape.id,
            version: planSnapshotSchema.shape.version,
            created_at: planSnapshotSchema.shape.createdAt,
            draft: planSnapshotSchema.shape.draft,
          });
          const physical = baseSnapshots.flatMap((raw) => {
            const p = physicalSchema.safeParse(raw);
            return p.success ? [p.data] : [];
          });
          const runtime = baseSnapshots.flatMap((raw) => {
            const p = planSnapshotSchema.safeParse(raw);
            return p.success ? [p.data] : [];
          });
          const diagnostics = mapped.manualSavedSourceRefs.flatMap((ref) =>
            ref.location.state !== 'known'
              ? []
              : ref.location.members.map((loc) => {
                  const chain = rendered.manualInternalChains.find(
                    (c) => c.evidenceId === ref.evidenceId,
                  );
                  const body = chain?.body.state === 'present' ? chain.body.planned : null;
                  let beforeTupleMatch = false;
                  const parent = loc.parent;
                  switch (loc.domain) {
                    case 'training':
                      beforeTupleMatch =
                        body?.training.state === 'present' &&
                        parent.family === 'plan-snapshot' &&
                        body.training.members.some(
                          (m) =>
                            m.aggregateId === loc.aggregateId &&
                            m.before.ref.versionId === parent.sourceId &&
                            m.before.ref.version === parent.version &&
                            m.before.plan.sessions.some((i) => i.id === loc.memberId),
                        );
                      break;
                    case 'routine_schedule':
                      beforeTupleMatch =
                        body?.routines.state === 'present' &&
                        body.routines.members.some(
                          (m) =>
                            m.aggregateId === loc.aggregateId &&
                            m.blueprint.steps.some((i) => i.id === loc.memberId) &&
                            ((parent.family === 'routine-blueprint' &&
                              m.blueprint.routineId === parent.sourceId &&
                              m.blueprint.versionId === parent.versionId) ||
                              (parent.family === 'routine-schedule' &&
                                m.before.schedule.id === parent.sourceId &&
                                m.before.schedule.versionId === parent.versionId)),
                        );
                      break;
                    case 'race':
                      beforeTupleMatch =
                        body !== null &&
                        parent.family === 'race-event' &&
                        parent.sourceId === body.race.eventId &&
                        parent.revision === body.race.expectedRevision &&
                        loc.aggregateId === body.race.eventId &&
                        loc.memberId === null;
                      break;
                    case 'nutrition':
                      beforeTupleMatch =
                        body?.nutrition.state === 'present' &&
                        parent.family === 'nutrition-plan' &&
                        body.nutrition.members.some(
                          (m) =>
                            m.aggregateId === loc.aggregateId &&
                            m.before.ref.versionId === parent.versionId &&
                            m.before.plan.items.some((i) => i.id === loc.memberId),
                        );
                      break;
                    case 'recovery':
                      beforeTupleMatch =
                        body?.recovery.state === 'present' &&
                        parent.family === 'recovery-strategy' &&
                        body.recovery.members.some(
                          (m) =>
                            m.aggregateId === loc.aggregateId &&
                            m.before.ref.versionId === parent.versionId &&
                            m.before.plan.options.some((i) => i.id === loc.memberId),
                        );
                      break;
                  }
                  const training = parent.family === 'plan-snapshot';
                  return {
                    sourceKind: ref.identity.kind,
                    domain: loc.domain,
                    component: loc.component,
                    parentFamily: parent.family,
                    beforeTupleMatch,
                    physicalSourceCodecMatch: training
                      ? physical.some(
                          (p) => p.id === parent.sourceId && p.version === parent.version,
                        )
                      : null,
                    runtimeSourceCodecMatch: training
                      ? runtime.some(
                          (p) => p.id === parent.sourceId && p.version === parent.version,
                        )
                      : null,
                  };
                }),
          );
          console.error('V38_SOURCE_LOCATION_DIAGNOSTIC ' + JSON.stringify(diagnostics));
          throw error;
        });
      const value = artifact.data,
        rendered = artifact.data;
      const old = value.manualSavedSourceRefs.find(
        (r) => r.identity.kind === 'plan-snapshot' && r.identity.sourceId === historical.id,
      );
      const current = value.manualSavedSourceRefs.find(
        (r) => r.identity.kind === 'plan-snapshot' && r.identity.sourceId === f.currentPlan.id,
      );
      expect(old?.location).toEqual({
        state: 'unavailable',
        reason: 'private_source_not_rendered',
      });
      expect(old?.identity).toEqual({
        kind: 'plan-snapshot',
        sourceId: historical.id,
        version: historical.version,
      });
      expect(current?.location.state).toBe('known');
      const chain = rendered.manualInternalChains[0];
      expect(chain?.body.state).toBe('present');
      if (
        !chain ||
        chain.body.state !== 'present' ||
        chain.body.planned.training.state !== 'present'
      )
        throw Error('FROZEN_TRAINING_MISSING');
      expect(chain.body.planned.training.members[0]?.before.ref).toEqual({
        versionId: f.currentPlan.id,
        version: f.currentPlan.version,
      });
      expect(chain.body.planned.training.members[0]?.before.plan).toEqual(f.currentPlan.draft);
      expect(await createPlanningRepository(db).readVersion(f.athlete, historical.id)).toEqual(
        historical,
      );
      expect(await auditCount(f.athlete)).toBe(beforeAudit + 1);
      expect(value.manualSourceChains.map((r) => r.evidenceId).sort()).toEqual(
        value.manualInternalChains.map((r) => r.evidenceId).sort(),
      );
    },
  );
});
