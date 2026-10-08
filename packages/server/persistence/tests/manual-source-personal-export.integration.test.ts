import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { installCurrentRuntimeV3 } from '../src/current-runtime-installation-v3.js';
import { grantCurrentRuntimeV3Profile } from '../src/current-runtime-grants-v3.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { readFile } from 'node:fs/promises';
import { readManualSourcePersonalExportV1In } from '../src/manual-source-personal-export.js';
import { readRaceManualInternalPersonalExportV1In } from '../src/race-manual-internal-personal-export-reader.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { createNutritionRacePlanV4Writer } from '../src/nutrition-race-plan-v4-writer.js';
import { createNutritionPlanV4Reader, createNutritionRepository } from '../src/nutrition-core.js';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
import type { NutritionPlanVersionCompatibleV4 } from '@workout/contracts/nutrition-race-plan-v4';
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
describe('SQL130 saved provenance and SQL110 lineage personal facts', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `source_personal_export_${suffix}`,
    ownerRole = `source_personal_export_owner_${suffix}`,
    runtimeRole = `source_personal_export_app_${suffix}`;
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
      await owner.query(
        await readFile(
          new URL('../migrations/130_retained_source_provenance_export.sql', import.meta.url),
          'utf8',
        ),
      );
      for (const fn of [
        'read_manual_race_source_personal_export_v1',
        'read_nutrition_disconnection_personal_export_v1',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION public.${fn}(integer) TO "${runtimeRole}"`);
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
  async function counts(athlete: string) {
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query('BEGIN READ ONLY');
      await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const result = await owner.query(
        `SELECT (SELECT count(*)::text FROM public.outbox WHERE athlete_id=$1) AS outbox,
        (SELECT count(*)::text FROM public.operations_audit WHERE athlete_id=$1) AS audit,
        (SELECT count(*)::text FROM public.manual_race_evidence_v2 WHERE athlete_id=$1) AS evidence,
        (SELECT count(*)::text FROM public.manual_race_chain_commit_v2 WHERE athlete_id=$1) AS receipt`,
        [athlete],
      );
      await owner.query('COMMIT');
      return result.rows;
    } finally {
      await owner.end();
    }
  }
  function read(athlete: string, bytes = 8388608) {
    return snapshot(athlete, (tx) => readManualSourcePersonalExportV1In(tx, bytes));
  }
  it('exports all saved refs and many-to-many parents with known frozen planned locations, no private paths', async () => {
    const f = await reviewFixture(true);
    const beforeCounts = await counts(f.athlete);
    const value = await read(f.athlete);
    expect(await counts(f.athlete)).toEqual(beforeCounts);
    expect(value.manualSourceChains).toHaveLength(1);
    expect(value.manualSavedSourceRefs.length).toBe(value.manualSourceChains[0]?.savedRefCount);
    expect(value.manualSavedSourceParents.length).toBe(
      value.manualSourceChains[0]?.savedParentCount,
    );
    expect(
      value.manualSavedSourceRefs.some(
        (r) => r.identity.kind === 'nutrition-plan-version' && r.location.state === 'known',
      ),
    ).toBe(true);
    expect(
      value.manualSavedSourceRefs.some(
        (r) => r.identity.kind === 'race-event' && r.location.state === 'known',
      ),
    ).toBe(true);
    expect(value.manualSavedSourceSuppressions).toEqual([]);
    expect(value.sourceAuthentication).toBe('not_authenticated');
    expect(JSON.stringify(value)).not.toContain('copiedLocations');
    expect(JSON.stringify(value)).not.toContain('sql_relations');
    expect(JSON.stringify(value)).not.toContain('payload');
  });
  it.each(['historical-session', 'shared-session'])(
    'keeps historical nutrition copied training %s private and identifies only the frozen current before',
    async (sessionId) => {
      const f = await reviewFixture(false, sessionId);
      const historical = f.historicalPlan;
      if (!historical) throw Error('HISTORICAL_FIXTURE_MISSING');
      const beforeCounts = await counts(f.athlete);
      const [value, rendered] = await snapshot(
        f.athlete,
        async (tx) =>
          [
            await readManualSourcePersonalExportV1In(tx),
            await readRaceManualInternalPersonalExportV1In(tx),
          ] as const,
      );
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
      expect(await counts(f.athlete)).toEqual(beforeCounts);
    },
  );
  it.each(['historical-session', 'shared-session'])(
    'exports genuine ended routine %s historical sources without claiming current before membership',
    async (sessionId) => {
      const f = await reviewFixture(false, sessionId, 'ended_routine');
      const old = f.historicalPlan;
      if (!old) throw Error('HISTORICAL_FIXTURE_MISSING');
      const value = await read(f.athlete);
      expect(
        value.manualSavedSourceRefs.find(
          (r) => r.identity.kind === 'plan-snapshot' && r.identity.sourceId === old.id,
        )?.location,
      ).toEqual({ state: 'unavailable', reason: 'private_source_not_rendered' });
      expect(
        value.manualSavedSourceRefs.find(
          (r) => r.identity.kind === 'plan-snapshot' && r.identity.sourceId === f.currentPlan.id,
        )?.location.state,
      ).toBe('known');
      expect(await createPlanningRepository(db).readVersion(f.athlete, old.id)).toEqual(old);
    },
  );
  it('retains all refs after genuine race deletion and exposes only matched original deletion facts', async () => {
    const f = await reviewFixture(true),
      before = await read(f.athlete);
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      expectedRevision: f.event.revision,
      idempotencyKey: randomUUID(),
    });
    const after = await read(f.athlete);
    expect(after.manualSavedSourceRefs.length).toBe(before.manualSavedSourceRefs.length);
    expect(after.manualSavedSourceParents).toEqual(before.manualSavedSourceParents);
    expect(after.manualSourceChains[0]?.body.state).toBe('purged');
    expect(
      after.manualSavedSourceRefs.every(
        (r) => r.location.state === 'unavailable' && r.location.reason === 'payload_purged',
      ),
    ).toBe(true);
    expect(
      after.manualSavedSourceSuppressions.some(
        (r) => r.kind === 'race_event_deleted' && r.matchedRefOrdinals.length > 0,
      ),
    ).toBe(true);
    expect(after.nutritionDisconnectionOrigins.length).toBeGreaterThan(0);
  });
  it('keeps retained reads after app withdrawal and never exposes another tenant rows', async () => {
    const f = await reviewFixture(true),
      before = await read(f.athlete);
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await read(f.athlete)).toEqual(before);
    const other = await tenant();
    const empty = await read(other);
    expect(empty.manualSourceChains).toEqual([]);
    expect(empty.manualSavedSourceRefs).toEqual([]);
    expect(empty.nutritionDisconnectionOrigins).toEqual([]);
  });
  it('rejects genuine erased tenant and bounded source overflow rather than fabricating empty arrays', async () => {
    const f = await reviewFixture(true);
    await expect(read(f.athlete, 1024)).rejects.toThrow('TOO_LARGE');
    await createOperationsRepository(db).eraseAccount(f.athlete);
    await expect(read(f.athlete)).rejects.toThrow('ACCOUNT_ERASED');
  });
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
    const initial = await read(f.athlete);
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
    const value = await read(f.athlete);
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
    const deleted = await read(f.athlete);
    expect(deleted.nutritionDisconnectionOrigins).toEqual(
      expect.arrayContaining(initial.nutritionDisconnectionOrigins),
    );
    expect(deleted.nutritionDisconnectionLineage).toEqual(value.nutritionDisconnectionLineage);
  });
  it('reserves escaped opaque item-ID JSON bytes before origin aggregation', async () => {
    const f = await reviewFixture(false);
    const itemId = '"\\'.repeat(2000);
    await createNutritionRacePlanWriter(db).savePlanV2(f.athlete, {
      schemaVersion: 2,
      command: {
        kind: 'create',
        idempotencyKey: randomUUID(),
        confirmed: true,
        draft: {
          period: { from: '2026-10-01', toInclusive: '2026-10-31' },
          timezone: 'UTC',
          purpose: 'Escaped ID',
          linkedTrainingPlanVersionId: null,
          items: [
            {
              id: itemId,
              category: 'before',
              title: 'Opaque ID',
              anchor: {
                kind: 'relative',
                entity: 'race',
                entityId: f.event.id,
                point: 'start',
                offsetMinutes: 0,
              },
              foods: [],
              targets: [],
              instructions: 'Explicit user action',
              evidenceIds: [],
              source: 'user_confirmed',
            },
          ],
        },
      },
      expectedRaceHeads: [
        { namespace: 'race-event', eventId: f.event.id, revision: f.event.revision },
      ],
    });
    await f.races.deleteRaceEvent(f.athlete, f.event.id, {
      expectedRevision: f.event.revision,
      idempotencyKey: randomUUID(),
    });
    // 4,000 unescaped UTF8 bytes fit this bound; encoded quotes/backslashes do not.
    expect(Buffer.byteLength(itemId, 'utf8') + 512 + 1024).toBeLessThan(6000);
    expect(Buffer.byteLength(JSON.stringify(itemId), 'utf8') + 512 + 1024).toBeGreaterThan(6000);
    let responses = 0;
    await expect(
      snapshot(f.athlete, async (tx) => {
        const result = await tx.query(
          'SELECT public.read_nutrition_disconnection_personal_export_v1($1::integer) AS source',
          [6000],
        );
        responses++;
        return result;
      }),
    ).rejects.toThrow('MANUAL_SOURCE_EXPORT_TOO_LARGE');
    expect(responses).toBe(0);
    expect((await read(f.athlete)).nutritionDisconnectionOrigins[0]?.itemId).toBe(itemId);
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
    const exporting = snapshot(f.athlete, (tx) =>
      readManualSourcePersonalExportV1In({
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
    ).then(
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
    expect(old.value.manualSourceChains[0]?.body.state).toBe('present');
    expect(old.value.manualSavedSourceSuppressions).toEqual([]);
    const next = await read(f.athlete);
    expect(next.manualSourceChains[0]?.body.state).toBe('purged');
    expect(
      next.manualSavedSourceRefs.map((r) => ({ ordinal: r.ordinal, identity: r.identity })),
    ).toEqual(
      old.value.manualSavedSourceRefs.map((r) => ({ ordinal: r.ordinal, identity: r.identity })),
    );
    expect(next.manualSavedSourceSuppressions).toHaveLength(1);
    expect(next.nutritionDisconnectionOrigins).toHaveLength(1);
  });
  it('has no PUBLIC execute/private table grants and refuses RC reads', async () => {
    const f = await reviewFixture();
    await expect(
      db.tenant(f.athlete, (tx) => readManualSourcePersonalExportV1In(tx)),
    ).rejects.toThrow('CORRUPT');
    await expect(
      db.tenant(f.athlete, (tx) =>
        tx.query('SELECT * FROM public.manual_race_chain_source_ref_v2 LIMIT 1'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      const metadata = await owner.query(
        `SELECT NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid IN ('public.read_manual_race_source_personal_export_v1(integer)'::regprocedure,'public.read_nutrition_disconnection_personal_export_v1(integer)'::regprocedure) AND a.grantee=0 AND a.privilege_type='EXECUTE') AS safe`,
      );
      expect(metadata.rows[0]?.['safe']).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
