import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createActivityRepository } from '../src/activities.js';
import { createPlanningRepository } from '../src/planning.js';
import { createSessionActualsRepository } from '../src/session-actuals.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_head,plan_snapshot,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function draft(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: 'Original linked plan',
    timezone: 'America/New_York',
    periods: levels.map((level, i) => ({
      id: level,
      parentId: i === 0 ? null : (levels[i - 1] ?? null),
      level,
      title: level,
      startDate: '2024-03-10',
      endDateExclusive: '2024-03-11',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'planned',
        blockId: 'block',
        date: '2024-03-10',
        localStartTime: null,
        title: 'Planned run',
        sport: 'running',
        durationSeconds: 100,
        distanceMeters: 50,
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
async function plan(athlete: string) {
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
}
async function actual(
  athlete: string,
  planVersionId: string | null,
  startedAt = '2024-03-10T05:00:00Z',
  distanceMeters: number | null = 0,
) {
  return createActivityRepository(database).createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Actual',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      distanceMeters,
      durationSeconds: 10,
      durationKind: 'timer',
    },
    report: {
      sessionRpe: null,
      note: null,
      planLink: planVersionId ? { planVersionId, sessionId: 'planned' } : null,
    },
  });
}
it('returns every owned saved session and no records for foreign or missing plans', async () => {
  const athlete = randomUUID();
  const saved = await plan(athlete);
  const reader = createSessionActualsRepository(database, {
    now: () => new Date('2026-09-17T00:00:00Z'),
  });
  expect(await reader.read(randomUUID(), { planVersionId: saved.id })).toBeNull();
  expect(await reader.read(athlete, { planVersionId: randomUUID() })).toBeNull();
  const result = await reader.read(athlete, { planVersionId: saved.id.toUpperCase() });
  expect(result).toMatchObject({
    observedAt: '2026-09-17T00:00:00.000Z',
    coverage: 'unknown',
    planVersion: { id: saved.id, version: 1, title: saved.draft.title },
    activityDataRevision: { count: 0, revisionSum: '0' },
    sessions: [
      {
        sessionId: 'planned',
        distanceTarget: { minMeters: 50, maxMeters: 50 },
        actual: { count: 0, distanceMeters: { value: null, knownCount: 0, missingCount: 0 } },
      },
    ],
  });
});
it('includes explicit links outside dates or without start, preserves null/zero and separates duration definitions', async () => {
  const athlete = randomUUID();
  const base = draft();
  const original = base.sessions[0];
  if (!original) throw new Error('Session fixture missing');
  base.sessions = [
    { ...original, distanceMeters: null, distanceRange: { minMeters: 0, maxMeters: 1000.25 } },
    { ...original, id: 'constructor', distanceMeters: null },
  ];
  const saved = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: base,
  });
  const activities = createActivityRepository(database);
  await actual(athlete, saved.id, '2025-01-01T00:00:00Z', 0);
  await actual(athlete, saved.id, '2025-01-01T00:00:00Z', 25);
  await actual(athlete, null, '2024-03-10T05:00:00Z', 999);
  const imported = await activities.importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: null,
      kind: 'running',
      startedAt: null,
      timezone: null,
      durationSeconds: null,
      durationKind: 'elapsed',
      distanceMeters: null,
    },
  });
  await activities.updateOverlay(athlete, imported.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Explicit link without start',
    report: {
      sessionRpe: null,
      note: null,
      planLink: { planVersionId: saved.id, sessionId: 'planned' },
    },
  });
  const result = await createSessionActualsRepository(database).read(athlete, {
    planVersionId: saved.id,
  });
  expect(result?.activityDataRevision).toEqual({ count: 4, revisionSum: '5' });
  expect(result?.sessions).toMatchObject([
    {
      sessionId: 'planned',
      distanceTarget: { minMeters: 0, maxMeters: 1000.25 },
      actual: {
        count: 3,
        distanceMeters: { value: 25, knownCount: 2, missingCount: 1 },
        durationSeconds: {
          timer: { value: 20, knownCount: 2, missingCount: 0 },
          elapsed: { value: null, knownCount: 0, missingCount: 1 },
          moving: { value: null, knownCount: 0, missingCount: 0 },
          unknown: { value: null, knownCount: 0, missingCount: 0 },
        },
        sources: { manual: 2, fixture: 1, fit: 0 },
        overlayCount: 1,
      },
    },
    { sessionId: 'constructor', distanceTarget: null, actual: { count: 0 } },
  ]);
});
it('keeps old version links immutable and reflects corrections, unlinking and deletion revision', async () => {
  const athlete = randomUUID();
  const saved = await plan(athlete);
  const created = await actual(athlete, saved.id);
  const later = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: saved.id,
    idempotencyKey: randomUUID(),
    draft: { ...saved.draft, title: 'Later head' },
  });
  const reader = createSessionActualsRepository(database);
  expect((await reader.read(athlete, { planVersionId: later.id }))?.sessions[0]?.actual.count).toBe(
    0,
  );
  expect((await reader.read(athlete, { planVersionId: saved.id }))?.currentPlanVersionId).toBe(
    later.id,
  );
  const activities = createActivityRepository(database);
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Correct distance',
    distanceMeters: 15,
    durationSeconds: 0,
    durationKind: 'moving',
  });
  expect(
    (await reader.read(athlete, { planVersionId: saved.id }))?.sessions[0]?.actual,
  ).toMatchObject({
    distanceMeters: { value: 15 },
    durationSeconds: { moving: { value: 0, knownCount: 1 }, timer: { value: null, knownCount: 0 } },
  });
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    reason: 'Unlink report',
    report: { sessionRpe: null, note: null, planLink: null },
  });
  expect((await reader.read(athlete, { planVersionId: saved.id }))?.sessions[0]?.actual.count).toBe(
    0,
  );
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 3,
    idempotencyKey: randomUUID(),
    reason: 'Restore explicit link',
    report: {
      sessionRpe: null,
      note: null,
      planLink: { planVersionId: saved.id, sessionId: 'planned' },
    },
  });
  await activities.deleteActivity(athlete, created.activityId, { expectedRevision: 4 });
  const erased = await reader.read(athlete, { planVersionId: saved.id });
  expect(erased?.sessions[0]?.actual.count).toBe(0);
  expect(erased?.activityDataRevision).toEqual({ count: 1, revisionSum: '5' });
});
it('reads totals and revision coherently during an actual concurrent correction', async () => {
  const athlete = randomUUID();
  const saved = await plan(athlete);
  const created = await actual(athlete, saved.id, undefined, 10);
  const reader = createSessionActualsRepository(database);
  const [reads] = await Promise.all([
    Promise.all(Array.from({ length: 4 }, () => reader.read(athlete, { planVersionId: saved.id }))),
    createActivityRepository(database).updateOverlay(athlete, created.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Concurrent correction',
      distanceMeters: 20,
    }),
  ]);
  for (const result of reads) {
    expect(result?.activityDataRevision.count).toBe(1);
    expect(['1', '2']).toContain(result?.activityDataRevision.revisionSum);
    expect(result?.sessions[0]?.actual.distanceMeters.value).toBe(
      result?.activityDataRevision.revisionSum === '1' ? 10 : 20,
    );
  }
});
