import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import type { ActivityImport } from '@workout/contracts/activity';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import {
  migrate,
  grantOperations,
  grantCheckIns,
  grantSessionCompletions,
} from '../src/migrate.js';
import { createEvidenceDependenciesRepository } from '../src/evidence-dependencies.js';
import { createPlanningRepository } from '../src/planning.js';
import { createActivityRepository } from '../src/activities.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { createConsentRepository } from '../src/repositories.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await grantSessionCompletions(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
async function seed(athlete: string, sessionId = 'session') {
  const draft: PlanDraft = {
    title: 'Completion',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: sessionId,
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Run',
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
  };
  return createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
}

const absent = { kind: 'absent' };
function imported(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 2, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Synthetic evidence',
      kind: 'running',
      startedAt: null,
      timezone: null,
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
  };
}
it('captures absent heads and advances only current dependencies through real mutations, including activity tombstones and old receipts', async () => {
  const athlete = randomUUID(),
    capture = () => createEvidenceDependenciesRepository(database).capture(athlete);
  const first = await capture();
  expect(first).toMatchObject({
    athleteId: athlete,
    trainingPlan: absent,
    activities: { count: '0', revisionSum: '0' },
    checkIns: absent,
    sessionCompletions: absent,
    aiConsent: absent,
  });
  expect(Number.isNaN(Date.parse(first.capturedAt))).toBe(false);
  const plan = await seed(athlete);
  expect((await capture()).trainingPlan).toEqual({ kind: 'exists', versionId: plan.id });
  const next = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...plan.draft, title: 'Next' },
  });
  expect((await capture()).trainingPlan).toEqual({ kind: 'exists', versionId: next.id });
  const activities = createActivityRepository(database),
    input = imported();
  const original = await activities.importActivity(athlete, input);
  expect((await capture()).activities).toEqual({ count: '1', revisionSum: '1' });
  await activities.importActivity(athlete, {
    ...input,
    idempotencyKey: randomUUID(),
    source: { ...input.source, revision: 1 },
  });
  expect((await capture()).activities).toEqual({ count: '1', revisionSum: '1' });
  const corrected = await activities.updateOverlay(athlete, original.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic correction',
    distanceMeters: null,
  });
  expect((await capture()).activities).toEqual({ count: '1', revisionSum: '2' });
  await activities.deleteActivity(athlete, original.activityId, {
    expectedRevision: corrected.revision,
  });
  expect((await capture()).activities).toEqual({ count: '1', revisionSum: '3' });
  await activities.importActivity(athlete, input);
  expect((await capture()).activities).toEqual({ count: '1', revisionSum: '3' });
  const checks = createCheckInRepository(database),
    values = {
      observedAt: '2024-01-01T00:00:00Z',
      timezone: 'UTC',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: null,
    };
  const created = await checks.createCheckIn(athlete, { idempotencyKey: randomUUID(), values });
  expect((await capture()).checkIns).toEqual({ kind: 'exists', revision: 1 });
  const updated = await checks.updateCheckIn(athlete, created.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { ...values, fatigue: 1 },
    reason: 'Synthetic correction',
  });
  expect((await capture()).checkIns).toEqual({ kind: 'exists', revision: 2 });
  await checks.deleteCheckIn(athlete, created.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: updated.revision,
  });
  expect((await capture()).checkIns).toEqual({ kind: 'exists', revision: 3 });
  const completions = createSessionCompletionRepository(database);
  await completions.write(athlete, 'session', {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: next.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  expect((await capture()).sessionCompletions).toEqual({ kind: 'exists', revision: 1 });
  await completions.write(athlete, 'session', {
    action: 'retract',
    confirmed: true,
    expectedPlanVersionId: next.id,
    expectedRevision: 1,
    reason: 'Synthetic correction',
    idempotencyKey: randomUUID(),
  });
  expect((await capture()).sessionCompletions).toEqual({ kind: 'exists', revision: 2 });
  const consents = createConsentRepository(database);
  await consents.setConsent(athlete, {
    kind: 'provider',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  expect((await capture()).aiConsent).toEqual(absent);
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  expect((await capture()).aiConsent).toEqual({ kind: 'exists', revision: 1, granted: true });
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect((await capture()).aiConsent).toEqual({ kind: 'exists', revision: 2, granted: false });
  const other = await createEvidenceDependenciesRepository(database).capture(randomUUID());
  expect(other).toMatchObject({
    trainingPlan: absent,
    activities: { count: '0', revisionSum: '0' },
    checkIns: absent,
    sessionCompletions: absent,
    aiConsent: absent,
  });
  await createOperationsRepository(database).eraseAccount(athlete);
  await expect(capture()).rejects.toBeInstanceOf(TenantErasedError);
});

it('retains a single statement snapshot when a concurrent real writer commits between query return and decoding', async () => {
  const athlete = randomUUID();
  let queries = 0;
  let committed = false;
  const measured: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: async (sql, params) => {
            queries++;
            const result = await tx.query(sql, params);
            if (!committed) {
              await database.tenant(athlete, async (writer) => {
                await writer.query(
                  "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',true,1)",
                  [athlete],
                );
                await writer.query(
                  'INSERT INTO check_in_collection_head(athlete_id,revision) VALUES($1,1)',
                  [athlete],
                );
              });
              committed = true;
            }
            return result;
          },
        }),
      ),
  };
  const repo = createEvidenceDependenciesRepository(measured);
  expect(await repo.capture(athlete)).toMatchObject({ aiConsent: absent, checkIns: absent });
  expect(committed).toBe(true);
  expect(queries).toBe(1);
  expect(await repo.capture(athlete)).toMatchObject({
    aiConsent: { kind: 'exists', revision: 1, granted: true },
    checkIns: { kind: 'exists', revision: 1 },
  });
  expect(queries).toBe(2);
});
