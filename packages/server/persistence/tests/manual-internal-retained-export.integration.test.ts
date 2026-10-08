import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { raceManualInternalPersonalExportSchema } from '@workout/contracts/race-manual-internal-personal-export';
import { raceManualApprovalCommandSchema } from '@workout/contracts/race-manual-approval';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { grantCurrentRuntimeProfile } from '../src/current-runtime-grants.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
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
// Root-only real PG: normal107 + actual installed17 + explicit129/narrowEXECUTE.
// Public sources/chain/application APIs produce every body; owner identity FK only.
// Internal sources never constitute source authentication or restore permission.
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
describe('SQL129 internal retained enumeration', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `internal_retained_${suffix}`,
    ownerRole = `internal_retained_owner_${suffix}`,
    runtimeRole = `internal_retained_app_${suffix}`;
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
  async function fixture(allFour = false) {
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
    const intent = raceProjectionIntentSchema.parse({
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: plan.id,
        periodId: 'season',
        newStartDate: '2026-10-03',
        scope: 'descendants_and_sessions',
      },
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
    return {
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
  it('enumerates genuine chain-only parent without any122publicreceipt or plan application', async () => {
    const f = await fixture();
    expect(await publicReceiptCount(f.athlete)).toBe(0);
    const value = await read(f.athlete);
    expect(value.chains).toHaveLength(1);
    expect(value.chains[0]?.originalResult).toEqual(f.result);
    expect(value.chains[0]?.bodyState).toBe('present');
    expect(value.candidates).toEqual([]);
    expect(value.approvalResults).toEqual([]);
    expect(value.approvalHistory).toEqual([]);
    const rendered = renderRaceManualInternalPersonalExport(value);
    expect(raceManualInternalPersonalExportSchema.parse(rendered)).toEqual(rendered);
    expect(rendered.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
    expect(rendered.manualInternalChains[0]?.proposalApplied).toBe(false);
    const text = JSON.stringify(rendered);
    for (const privateField of [
      'sqlObservations',
      'dtoObservations',
      'currentAuthority',
      'receipt_key',
      'source_ref',
      'candidateDigest',
    ])
      expect(text).not.toContain(privateField);
  });
  it('retains thirteen genuine five-domain chain-only results under the aggregate byte bound without truncation', async () => {
    const f = await fixture(true);
    const repository = createRaceManualReviewChainV2Repository(db);
    const census = () =>
      snapshot(f.athlete, async (tx) =>
        z
          .strictObject({
            training: z.number().int(),
            nutrition: z.number().int(),
            recovery: z.number().int(),
            routines: z.number().int(),
          })
          .parse(
            (
              await tx.query(
                `SELECT (SELECT count(*)::int FROM public.plan_snapshot WHERE athlete_id=$1) AS training,
          (SELECT count(*)::int FROM public.nutrition_plan_version WHERE athlete_id=$1) AS nutrition,
          (SELECT count(*)::int FROM public.recovery_strategy_version WHERE athlete_id=$1) AS recovery,
          (SELECT count(*)::int FROM public.routine_schedule_version WHERE athlete_id=$1) AS routines`,
                [f.athlete],
              )
            ).rows[0],
          ),
      );
    const beforeCounts = await census();
    const results = [f.result];
    const keys = new Set([f.chainKey]);
    const initialReplay = await repository.store(f.athlete, {
      schemaVersion: 2,
      idempotencyKey: f.chainKey,
      intent: f.intent,
      expectedBasis: f.basis,
    });
    expect(initialReplay.status).toBe('replayed');
    if (initialReplay.status !== 'replayed') throw Error('ORIGINAL_RECEIPT_REQUIRED');
    expect(initialReplay.result).toEqual(f.result);
    for (let index = 1; index < 13; index++) {
      const idempotencyKey = randomUUID();
      keys.add(idempotencyKey);
      const command = {
        schemaVersion: 2,
        idempotencyKey,
        intent: f.intent,
        expectedBasis: f.basis,
      };
      const stored = await repository.store(f.athlete, command);
      if (stored.status !== 'stored') throw Error('INDEPENDENT_CHAIN_REQUIRED');
      results.push(stored.result);
      const replay = await repository.store(f.athlete, command);
      expect(replay.status).toBe('replayed');
      if (replay.status !== 'replayed') throw Error('ORIGINAL_RECEIPT_REQUIRED');
      expect(replay.result).toEqual(stored.result);
    }
    expect(keys.size).toBe(13);
    expect(new Set(results.flatMap((r) => [r.evidenceId, r.decisionId, r.proposalId])).size).toBe(
      39,
    );
    const value = await read(f.athlete);
    expect(value.chains).toHaveLength(13);
    expect(value.candidates).toEqual([]);
    expect(value.approvalResults).toEqual([]);
    expect(value.approvalHistory).toEqual([]);
    expect(await publicReceiptCount(f.athlete)).toBe(0);
    for (const original of results) {
      const chain = value.chains.find((row) => row.evidenceId === original.evidenceId);
      expect(chain?.originalResult).toEqual(original);
      expect(chain?.bodyState).toBe('present');
      const persisted = await repository.read(f.athlete, original.evidenceId);
      expect(persisted?.result).toEqual(original);
      expect(persisted?.payload?.state).toBe('present');
    }
    const rendered = renderRaceManualInternalPersonalExport(value);
    expect(raceManualInternalPersonalExportSchema.parse(rendered)).toEqual(rendered);
    expect(rendered.manualInternalChains).toHaveLength(13);
    expect(Buffer.byteLength(JSON.stringify(rendered), 'utf8')).toBeLessThan(8388608);
    const countJsonNodes = (value: unknown): number => {
      if (value === null || typeof value !== 'object') return 1;
      return (
        1 +
        Object.values(value).reduce<number>((sum, child: unknown) => sum + countJsonNodes(child), 0)
      );
    };
    // Source visits and JSON structural nodes are different budgets.
    expect(countJsonNodes(rendered)).toBeGreaterThan(5000);
    const first = rendered.manualInternalChains[0];
    if (first?.body.state !== 'present') throw Error('PRESENT_PLANNED_BODY_REQUIRED');
    expect(first.body.planned.expectedEvent).toEqual(f.intent.expectedEvent);
    for (const field of ['training', 'nutrition', 'recovery', 'routines'] as const) {
      expect(first.body.planned[field].state).toBe('present');
    }
    for (const chain of rendered.manualInternalChains) {
      expect(chain.proposalApplied).toBe(false);
      if (chain.body.state !== 'present') throw Error('PRESENT_PLANNED_BODY_REQUIRED');
      expect(chain.body.planned).toEqual(first.body.planned);
    }
    expect(await census()).toEqual(beforeCounts);
    const observed = await createRaceManualSemanticBasisV2Service(db).prepare(f.athlete, f.intent);
    if (observed.status !== 'current_dependencies_captured') throw Error('CURRENT_HEADS_REQUIRED');
    expect(observed.basis.heads).toEqual(f.basis.heads);
    expect(observed.basis.currentTraining).toEqual(f.basis.currentTraining);
    expect(observed.basis.event).toEqual(f.basis.event);
  }, 60000);
  it('enumerates actual internal ready candidate with exact frozen parent and no public reference', async () => {
    const f = await fixture(),
      candidate = await application(f);
    expect(await publicReceiptCount(f.athlete)).toBe(0);
    const value = await read(f.athlete);
    expect(value.candidates).toHaveLength(1);
    expect(value.candidates[0]?.candidate).toEqual(candidate);
    expect(value.candidates[0]?.chain).toEqual({
      evidenceId: f.result.evidenceId,
      decisionId: f.result.decisionId,
      proposalId: f.result.proposalId,
    });
    const rendered = renderRaceManualInternalPersonalExport(value);
    expect(rendered.manualInternalCandidates[0]?.body).toMatchObject({
      state: 'present',
      storedApplicationState: 'ready_for_explicit_approval',
    });
    expect(value.approvalResults).toEqual([]);
  });
  it('retains actual all-four original result and exact central history without creating public command aliases', async () => {
    const f = await fixture(true),
      candidate = await application(f),
      approval = createRaceManualApprovalRepository(db);
    const command = raceManualApprovalCommandSchema.parse({
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      raceChange: candidate.raceChange,
      expectation: candidate.expectation,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    const committed = await approval.approve(f.athlete, command);
    if (committed.status !== 'committed') throw Error('ORIGINAL_APPROVAL_REQUIRED');
    expect(new Set(committed.versions.map((row) => row.domain))).toEqual(
      new Set(['training', 'nutrition', 'recovery', 'routine_schedule']),
    );
    expect(await approval.approve(f.athlete, { ...command, idempotencyKey: randomUUID() })).toEqual(
      committed,
    );
    expect(await publicReceiptCount(f.athlete)).toBe(0);
    const value = await read(f.athlete);
    expect(value.approvalResults).toEqual([committed]);
    expect(value.approvalHistory).toHaveLength(4);
    expect(new Set(value.approvalHistory.map((row) => row.domain))).toEqual(
      new Set(committed.versions.map((row) => row.domain)),
    );
    const rendered = renderRaceManualInternalPersonalExport(value);
    expect(rendered.manualInternalApprovalResults).toEqual([committed]);
    expect(rendered.manualInternalChains[0]?.proposalApplied).toBe(false);
    expect(value.chains[0]?.originalResult).toEqual(f.result);
  });
  it('genuine source deletion nulls both parent and candidate while preserving original results/history and µs', async () => {
    const f = await fixture(),
      candidate = await application(f);
    const command = raceManualApprovalCommandSchema.parse({
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      raceChange: candidate.raceChange,
      expectation: candidate.expectation,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    const result = await createRaceManualApprovalRepository(db).approve(f.athlete, command);
    if (result.status !== 'committed') throw Error('APPROVAL_REQUIRED');
    const before = await read(f.athlete);
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      expectedRevision: result.race.revision,
      idempotencyKey: randomUUID(),
    });
    const after = await read(f.athlete);
    expect(after.chains[0]).toMatchObject({
      bodyState: 'purged',
      preparation: null,
      originalResult: f.result,
    });
    expect(after.candidates[0]).toMatchObject({ bodyState: 'purged', candidate: null });
    expect(after.candidates[0]?.purge).toEqual(after.chains[0]?.purge);
    expect(after.chains[0]?.purge?.purgedAt).toMatch(/\.\d{6}Z$/);
    expect(after.approvalResults).toEqual(before.approvalResults);
    expect(after.approvalHistory).toEqual(before.approvalHistory);
    expect(
      renderRaceManualInternalPersonalExport(after).manualInternalCandidates[0]?.body.state,
    ).toBe('purged');
  });
  it('retained read survives app withdrawal and frozen source presentation does not repin current heads', async () => {
    const f = await fixture();
    const before = await read(f.athlete);
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await read(f.athlete)).toEqual(before);
    expect(renderRaceManualInternalPersonalExport(before).sourceProvenanceCoverage).toBe(
      'not_exported_policy_unresolved',
    );
  });
  it('genuine foreign tenant remains empty and erased tenant cannot enumerate retained facts', async () => {
    const f = await fixture(),
      other = await tenant();
    expect(await read(other)).toEqual({
      schemaVersion: 1,
      chains: [],
      candidates: [],
      approvalResults: [],
      approvalHistory: [],
    });
    await createOperationsRepository(db).eraseAccount(f.athlete);
    await expect(read(f.athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
  it('rejects RC/invalidbound/scalar undersized budget without a partial family', async () => {
    const f = await fixture();
    await expect(
      db.tenant(f.athlete, (tx) =>
        tx.query('SELECT public.read_manual_race_internal_personal_export_v1(8388608)'),
      ),
    ).rejects.toThrow('MANUAL_INTERNAL_EXPORT_SNAPSHOT_REQUIRED');
    await expect(read(f.athlete, 0)).rejects.toThrow('MANUAL_INTERNAL_EXPORT_INVALID_BOUND');
    await expect(read(f.athlete, 1)).rejects.toThrow('MANUAL_INTERNAL_EXPORT_TOO_LARGE');
    expect((await read(f.athlete)).chains).toHaveLength(1);
  });
  it('keeps RPC owner/ACL finite, forbids private runtime SELECT and owner caller impersonation', async () => {
    const f = await fixture();
    const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
    try {
      const metadata = z
        .object({ owner: z.string(), prosecdef: z.boolean(), public_execute: z.boolean() })
        .parse(
          (
            await owner.query(
              "SELECT pg_get_userbyid(proowner) AS owner,prosecdef,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc WHERE oid='public.read_manual_race_internal_personal_export_v1(integer)'::regprocedure",
            )
          ).rows[0],
        );
      expect(metadata).toEqual({ owner: ownerRole, prosecdef: true, public_execute: false });
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await owner.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
      await expect(
        owner.query('SELECT public.read_manual_race_internal_personal_export_v1(8388608)'),
      ).rejects.toMatchObject({ code: '42501' });
      await owner.query('ROLLBACK');
    } finally {
      await owner.end();
    }
    await expect(
      db.tenant(f.athlete, (tx) => tx.query('SELECT * FROM public.manual_race_evidence_v2')),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('observes one coherent retained preimage while public deletion waits at actual snapshot fence', async () => {
    const f = await fixture();
    let entered: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const deletionDb: Database = {
      ...db,
      tenant: (id, operation) =>
        db.tenant(id, (tx) =>
          operation({
            athleteId: tx.athleteId,
            query: (sql, values) => {
              if (sql.includes('pg_advisory_xact_lock(hashtextextended($1,0))')) entered?.();
              return tx.query(sql, values);
            },
          }),
        ),
    };
    let deletion: Promise<unknown> | undefined;
    let deletionFailure: unknown;
    try {
      await snapshot(f.athlete, async (tx) => {
        const capture = async () =>
          raceManualInternalPersonalExportSourceSchema.parse(
            (
              await tx.query(
                'SELECT public.read_manual_race_internal_personal_export_v1(8388608) AS source',
              )
            ).rows[0]?.['source'],
          );
        const before = await capture();
        deletion = createRaceRepository(deletionDb)
          .deleteRaceEvent(f.athlete, f.event.id, {
            expectedRevision: f.event.revision,
            idempotencyKey: randomUUID(),
          })
          .catch((error: unknown) => {
            deletionFailure = error;
            entered?.();
          });
        await queued;
        expect(await capture()).toEqual(before);
        expect(before.chains[0]?.bodyState).toBe('present');
      });
    } finally {
      // Snapshot failure must release its lock before awaiting the queued writer.
      await deletion;
    }
    if (deletionFailure !== undefined) throw deletionFailure;
    expect((await read(f.athlete)).chains[0]?.bodyState).toBe('purged');
  });
});
