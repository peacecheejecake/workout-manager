import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations, grantRoutineCore } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// M202-P1-04: pause → resume must leave the resumed active version with runnable future
// occurrences. Public normal107 producers plus raw SQL121 (version-scoped anchors) on an
// isolated database, exercised through a NOSUPERUSER/NOBYPASSRLS runtime role. A second
// isolated database stays at normal107 to prove the fail-closed refusal there.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const names = { versioned: `routine_resume_${suffix}`, normal: `routine_resume_n107_${suffix}` };
const ownerRole = `routine_resume_owner_${suffix}`,
  runtimeRole = `routine_resume_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
const created: string[] = [];
let versioned: Database, normal: Database;
function url(database: string, role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function install(database: string, withVersionedOccurrences: boolean) {
  await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  created.push(database);
  await migrate(url(database, ownerRole), 107);
  if (withVersionedOccurrences) {
    const owner = new Pool({ connectionString: url(database, ownerRole) });
    try {
      await owner.query(
        await readFile(
          new URL('../migrations/121_routine_versioned_occurrences.sql', import.meta.url),
          'utf8',
        ),
      );
    } finally {
      await owner.end();
    }
  }
  for (const grant of [grantCorePlanning, grantOperations, grantRoutineCore])
    await grant(url(database, ownerRole), runtimeRole);
  return createDatabase({ connectionString: url(database, runtimeRole), max: 4 });
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  versioned = await install(names.versioned, true);
  normal = await install(names.normal, false);
});
afterAll(async () => {
  await versioned?.close();
  await normal?.close();
  for (const database of created) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('FIXTURE_VALUE_MISSING');
  return value;
}
const dayMs = 86_400_000;
const utcDate = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);

/** Local calendar date `offsetDays` from today in `timezone` (same Intl rule as the server). */
function localDate(timezone: string, offsetDays = 0) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const today = Date.parse(`${parts['year']}-${parts['month']}-${parts['day']}T00:00:00.000Z`);
  return new Date(today + offsetDays * dayMs).toISOString().slice(0, 10);
}
/** Approved and paused schedule; by default one past anchor and two future anchors. */
async function setup(
  db: Database,
  options: { timezone: string; localTime: string | null; dates: string[] } = {
    timezone: 'UTC',
    localTime: '07:00',
    dates: [utcDate(-2), utcDate(3), utcDate(4)],
  },
) {
  const athlete = randomUUID();
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic checklist',
    intent: 'Manual',
    status: 'published',
    tags: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-08T00:00:00Z',
    steps: [
      {
        id: 'check',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Checked?' },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
  });
  const repository = createRoutineRepository(db);
  await repository.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const { dates } = options;
  const sorted = [...dates].sort();
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: required(sorted[0]),
      endDateExclusive: new Date(Date.parse(`${required(sorted.at(-1))}T00:00:00.000Z`) + dayMs)
        .toISOString()
        .slice(0, 10),
      timezone: options.timezone,
      maxOccurrences: dates.length,
    },
    rule: { kind: 'dates', dates, localTime: options.localTime },
    state: 'draft',
  });
  const preview = await repository.previewSchedule(athlete, {
    schedule,
    sourcePlanVersionId: null,
  });
  const approved = await repository.approveSchedule(athlete, {
    schedule,
    sourcePlanVersionId: null,
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(approved.occurrences.map((o) => o.anchorKey)).toEqual(dates);
  const pause = () =>
    repository.changeSchedule(athlete, {
      scheduleId: approved.schedule.id,
      expectedVersionId: approved.schedule.versionId,
      action: 'pause',
      previewDigest: approved.impactDigest,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  return { athlete, blueprint, repository, approved, dates, pause };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function start(f: Fixture, occurrenceId: string) {
  return f.repository.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: f.blueprint.versionId,
    occurrenceId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
}
async function occurrenceRows(db: Database, f: Fixture) {
  return db.tenant(
    f.athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT id,schedule_version_id,record_json FROM routine_occurrence WHERE athlete_id=$1 AND schedule_id=$2 ORDER BY id',
          [f.athlete, f.approved.schedule.id],
        )
      ).rows,
  );
}

it('approve → pause → resume stores future occurrences of the new version that can start a run', async () => {
  const f = await setup(versioned);
  const original = await occurrenceRows(versioned, f);
  const paused = await f.pause();
  expect(paused.schedule.state).toBe('paused');
  expect(paused.occurrences).toEqual([]);

  const preview = await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id);
  expect(preview.schedule).toMatchObject({ id: f.approved.schedule.id, state: 'active' });
  expect(preview.schedule.versionId).not.toBe(paused.schedule.versionId);
  // Finite, future only: the past anchor is not re-materialized.
  expect(preview.occurrences.map((o) => o.anchorKey)).toEqual(f.dates.slice(1));
  expect(
    preview.occurrences.every(
      (o) =>
        o.schedule.versionId === preview.schedule.versionId &&
        !f.approved.occurrences.some((old) => old.id === o.id),
    ),
  ).toBe(true);
  // Previewing twice is stable; nothing is written by the preview.
  expect(await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id)).toEqual(
    preview,
  );
  expect(await occurrenceRows(versioned, f)).toEqual(original);

  const resume = {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: paused.schedule.versionId,
    action: 'resume' as const,
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  // The paused schedule read is not a confirmation of the resumed occurrences.
  await expect(
    f.repository.changeSchedule(f.athlete, {
      ...resume,
      previewDigest: paused.impactDigest,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'STALE_SCHEDULE_PREVIEW' });
  const resumed = await f.repository.changeSchedule(f.athlete, resume);
  expect(await f.repository.changeSchedule(f.athlete, resume)).toEqual(resumed);
  expect(resumed.schedule).toEqual(preview.schedule);
  expect(resumed.occurrences).toEqual(preview.occurrences);

  const current = required(await f.repository.readSchedule(f.athlete, f.approved.schedule.id));
  expect(current).toEqual(resumed);
  expect(current.occurrences).toHaveLength(2);
  // Earlier version's occurrences are preserved unchanged.
  const rows = await occurrenceRows(versioned, f);
  expect(rows.filter((row) => original.some((old) => old['id'] === row['id']))).toEqual(original);
  expect(rows).toHaveLength(original.length + 2);

  const occurrence = required(current.occurrences[0]);
  const run = await start(f, occurrence.id);
  expect(run.run.origin).toEqual({ kind: 'planned', occurrenceId: occurrence.id });
  // An occurrence of the originally approved version is refused.
  await expect(start(f, required(f.approved.occurrences[2]).id)).rejects.toMatchObject({
    code: 'OCCURRENCE_UNAVAILABLE',
  });
  // Resuming an already active schedule is not a transition.
  await expect(
    f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id),
  ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE_TRANSITION' });
});

it('keeps a run started before pause and does not re-materialize its anchor', async () => {
  const f = await setup(versioned);
  const startedOccurrence = required(f.approved.occurrences[1]);
  const run = await start(f, startedOccurrence.id);
  const paused = await f.pause();
  const preview = await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id);
  expect(preview.occurrences.map((o) => o.anchorKey)).toEqual([f.dates[2]]);
  const resumed = await f.repository.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: paused.schedule.versionId,
    action: 'resume',
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(resumed.occurrences.map((o) => o.anchorKey)).toEqual([f.dates[2]]);
  expect(await f.repository.readRun(f.athlete, run.run.id)).toEqual(run);
  expect((await start(f, required(resumed.occurrences[0]).id)).run.origin).toMatchObject({
    kind: 'planned',
  });
});

it('rejects a resume whose preview went stale after a second pause/resume cycle', async () => {
  const f = await setup(versioned);
  const paused = await f.pause();
  const first = await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id);
  const resumed = await f.repository.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: paused.schedule.versionId,
    action: 'resume',
    previewDigest: first.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const pausedAgain = await f.repository.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: resumed.schedule.versionId,
    action: 'pause',
    previewDigest: resumed.impactDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await expect(
    f.repository.changeSchedule(f.athlete, {
      scheduleId: f.approved.schedule.id,
      expectedVersionId: pausedAgain.schedule.versionId,
      action: 'resume',
      previewDigest: first.previewDigest,
      idempotencyKey: randomUUID(),
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: 'STALE_SCHEDULE_PREVIEW' });
  const second = await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id);
  expect(second.schedule.versionId).not.toBe(resumed.schedule.versionId);
  const again = await f.repository.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: pausedAgain.schedule.versionId,
    action: 'resume',
    previewDigest: second.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(again.occurrences.map((o) => o.anchorKey)).toEqual(f.dates.slice(1));
  expect((await start(f, required(again.occurrences[1]).id)).run.origin).toMatchObject({
    kind: 'planned',
  });
  await expect(start(f, required(resumed.occurrences[1]).id)).rejects.toMatchObject({
    code: 'OCCURRENCE_UNAVAILABLE',
  });
});

it('normal107 refuses a resume with future occurrences and leaves the schedule paused', async () => {
  const f = await setup(normal);
  const paused = await f.pause();
  const before = await occurrenceRows(normal, f);
  await expect(
    f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id),
  ).rejects.toMatchObject({ code: 'RESUME_REQUIRES_VERSIONED_OCCURRENCES' });
  await expect(
    f.repository.changeSchedule(f.athlete, {
      scheduleId: f.approved.schedule.id,
      expectedVersionId: paused.schedule.versionId,
      action: 'resume',
      previewDigest: paused.impactDigest,
      idempotencyKey: randomUUID(),
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: 'RESUME_REQUIRES_VERSIONED_OCCURRENCES' });
  expect(await f.repository.readSchedule(f.athlete, f.approved.schedule.id)).toEqual(paused);
  expect(await occurrenceRows(normal, f)).toEqual(before);
});

async function resumeNow(f: Fixture) {
  const paused = await f.pause();
  const preview = await f.repository.previewScheduleResume(f.athlete, f.approved.schedule.id);
  const resumed = await f.repository.changeSchedule(f.athlete, {
    scheduleId: f.approved.schedule.id,
    expectedVersionId: paused.schedule.versionId,
    action: 'resume',
    previewDigest: preview.previewDigest,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return { preview, resumed };
}

// M202-P1-06: an unresolved (localTime: null) anchor has no instant, so resume compares its
// local anchor date with today's local date in the schedule timezone: kept iff anchor date
// >= today. Missed earlier days are never carried into the resumed version.
it('resume keeps only today-or-later unresolved anchors; missed ones are not re-stored or runnable', async () => {
  const timezone = 'Asia/Seoul';
  const dates = [-3, -1, 2, 5].map((offset) => localDate(timezone, offset));
  const f = await setup(versioned, { timezone, localTime: null, dates });
  expect(f.approved.occurrences.every((o) => o.scheduledAt === null)).toBe(true);
  const original = await occurrenceRows(versioned, f);
  const { preview, resumed } = await resumeNow(f);
  expect(preview.occurrences.map((o) => o.anchorKey)).toEqual(dates.slice(2));
  expect(resumed.occurrences).toEqual(preview.occurrences);
  expect(
    resumed.occurrences.every((o) => o.timingStatus === 'unresolved' && o.scheduledAt === null),
  ).toBe(true);
  const rows = await occurrenceRows(versioned, f);
  expect(rows).toHaveLength(original.length + 2);
  expect(
    rows
      .filter((row) => row['schedule_version_id'] === resumed.schedule.versionId)
      .map((row) => routineOccurrenceSchema.parse(row['record_json']).anchorKey)
      .sort(),
  ).toEqual(dates.slice(2));
  for (const missed of f.approved.occurrences.slice(0, 2))
    await expect(start(f, missed.id)).rejects.toMatchObject({ code: 'OCCURRENCE_UNAVAILABLE' });
  expect((await start(f, required(resumed.occurrences[0]).id)).run.origin).toMatchObject({
    kind: 'planned',
  });
});

// The boundary follows the schedule timezone, not UTC: Kiritimati (UTC+14) and Pago Pago
// (UTC-11) never share a local date, so at any instant at least one differs from UTC's.
for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
  it(`resume boundary in ${timezone}: local today is kept, local yesterday is dropped`, async () => {
    const dates = [-1, 0, 1].map((offset) => localDate(timezone, offset));
    const f = await setup(versioned, { timezone, localTime: null, dates });
    const { resumed } = await resumeNow(f);
    expect(resumed.occurrences.map((o) => o.anchorKey)).toEqual(dates.slice(1));
    expect((await start(f, required(resumed.occurrences[0]).id)).run.origin).toMatchObject({
      kind: 'planned',
    });
    await expect(start(f, required(f.approved.occurrences[0]).id)).rejects.toMatchObject({
      code: 'OCCURRENCE_UNAVAILABLE',
    });
  });
}
