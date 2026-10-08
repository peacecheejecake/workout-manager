import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import {
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  type RoutineScheduleRule,
} from '@workout/contracts/routines';
import { projectRacePlanImpact } from '@workout/server-coaching/race-plan-impact';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceRepository } from '../src/races.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRoutineCore,
  grantRaces,
} from '../src/migrate.js';
import {
  routineScheduleReadManifestProjectionSchema,
  validateRoutineScheduleReadManifest,
} from '../src/race-plan-impact-routine-schedule-read-manifest.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Normal107 public producers. These are read correspondence tests, never approval,
// restore authority, or proof that a hypothetical calendar was persisted.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `routine_schedule_sources_${suffix}`;
const owner = `routine_schedule_sources_owner_${suffix}`;
const runtime = `routine_schedule_sources_app_${suffix}`;
const roles: string[] = [];
let created = false;
let db: Database;
function url(role: string) {
  const result = new URL(adminUrl);
  result.pathname = `/${name}`;
  result.username = role;
  result.password = 'isolated';
  return result.toString();
}
beforeAll(async () => {
  for (const role of [owner, runtime]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
  created = true;
  await migrate(url(owner));
  const inspector = new Pool({ connectionString: url(owner) });
  try {
    expect(
      (await inspector.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await inspector.end();
  }
  for (const grant of [grantCorePlanning, grantOperations, grantRoutineCore, grantRaces])
    await grant(url(owner), runtime);
  db = createDatabase({ connectionString: url(runtime), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
function draft(startTime: string | null = '09:00'): PlanDraft {
  return {
    title: 'Synthetic frozen calendar',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2026-11-01',
      endDateExclusive: '2026-12-01',
      timezone: 'UTC',
      intent: 'User chosen',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-11-02',
        localStartTime: startTime,
        title: 'Synthetic session',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}
async function seed(rule: RoutineScheduleRule, startTime: string | null = '09:00') {
  const athlete = randomUUID();
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const planning = createPlanningRepository(db),
    routine = createRoutineRepository(db);
  const plan = await planning.save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(startTime),
  });
  const blueprint = (
    await routine.saveBlueprint(athlete, {
      expectedVersionId: null,
      confirmed: true,
      idempotencyKey: randomUUID(),
      blueprint: {
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Synthetic checklist',
        intent: 'User chosen',
        status: 'published',
        tags: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-10-07T00:00:00.000Z',
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
  const input = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      window: {
        startDate: '2026-11-01',
        endDateExclusive: '2026-12-01',
        timezone: 'UTC',
        maxOccurrences: 10,
      },
      rule,
      state: 'draft' as const,
    },
    sourcePlanVersionId: plan.id,
  };
  const preview = await routine.previewSchedule(athlete, input);
  const approved = await routine.approveSchedule(athlete, {
    ...input,
    previewDigest: preview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  const races = createRaceRepository(db);
  const eventRef = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
      localDate: '2026-11-02',
      localStartTime: null,
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '5k' },
      priority: null,
      participation: 'considering',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: plan.id,
    },
  });
  return { athlete, planning, routine, plan, blueprint, approved, eventRef, races };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function projection(f: Fixture, move: boolean) {
  const current = (await f.planning.read(f.athlete)).head;
  if (!current) throw new Error('Missing public current plan');
  const source = await f.planning.readVersion(f.athlete, f.plan.id);
  const blueprint = await f.routine.readBlueprintVersion(f.athlete, f.blueprint.versionId);
  const event = await f.races.getRaceEvent(f.athlete, f.eventRef.id);
  if (!source || !blueprint || !event) throw new Error('Missing owned public source');
  const actual = await db.tenant(f.athlete, async (tx) => {
    const aggregateId = z
      .uuid()
      .parse(
        (
          await tx.query(
            'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND version_id=$2',
            [tx.athleteId, current.id],
          )
        ).rows[0]?.['aggregate_id'],
      );
    const row = z
      .strictObject({
        record_json: routineScheduleVersionSchema,
        version_id: z.uuid(),
        notification_muted: z.boolean(),
      })
      .parse(
        (
          await tx.query(
            'SELECT v.record_json,h.version_id,h.notification_muted FROM routine_schedule_version v JOIN routine_schedule_head h ON h.athlete_id=v.athlete_id AND h.schedule_id=v.schedule_id WHERE v.athlete_id=$1 AND v.version_id=$2',
            [tx.athleteId, f.approved.schedule.versionId],
          )
        ).rows[0],
      );
    return { aggregateId, row };
  });
  const selection = move
    ? {
        kind: 'move_period' as const,
        expectedCurrentPlanVersionId: current.id,
        periodId: 'season',
        newStartDate: '2026-11-03',
        scope: 'descendants_and_sessions' as const,
      }
    : { kind: 'keep_plan' as const };
  const calendar = projectRacePlanImpact({
    event: { localDate: event.localDate, planVersionId: event.planVersionId },
    newLocalDate: '2026-11-04',
    currentPlan: current,
    completionReports: [],
    selection,
  });
  if (calendar.status !== 'projected') throw new Error(`Calendar rejected: ${calendar.reason}`);
  const rule = actual.row.record_json.rule;
  const affected =
    source.id === current.id &&
    ((rule.kind === 'period_days' && calendar.periodDiffs.some((p) => p.id === rule.periodId)) ||
      (rule.kind === 'session_links' &&
        calendar.sessionDiffs.some((s) => rule.sessionIds.includes(s.id))));
  return routineScheduleReadManifestProjectionSchema.parse({
    athleteId: f.athlete,
    currentTraining: { aggregateId: actual.aggregateId, snapshot: current },
    sourcePlans: source.id === current.id ? [source] : [source, current],
    blueprints: [blueprint],
    schedules: [
      {
        scheduleId: actual.row.record_json.id,
        versionId: actual.row.record_json.versionId,
        sourcePlanVersionId: source.id,
        record: actual.row.record_json,
        currentHead: {
          state: 'present',
          versionId: actual.row.version_id,
          notificationMuted: actual.row.notification_muted,
        },
      },
    ],
    routines: [
      {
        aggregateId: actual.row.record_json.id,
        versionId: actual.row.record_json.versionId,
        record: actual.row.record_json,
        sourceVersionId: source.id,
        sourceRelation: source.id === current.id ? 'current' : 'historical',
        affected,
      },
    ],
    affectedRoutineIds: affected ? [actual.row.record_json.id] : [],
    calendarIntent: {
      athleteId: f.athlete,
      event,
      newLocalDate: '2026-11-04',
      selection,
      completionReports: [],
    },
  });
}

it('captures public period-days frozen sources and projects moved dates without writing occurrences', async () => {
  const f = await seed({
    kind: 'period_days',
    periodId: 'season',
    offsetsDays: [1],
    localTime: '08:00',
  });
  const before = await f.routine.readSchedule(f.athlete, f.approved.schedule.id);
  const input = await projection(f, true);
  const result = validateRoutineScheduleReadManifest(input);
  expect(result).toMatchObject({
    status: 'validated_read_scope',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    affectedRoutineIds: [f.approved.schedule.id],
  });
  expect(result.remaining).toHaveLength(5);
  expect(result.timings[0]?.before).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-11-02T08:00:00.000Z' }],
  });
  expect(result.timings[0]?.after).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-11-04T08:00:00.000Z' }],
  });
  expect(await f.routine.readSchedule(f.athlete, f.approved.schedule.id)).toEqual(before);
});
it('captures session-links and preserves started run/frozen blueprint after calendar and catalog changes', async () => {
  const f = await seed({
    kind: 'session_links',
    sessionIds: ['session'],
    point: 'end',
    offsetMinutes: 0,
  });
  const occurrence = f.approved.occurrences[0];
  if (!occurrence) throw new Error('Missing public occurrence');
  const started = await f.routine.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: f.blueprint.versionId,
    occurrenceId: occurrence.id,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await f.routine.saveBlueprint(f.athlete, {
    blueprint: {
      ...f.blueprint,
      versionId: randomUUID(),
      title: 'New independent catalog version',
    },
    expectedVersionId: f.blueprint.versionId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const result = validateRoutineScheduleReadManifest(await projection(f, true));
  expect(result.status).toBe('validated_read_scope');
  expect(result.timings[0]?.before).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-11-02T09:30:00.000Z' }],
  });
  expect(result.timings[0]?.after).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-11-04T09:30:00.000Z' }],
  });
  expect(await f.routine.readRun(f.athlete, started.run.id)).toEqual(started);
  expect((await f.routine.readSchedule(f.athlete, f.approved.schedule.id))?.occurrences).toEqual(
    f.approved.occurrences,
  );
});
it('reads exact historical Plan source after public head transition without re-pinning schedule', async () => {
  const f = await seed({
    kind: 'period_days',
    periodId: 'season',
    offsetsDays: [1],
    localTime: '08:00',
  });
  const nextDraft = structuredClone(f.plan.draft);
  nextDraft.title = 'New current plan';
  const session = planDraftSchema.parse(nextDraft).sessions[0];
  if (!session) throw new Error('Missing source session');
  nextDraft.sessions[0] = { ...session, date: '2026-11-05' };
  await f.planning.save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: f.plan.id,
    idempotencyKey: randomUUID(),
    draft: nextDraft,
  });
  const input = await projection(f, true);
  expect(input.routines[0]?.sourceRelation).toBe('historical');
  expect(input.schedules[0]?.sourcePlanVersionId).toBe(f.plan.id);
  const result = validateRoutineScheduleReadManifest(input);
  expect(result.status).toBe('validated_read_scope');
  expect(result.affectedRoutineIds).toEqual([]);
  expect(result.timings[0]?.after).toBeNull();
  expect(result.timings[0]?.before).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-11-02T08:00:00.000Z' }],
  });
});
it('preserves public unresolved session timing and distinguishes affected resolution requirement', async () => {
  const f = await seed(
    { kind: 'session_links', sessionIds: ['session'], point: 'end', offsetMinutes: 0 },
    null,
  );
  expect(f.approved.occurrences[0]?.scheduledAt).toBeNull();
  const unchanged = validateRoutineScheduleReadManifest(await projection(f, false));
  expect(unchanged.status).toBe('validated_read_scope');
  expect(unchanged.timings[0]?.notice).toBe('existing_unresolved_preserved');
  const affected = validateRoutineScheduleReadManifest(await projection(f, true));
  expect(affected.status).toBe('validated_read_scope');
  expect(affected.timings[0]?.notice).toBe('affected_unresolved_requires_resolution');
  expect(affected.timings[0]?.after).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: null, timingStatus: 'unresolved' }],
  });
  expect((await f.routine.readSchedule(f.athlete, f.approved.schedule.id))?.occurrences).toEqual(
    f.approved.occurrences,
  );
});
it('keeps populated foreign source bodies inaccessible and blocks missing exact sources', async () => {
  const f = await seed({
    kind: 'period_days',
    periodId: 'season',
    offsetsDays: [1],
    localTime: '08:00',
  });
  const other = randomUUID();
  expect(await f.planning.readVersion(other, f.plan.id)).toBeNull();
  expect(await f.routine.readBlueprintVersion(other, f.blueprint.versionId)).toBeNull();
  expect(await f.routine.readSchedule(other, f.approved.schedule.id)).toBeNull();
  await db.tenant(other, async (tx) => {
    expect(
      (
        await tx.query('SELECT record_json FROM routine_schedule_version WHERE version_id=$1', [
          f.approved.schedule.versionId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  const input = await projection(f, true);
  const absent = validateRoutineScheduleReadManifest({ ...input, sourcePlans: [] });
  expect(absent.status).toBe('blocked');
  expect(absent.blockers).toContainEqual(
    expect.objectContaining({ reason: 'source_plan_missing' }),
  );
  const foreign = validateRoutineScheduleReadManifest({
    ...input,
    calendarIntent: { ...input.calendarIntent, athleteId: other },
  });
  expect(foreign.blockers).toContainEqual({ path: 'calendarIntent', reason: 'foreign_source' });
});
it('rejects injected affected booleans without the real calendar intent and contradictory source tuples', async () => {
  const f = await seed({
    kind: 'period_days',
    periodId: 'season',
    offsetsDays: [1],
    localTime: '08:00',
  });
  const input = await projection(f, true);
  const { calendarIntent: _intent, ...withoutIntent } = input;
  expect(validateRoutineScheduleReadManifest(withoutIntent).blockers).toContainEqual({
    path: 'calendarIntent',
    reason: 'affected_selection_port_missing',
  });
  expect(
    validateRoutineScheduleReadManifest({
      ...input,
      schedules: input.schedules.map((s) => ({ ...s, sourcePlanVersionId: randomUUID() })),
    }).status,
  ).toBe('blocked');
  const missingBlueprint = validateRoutineScheduleReadManifest({ ...input, blueprints: [] });
  expect(missingBlueprint.blockers).toContainEqual(
    expect.objectContaining({ reason: 'blueprint_missing' }),
  );
});

it('retains a historical schedule version and its occurrences after public pause', async () => {
  const f = await seed({
    kind: 'period_days',
    periodId: 'season',
    offsetsDays: [1],
    localTime: '08:00',
  });
  const original = await projection(f, false);
  const paused = await f.routine.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    action: 'pause',
    expectedVersionId: f.approved.schedule.versionId,
    previewDigest: f.approved.impactDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(paused.schedule.versionId).not.toBe(f.approved.schedule.versionId);
  const source = original.schedules[0];
  const prior = original.routines[0];
  if (!source || !prior) throw new Error('Missing captured schedule');
  const currentHead = {
    state: 'present' as const,
    versionId: paused.schedule.versionId,
    notificationMuted: paused.notificationMuted,
  };
  const captured = {
    ...original,
    schedules: [
      { ...source, currentHead },
      {
        scheduleId: paused.schedule.id,
        versionId: paused.schedule.versionId,
        sourcePlanVersionId: paused.sourcePlanVersionId,
        record: paused.schedule,
        currentHead,
      },
    ],
    routines: [{ ...prior, versionId: paused.schedule.versionId, record: paused.schedule }],
  };
  const result = validateRoutineScheduleReadManifest(captured);
  expect(result.status).toBe('validated_read_scope');
  expect(result.timings).toHaveLength(2);
  expect(result.timings.every((t) => t.after === null)).toBe(true);
  await db.tenant(f.athlete, async (tx) => {
    expect(
      routineScheduleVersionSchema.parse(
        (
          await tx.query(
            'SELECT record_json FROM routine_schedule_version WHERE athlete_id=$1 AND version_id=$2',
            [tx.athleteId, f.approved.schedule.versionId],
          )
        ).rows[0]?.['record_json'],
      ),
    ).toEqual(f.approved.schedule);
  });
  expect(paused.schedule.state).toBe('paused');
  expect(paused.occurrences).toEqual([]);
  expect(paused.sourcePlanVersionId).toBe(f.approved.sourcePlanVersionId);
  const historicalOccurrences = await db.tenant(f.athlete, async (tx) =>
    (
      await tx.query(
        `SELECT record_json FROM routine_occurrence
         WHERE athlete_id=$1 AND schedule_id=$2 AND schedule_version_id=$3
         ORDER BY id`,
        [tx.athleteId, f.approved.schedule.id, f.approved.schedule.versionId],
      )
    ).rows.map((row) => routineOccurrenceSchema.parse(row['record_json'])),
  );
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  expect(historicalOccurrences).toEqual([...f.approved.occurrences].sort(byId));
  const current = await f.routine.readSchedule(f.athlete, paused.schedule.id);
  expect(current).toEqual(paused);
});
