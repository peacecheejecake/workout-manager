import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { previewRacePlanImpactTransaction } from '../src/race-plan-impact-preview.js';
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
import { prepareRaceManualReviewOwnedBindingV2In } from '../src/race-manual-review-owned-binding-consumer-v2.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
// Prepared real-DB acceptance; Root executes. normal107 + raw114 staging only.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createPlanningRepository } from '../src/planning.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  migrate,
  grantCorePlanning,
  grantSessionCompletions,
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
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `request_budget_${suffix}`,
  ownerRole = `request_budget_owner_${suffix}`,
  runtimeRole = `request_budget_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
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
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      await readFile(
        new URL('../migrations/114_manual_review_owned_source_bindings_v2.sql', import.meta.url),
        'utf8',
      ),
    );
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantSessionCompletions,
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
const draft = () =>
  planDraftSchema.parse({
    title: 'Synthetic plan',
    timezone: 'Asia/Seoul',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, array) => ({
      id: level,
      parentId: index === 0 ? null : array[index - 1],
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: null,
        title: 'Synthetic planned session',
        sport: 'running',
        durationSeconds: null,
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

async function grantApp(database: Database, athlete: string) {
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}
const raceValues = {
  title: 'Synthetic owned source race',
  localDate: '2026-10-06',
  localStartTime: '09:00',
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard' as const, class: '10k' as const },
  priority: null,
  participation: 'registered' as const,
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
};
async function coherentSources(database: Database, sessionId = 'session') {
  const athlete = randomUUID();
  await grantApp(database, athlete);
  const planning = createPlanningRepository(database),
    routines = createRoutineRepository(database),
    completions = createSessionCompletionRepository(database);
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(),
      sessions: draft().sessions.map((session) => ({ ...session, id: sessionId })),
    },
  });
  const race = await createRaceRepository(database).createRaceEvent(athlete, {
    values: { ...raceValues, planVersionId: plan.id },
    idempotencyKey: randomUUID(),
  });
  const nutrition = await createNutritionRepository(database).savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic retained source meal',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'meal',
          category: 'meal',
          title: 'Meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [],
          targets: [],
          instructions: 'Synthetic explicit meal',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const blueprint = (
    await routines.saveBlueprint(athlete, {
      blueprint: routineBlueprintVersionSchema.parse({
        schemaVersion: 4,
        routineId: plan.id,
        versionId: randomUUID(),
        title: 'Synthetic immutable checklist',
        intent: 'Read source',
        status: 'published',
        tags: [],
        steps: [
          {
            id: 'step',
            title: 'Check',
            content: { kind: 'checklist', prompt: 'Synthetic checklist' },
            timing: { kind: 'user_scheduled' },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
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
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: plan.id,
  };
  const preview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const occurrence = approved.occurrences[0];
  if (!occurrence) throw Error('FIXTURE_OCCURRENCE_ABSENT');
  const run = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const completion = await completions.write(athlete, sessionId, {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: plan.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  return {
    athlete,
    plan,
    race,
    nutrition,
    blueprint,
    approved,
    occurrence,
    run,
    completion,
    routines,
    completions,
    planning,
  };
}
async function snapshot<T>(
  database: Database,
  athlete: string,
  fn: (tx: Transaction) => Promise<T>,
) {
  const port = database.snapshotTenant;
  if (!port) throw Error('FIXTURE_SNAPSHOT_PORT_MISSING');
  return port(athlete, fn);
}

const cap = 4194304n;
const intent = (eventId: string) => ({
  expectedEvent: { id: eventId, revision: 1 },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
// Inherited counters represent earlier bounded source reservations, not fake
// database facts. All source queries below still run against public owned rows.
it('preliminary roots and the full collector share reservations and reject before the final root body', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const single: SourceBudget = { bytes: 0n, sources: 0 };
    await captureRacePlanImpactContext(
      tx,
      { eventId: f.race.id, expectedRevision: 1, selection: { kind: 'keep_plan' } },
      single,
    );
    expect(single.bytes).toBeGreaterThan(1024n);
    expect(single.bytes).toBeLessThan(cap / 2n);
    const budget: SourceBudget = { bytes: cap - single.bytes - 1024n, sources: 0 };
    const queries: string[] = [];
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries.push(sql);
        return tx.query(sql, values);
      },
    };
    await expect(
      previewRacePlanImpactTransaction(measured, intent(f.race.id), budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
    expect(
      queries.filter((sql) =>
        sql.trimStart().startsWith('SELECT id,revision,values_json FROM race_event WHERE'),
      ),
    ).toHaveLength(1);
    // The preliminary scalar includes a nested event SELECT, but transports no
    // root body. Count direct body reads separately from scalar preflights.
    expect(
      queries.filter((sql) => sql.includes('bodies AS (SELECT to_jsonb(e) AS body FROM event e')),
    ).toHaveLength(1);
    expect(
      queries.filter((sql) => sql.includes('WITH\n    nutrition AS MATERIALIZED')),
    ).toHaveLength(1);
    expect(budget.bytes).toBeGreaterThan(cap);
  });
});
it('owned scalar consumes earlier capture reservations and blocks body/observer transport', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const baseline: SourceBudget = { bytes: 0n, sources: 0 };
    let preOwned = 0n;
    const probe: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        if (sql.includes('manual_review_owned_v2 scalar') && preOwned === 0n)
          preOwned = baseline.bytes;
        return tx.query(sql, values);
      },
    };
    await prepareRaceManualReviewOwnedBindingV2In(probe, intent(f.race.id), baseline);
    expect(preOwned).toBeGreaterThan(0n);
    // Earlier work is charged at entry. Neither SQL inputs nor live counter state
    // changes at the stage barrier; scalar→body sees the natural remaining512.
    const budget: SourceBudget = { bytes: cap - preOwned - 512n, sources: 0 };
    const queries: string[] = [];
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries.push(sql);
        return tx.query(sql, values);
      },
    };
    await expect(
      prepareRaceManualReviewOwnedBindingV2In(measured, intent(f.race.id), budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
    expect(
      queries.filter((sql) =>
        sql.trimStart().startsWith('SELECT id,revision,values_json FROM race_event WHERE'),
      ),
    ).toHaveLength(2);
    expect(queries.some((sql) => sql.includes('manual_review_owned_v2 scalar'))).toBe(true);
    expect(queries.some((sql) => sql.includes('manual_review_owned_v2 body'))).toBe(false);
    expect(queries.some((sql) => sql.includes('manual_review_owned_binding_consumer_v2'))).toBe(
      false,
    );
  });
});
it('observer single-call response gate returns bounded NULL when the natural remaining response allowance is insufficient', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const baseline: SourceBudget = { bytes: 0n, sources: 0 };
    let preObserver = 0n;
    const probe: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        if (sql.includes('manual_review_owned_binding_consumer_v2')) preObserver = baseline.bytes;
        return tx.query(sql, values);
      },
    };
    await prepareRaceManualReviewOwnedBindingV2In(probe, intent(f.race.id), baseline);
    expect(preObserver).toBeGreaterThan(0n);
    const budget: SourceBudget = { bytes: cap - preObserver - 64n, sources: 0 };
    let calls = 0;
    let observed: unknown;
    let actualRemaining: unknown;
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        if (sql.includes('manual_review_owned_binding_consumer_v2')) {
          calls++;
          actualRemaining = values?.[1];
          observed = result.rows[0];
        }
        return result;
      },
    };
    await expect(
      prepareRaceManualReviewOwnedBindingV2In(measured, intent(f.race.id), budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
    expect(actualRemaining).toBe('64');
    expect(calls).toBe(1);
    expect(observed).toMatchObject({ observation: null, withinBudget: false });
    expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(2048);
  });
});
it('near-boundary normal public sources are reserved once, retain all authority limitations and do not mutate artifacts', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    const first: SourceBudget = { bytes: 0n, sources: 0 };
    const result = await prepareRaceManualReviewOwnedBindingV2In(tx, intent(f.race.id), first);
    if (result.status === 'blocked') throw Error('FIXTURE_PREPARATION_BLOCKED');
    expect(result).toMatchObject({
      budgetCoverage: 'request_source_response_reservations',
      aggregatePhysicalTransfer: 'not_verified',
      authority: 'none',
      admissionAllowed: false,
      storage: 'not_persisted',
    });
    const before = await tx.query(
      'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
      [f.athlete],
    );
    const inherited = cap - first.bytes - 512n;
    const near: SourceBudget = { bytes: inherited, sources: 0 };
    const second = await prepareRaceManualReviewOwnedBindingV2In(tx, intent(f.race.id), near);
    if (second.status === 'blocked') throw Error('FIXTURE_PREPARATION_BLOCKED');
    expect(second.status).toBe(result.status);
    expect(second.preparation.status).toBe(result.preparation.status);
    expect(second.sqlObservation).toEqual(result.sqlObservation);
    expect(second.owned).toEqual(result.owned);
    expect(near.bytes - inherited).toBe(first.bytes);
    expect(cap - near.bytes).toBe(512n);
    expect(
      await tx.query(
        'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
        [f.athlete],
      ),
    ).toEqual(before);
  });
});
it('oversized valid calendar intent rejects before SQL without charging local input as source-response bytes', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    let queries = 0;
    const budget: SourceBudget = { bytes: 0n, sources: 0 };
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    const largeIntent = {
      ...intent(f.race.id),
      resolutions: {
        nutrition: [],
        routines: Array.from({ length: 1000 }, (_, i) => ({
          scheduleVersionId: `schedule-${i}`,
          action: 'replace_rule',
          rule: {
            kind: 'dates',
            dates: Array.from({ length: 400 }, (_, day) =>
              new Date(Date.UTC(2026, 0, day + 1)).toISOString().slice(0, 10),
            ),
            localTime: '08:00',
          },
          window: {
            startDate: '2026-01-01',
            endDateExclusive: '2028-01-01',
            timezone: 'Asia/Seoul',
            maxOccurrences: 400,
          },
          sourcePlanVersionId: null,
        })),
      },
    };
    const parsed = raceProjectionIntentSchema.safeParse(largeIntent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw Error('FIXTURE_INVALID_INTENT');
    expect(Buffer.byteLength(JSON.stringify(parsed.data))).toBeGreaterThan(Number(cap));
    await expect(
      previewRacePlanImpactTransaction(measured, largeIntent, budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_LIMIT', bound: 'decoded_bytes' });
    expect(queries).toBe(0);
    expect(budget).toEqual({ bytes: 0n, sources: 0 });
    await expect(
      prepareRaceManualReviewOwnedBindingV2In(measured, largeIntent, budget),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
    expect(queries).toBe(0);
  });
});

it('direct optional budget ports reject negative and noninteger counters before SQL', async () => {
  const f = await coherentSources(db);
  await snapshot(db, f.athlete, async (tx) => {
    let queries = 0;
    const measured: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries++;
        return tx.query(sql, values);
      },
    };
    for (const budget of [
      { bytes: -1n, sources: 0 },
      { bytes: 0n, sources: -1 },
      { bytes: 0n, sources: 0.5 },
      { bytes: 0n, sources: NaN },
    ]) {
      await expect(
        captureRacePlanImpactContext(
          measured,
          { eventId: f.race.id, expectedRevision: 1, selection: { kind: 'keep_plan' } },
          budget,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
      await expect(
        previewRacePlanImpactTransaction(measured, intent(f.race.id), budget),
      ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
      await expect(
        prepareRaceManualReviewCompatibleV4In(measured, intent(f.race.id), budget),
      ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    }
    expect(queries).toBe(0);
  });
});
