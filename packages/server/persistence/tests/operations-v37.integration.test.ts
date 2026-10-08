import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountExportV37Schema } from '@workout/contracts/operations';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntimeV3 } from '../src/current-runtime-installation-v3.js';
import { grantCurrentRuntimeV3Profile } from '../src/current-runtime-grants-v3.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createOperationsV37Repository } from '../src/operations.js';
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
describe('V37 coherent retained personal export', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `operations_v37_${suffix}`,
    ownerRole = `operations_v37_owner_${suffix}`,
    runtimeRole = `operations_v37_app_${suffix}`;
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
    await installCurrentRuntimeV3(url(ownerRole));
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
  async function reviewFixture(allFour = false) {
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
    const plan = await createPlanningRepository(db).save(athlete, {
      source: 'manual',
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      draft,
    });
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
    const value = await createOperationsV37Repository(observedDb).exportAccount(f.athlete);
    expect(rpcLimits).toHaveLength(3);
    expect(rpcLimits[2]).toBeLessThan(rpcLimits[1] ?? 0);
    expect(rpcLimits[0]).toBeLessThan(8388608);
    expect(rpcLimits[1]).toBeLessThan(rpcLimits[0] ?? 0);
    expect(accountExportV37Schema.parse(value)).toEqual(value);
    expect(value.data.manualInternalChains).toHaveLength(1);
    expect(value.data.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
    expect(value.schemaVersion).toBe(37);
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
  });
  it('exports source-purged contentless review and original successful receipt', async () => {
    const f = await reviewFixture(),
      repo = createOperationsV37Repository(db);
    const before = await repo.exportAccount(f.athlete);
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
    expect(await auditCount(f.athlete)).toBe(2);
  });
  it('does not expose another tenant retained records and refuses RC fallback before any query', async () => {
    const f = await reviewFixture(),
      other = await tenant();
    const empty = await createOperationsV37Repository(db).exportAccount(other);
    expect(empty.data.manualRaceReviews).toEqual([]);
    expect(empty.data.manualInternalChains).toEqual([]);
    expect(empty.data.manualInternalCandidates).toEqual([]);
    expect(empty.data.checkInTemplateVersions).toEqual([]);
    const noSnapshot: Database = {
      tenant: db.tenant,
      exclusiveTenant: db.exclusiveTenant,
      close: async () => {},
    };
    expect(() => createOperationsV37Repository(noSnapshot).exportAccount(f.athlete)).toThrow(
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
      createOperationsV37Repository(rollbackDatabase).exportAccount(athlete),
    ).rejects.toThrow('FORCED_EXPORT_ROLLBACK');
    expect(await auditCount(athlete)).toBe(0);
  });
  it('unavailable reader aborts the entire export without recording success or fabricating empty sets', async () => {
    const athlete = await tenant(),
      owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION public.read_manual_race_internal_personal_export_v1(integer) FROM "${runtimeRole}"`,
      );
      await expect(createOperationsV37Repository(db).exportAccount(athlete)).rejects.toThrow(
        'UNSUPPORTED',
      );
      expect(await auditCount(athlete)).toBe(0);
    } finally {
      await owner.query(
        `GRANT EXECUTE ON FUNCTION public.read_manual_race_internal_personal_export_v1(integer) TO "${runtimeRole}"`,
      );
      await owner.end();
    }
  });
  it('refuses retained export after genuine account erasure', async () => {
    const athlete = await tenant();
    const operations = createOperationsV37Repository(db);
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
    const value = await createOperationsV37Repository(db).exportAccount(f.athlete);
    expect(accountExportV37Schema.parse(value)).toEqual(value);
    expect(value.data.manualInternalChains).toHaveLength(1);
    expect(value.data.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
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
    const value = await createOperationsV37Repository(db).exportAccount(f.athlete);
    expect(value.data.manualRaceReviews).toHaveLength(1);
    expect(value.data.manualInternalChains).toHaveLength(2);
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
    const exporting = createOperationsV37Repository(readerDb).exportAccount(athlete);
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
    const next = await createOperationsV37Repository(db).exportAccount(athlete);
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
    await createOperationsV37Repository(observed).exportAccount(f.athlete);
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
    await expect(createOperationsV37Repository(db).exportAccount(f.athlete)).rejects.toThrow(
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
    await expect(createOperationsV37Repository(db).exportAccount(athlete)).rejects.toThrow(
      'EXPORT_TOO_LARGE',
    );
    expect(await auditCount(athlete)).toBe(0);
  }, 120000);
});
