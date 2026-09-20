import { coreEvidenceSnapshotSchema } from '@workout/contracts/evidence-snapshots';
import { createCoachingConstraintRepository } from '../src/coaching-constraints.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import {
  migrate,
  grantOperations,
  grantCoachingConstraints,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantCheckIns,
  grantSessionCompletions,
} from '../src/migrate.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createPlanningRepository } from '../src/planning.js';
import { createActivityRepository } from '../src/activities.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import { createConsentRepository } from '../src/repositories.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCheckIns(adminUrl, 'workout_runtime');
  await grantSessionCompletions(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,command_receipt,outbox TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
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

const input = () => ({
  expectedConversationRevision: 1,
  window: { from: '2024-03-10', toExclusive: '2024-03-11', timezone: 'America/New_York' },
  idempotencyKey: randomUUID(),
});
async function thread(athlete: string, version: string) {
  return (
    await createCoachingThreadRepository(database).create(athlete, {
      planVersionId: version,
      title: 'Evidence thread',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Private user report',
      idempotencyKey: randomUUID(),
    })
  ).thread;
}
async function activity(athlete: string, startedAt: string | null = '2024-03-10T07:00:00Z') {
  return createActivityRepository(database).importActivity(athlete, {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'b'.repeat(64) },
    activity: {
      title: 'Private activity',
      kind: 'running',
      startedAt,
      timezone: 'UTC',
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
  });
}
async function checkin(athlete: string) {
  return createCheckInRepository(database).createCheckIn(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      observedAt: '2024-03-11T00:00:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: 'Private checkin',
    },
  });
}
it('captures bounded current records and matching revisions in one immutable snapshot of a historical conversation plan', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database);
  const latest = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: plan.id,
    idempotencyKey: randomUUID(),
    draft: { ...plan.draft, title: 'Latest current head' },
  });
  const a = await activity(athlete),
    unknown = await activity(athlete, null);
  await activity(athlete, '2024-03-11T04:00:00Z');
  await activity(athlete, '2024-03-10T04:59:59Z');
  await checkin(athlete);
  await createSessionCompletionRepository(database).write(athlete, 'session', {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: latest.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  const command = input();
  const [snapshot, duplicate] = await Promise.all([
    repo.capture(athlete, conversation.id, command),
    repo.capture(athlete, conversation.id, command),
  ]);
  expect(duplicate).toEqual(snapshot);
  if (snapshot.status !== 'available') throw new Error('Expected available evidence');
  expect(snapshot.body.plan.id).toBe(plan.id);
  expect(snapshot.body.dependencies.trainingPlan).toEqual({ kind: 'exists', versionId: latest.id });
  expect(snapshot.body.dependencies.activities).toEqual({ count: '4', revisionSum: '4' });
  expect(snapshot.body.activities.map((a) => a.record.id).sort()).toEqual(
    [a.activityId, unknown.activityId].sort(),
  );
  expect(
    snapshot.body.activities.find((a) => a.record.id === unknown.activityId)?.localDate,
  ).toBeNull();
  expect(snapshot.body.checkIns[0]).toMatchObject({
    localDate: '2024-03-10',
    record: { localDate: '2024-03-11', values: { fatigue: 0, discomfort: null } },
  });
  expect(snapshot.body.sessionCompletions).toHaveLength(1);
  expect(snapshot.createdAt).toBe(snapshot.body.dependencies.capturedAt);
  expect(await repo.read(randomUUID(), snapshot.id)).toBeNull();
  expect(await repo.list(randomUUID(), conversation.id)).toBeNull();
  await expect(
    repo.capture(athlete, conversation.id, {
      ...command,
      window: { ...command.window, toExclusive: '2024-03-12' },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    repo.capture(athlete, conversation.id, { ...input(), expectedConversationRevision: 2 }),
  ).rejects.toMatchObject({ code: 'CONVERSATION_REVISION_CONFLICT' });
  expect(await repo.list(athlete, conversation.id, { offset: 100 })).toEqual({
    items: [],
    total: 1,
  });
  await database.tenant(athlete, async (tx) => {
    const receipts = await tx.query(
      "SELECT result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'evidence:capture:%'",
      [athlete],
    );
    expect(receipts.rows).toEqual([{ result: { snapshotId: snapshot.id } }]);
    const events = await tx.query(
      "SELECT payload FROM outbox WHERE athlete_id=$1 AND topic='evidence.captured'",
      [athlete],
    );
    expect(events.rows).toEqual([
      { payload: { snapshotId: snapshot.id, threadId: conversation.id } },
    ]);
  });
});
it('purges dependent activity/checkin evidence and old receipts permanently, then consent withdrawal scrubs all remaining bodies', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database),
    a = await activity(athlete),
    c = await checkin(athlete),
    command = input();
  const initial = await repo.capture(athlete, conversation.id, command);
  await createActivityRepository(database).deleteActivity(athlete, a.activityId, {
    expectedRevision: a.revision,
  });
  expect(await repo.read(athlete, initial.id)).toMatchObject({
    status: 'purged',
    reason: 'source_deleted',
  });
  expect(await repo.capture(athlete, conversation.id, command)).not.toHaveProperty('body');
  const second = await repo.capture(athlete, conversation.id, input());
  await createCheckInRepository(database).deleteCheckIn(athlete, c.id, {
    expectedRevision: c.revision,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, second.id)).toMatchObject({
    status: 'purged',
    reason: 'source_deleted',
  });
  const consents = createConsentRepository(database);
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const thirdCommand = input(),
    third = await repo.capture(athlete, conversation.id, thirdCommand);
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.capture(athlete, conversation.id, thirdCommand)).toMatchObject({
    status: 'purged',
    reason: 'consent_withdrawn',
  });
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, third.id)).not.toHaveProperty('body');
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported.schemaVersion).toBe(14);
  if (exported.schemaVersion !== 14) throw new Error('Expected current export');
  expect(exported.data.evidenceSnapshots).toHaveLength(3);
  expect(JSON.stringify(exported.data.evidenceSnapshots)).not.toContain('Private');
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('UPDATE core_evidence_snapshot SET body=NULL WHERE athlete_id=$1', [athlete]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await database.tenant(randomUUID(), async (tx) =>
    expect(
      (await tx.query('SELECT * FROM core_evidence_snapshot WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([]),
  );
  await createOperationsRepository(database).eraseAccount(athlete);
  expect(
    (
      await admin.query(
        'SELECT count(*)::int AS count FROM core_evidence_snapshot WHERE athlete_id=$1',
        [athlete],
      )
    ).rows[0].count,
  ).toBe(0);
  await expect(repo.read(athlete, initial.id)).rejects.toBeInstanceOf(TenantErasedError);
});
it('rolls back body, receipt and outbox on failure and retries once without historical health copies', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database),
    command = input();
  const broken: Database = {
    ...database,
    tenant: (id, op) =>
      database.tenant(id, (tx) =>
        op({
          ...tx,
          query: (sql, values) => {
            if (sql.includes('INSERT INTO outbox'))
              throw new Error('Injected evidence outbox failure');
            return tx.query(sql, values);
          },
        }),
      ),
  };
  await expect(
    createCoreEvidenceSnapshotRepository(broken).capture(athlete, conversation.id, command),
  ).rejects.toThrow('Injected evidence outbox failure');
  expect(await repo.list(athlete, conversation.id)).toEqual({ items: [], total: 0 });
  const saved = await repo.capture(athlete, conversation.id, command);
  expect(await repo.capture(athlete, conversation.id, command)).toEqual(saved);
});
it('serializes capture with source corrections so manifest and effective revisions cannot disagree', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    a = await activity(athlete),
    repo = createCoreEvidenceSnapshotRepository(database);
  const constraints = createCoachingConstraintRepository(database);
  const constraint = await constraints.create(athlete, {
    expectedHeadRevision: null,
    confirmed: true,
    text: 'Before correction',
    idempotencyKey: randomUUID(),
  });
  const [snapshot] = await Promise.all([
    repo.capture(athlete, conversation.id, input()),
    createActivityRepository(database).updateOverlay(athlete, a.activityId, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reason: 'Concurrent correction',
      distanceMeters: 123,
    }),
    constraints.update(athlete, constraint.id, {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      text: 'After correction',
      idempotencyKey: randomUUID(),
    }),
  ]);
  if (snapshot.status !== 'available') throw new Error('Expected available');
  if (snapshot.body.schemaVersion !== 2) throw new Error('Expected current evidence');
  const capturedConstraint = snapshot.body.userConstraints.items[0];
  expect(snapshot.body.dependencies.userConstraints).toEqual({
    kind: 'exists',
    revision: capturedConstraint?.revision,
  });
  expect(snapshot.body.userConstraints.headRevision).toBe(capturedConstraint?.revision);
  expect(capturedConstraint?.text).toBe(
    capturedConstraint?.revision === 1 ? 'Before correction' : 'After correction',
  );
  const record = snapshot.body.activities[0]?.record;
  expect(record).toBeDefined();
  expect(snapshot.body.dependencies.activities.revisionSum).toBe(String(record?.revision));
  expect(record?.effective.distanceMeters).toBe(record?.revision === 1 ? 0 : 123);
  const fresh = await repo.capture(athlete, conversation.id, input());
  if (fresh.status !== 'available') throw new Error('Expected available');
  expect(fresh.body.activities[0]?.record.revision).toBe(2);
});
it('rejects complete-conversation and byte bounds rather than silently truncating', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    threads = createCoachingThreadRepository(database),
    repo = createCoreEvidenceSnapshotRepository(database);
  for (let revision = 1; revision <= 100; revision++)
    await threads.append(athlete, conversation.id, {
      expectedRevision: revision,
      message: 'Synthetic bounded message',
      idempotencyKey: randomUUID(),
    });
  await expect(
    repo.capture(athlete, conversation.id, { ...input(), expectedConversationRevision: 101 }),
  ).rejects.toMatchObject({ code: 'EVIDENCE_TOO_LARGE' });
  expect(await repo.list(athlete, conversation.id)).toEqual({ items: [], total: 0 });
  const largeAthlete = randomUUID(),
    largePlan = await seed(largeAthlete),
    largeThread = await thread(largeAthlete, largePlan.id),
    a = await activity(largeAthlete);
  await createActivityRepository(database).updateOverlay(largeAthlete, a.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic large evidence',
    report: { sessionRpe: null, note: 'x'.repeat(4000), planLink: null },
  });
  await database.tenant(largeAthlete, async (tx) => {
    await tx.query(
      `WITH originals AS (SELECT original FROM activity_canonical WHERE athlete_id=$1 AND id=$2), inserted AS (
      INSERT INTO activity_canonical(athlete_id,id,revision,original) SELECT $1,gen_random_uuid(),2,original FROM originals,generate_series(1,300) RETURNING id
    ) INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) SELECT $1,'fixture',id::text,1,repeat('a',64),id FROM inserted`,
      [largeAthlete, a.activityId],
    );
    await tx.query(
      `INSERT INTO activity_overlay(athlete_id,activity_id,values_json) SELECT c.athlete_id,c.id,o.values_json FROM activity_canonical c JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=$2 WHERE c.athlete_id=$1 AND c.id<>$2`,
      [largeAthlete, a.activityId],
    );
  });
  await expect(repo.capture(largeAthlete, largeThread.id, input())).rejects.toMatchObject({
    code: 'EVIDENCE_TOO_LARGE',
  });
  expect(await repo.list(largeAthlete, largeThread.id)).toEqual({ items: [], total: 0 });
});

it('rejects activity and check-in count overflow without partial evidence or receipts', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database);
  const a = await activity(athlete, null);
  await database.tenant(athlete, async (tx) => {
    await tx.query(
      `WITH originals AS (SELECT original FROM activity_canonical WHERE athlete_id=$1 AND id=$2), inserted AS (
      INSERT INTO activity_canonical(athlete_id,id,revision,original) SELECT $1,gen_random_uuid(),1,original FROM originals,generate_series(1,500) RETURNING id
    ) INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) SELECT $1,'fixture',id::text,1,repeat('a',64),id FROM inserted`,
      [athlete, a.activityId],
    );
  });
  await expect(repo.capture(athlete, conversation.id, input())).rejects.toMatchObject({
    code: 'EVIDENCE_TOO_LARGE',
  });
  expect(await repo.list(athlete, conversation.id)).toEqual({ items: [], total: 0 });
  const secondAthlete = randomUUID(),
    secondPlan = await seed(secondAthlete),
    secondThread = await thread(secondAthlete, secondPlan.id);
  await checkin(secondAthlete);
  await database.tenant(secondAthlete, async (tx) => {
    await tx.query(
      `INSERT INTO check_in(athlete_id,id,revision,values_json,local_date)
      SELECT $1,gen_random_uuid(),1,values_json,local_date FROM check_in,generate_series(1,100) WHERE athlete_id=$1`,
      [secondAthlete],
    );
    await tx.query('UPDATE check_in_collection_head SET revision=101 WHERE athlete_id=$1', [
      secondAthlete,
    ]);
  });
  await expect(repo.capture(secondAthlete, secondThread.id, input())).rejects.toMatchObject({
    code: 'EVIDENCE_TOO_LARGE',
  });
  expect(await repo.list(secondAthlete, secondThread.id)).toEqual({ items: [], total: 0 });
});

it('scrubs on explicit first AI denial and repeated denial without prohibiting new local captures', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database),
    consents = createConsentRepository(database);
  const first = await repo.capture(athlete, conversation.id, input());
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, first.id)).toMatchObject({
    status: 'purged',
    reason: 'consent_withdrawn',
  });
  const second = await repo.capture(athlete, conversation.id, input());
  expect(second.status).toBe('available');
  await consents.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, second.id)).toMatchObject({
    status: 'purged',
    reason: 'consent_withdrawn',
  });
});

it.each(['activity', 'consent', 'constraint'] as const)(
  'serializes raw %s removal at the database trigger boundary with capture insertion',
  async (kind) => {
    const athlete = randomUUID(),
      plan = await seed(athlete),
      conversation = await thread(athlete, plan.id),
      a = await activity(athlete),
      repo = createCoreEvidenceSnapshotRepository(database),
      command = input();
    await createConsentRepository(database).setConsent(athlete, {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const constraint = await createCoachingConstraintRepository(database).create(athlete, {
      expectedHeadRevision: null,
      confirmed: true,
      text: 'Concurrent constraint',
      idempotencyKey: randomUUID(),
    });
    let reached!: () => void, release!: () => void;
    const selected = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: Database = {
      ...database,
      tenant: (id, op) =>
        database.tenant(id, (tx) =>
          op({
            ...tx,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.startsWith('WITH pinned AS')) {
                reached();
                await resume;
              }
              return result;
            },
          }),
        ),
    };
    const capturing = createCoreEvidenceSnapshotRepository(gated).capture(
      athlete,
      conversation.id,
      command,
    );
    await Promise.race([
      selected,
      capturing.then(() => {
        throw new Error('Capture did not reach gate');
      }),
    ]);
    let identify!: (pid: number) => void;
    const identified = new Promise<number>((resolve) => {
      identify = resolve;
    });
    const removing = database.tenant(athlete, async (tx) => {
      const pid = await tx.query('SELECT pg_backend_pid() AS pid');
      const value = pid.rows[0]?.['pid'];
      if (typeof value !== 'number') throw new Error('Missing PostgreSQL backend id');
      identify(value);
      if (kind === 'activity')
        await tx.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athlete, a.activityId],
        );
      else if (kind === 'constraint')
        await tx.query(
          'UPDATE coaching_constraint SET deleted=true,text=NULL,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athlete, constraint.id],
        );
      else await tx.query("DELETE FROM consent WHERE athlete_id=$1 AND kind='ai'", [athlete]);
    });
    try {
      const pid = await Promise.race([
        identified,
        removing.then(() => {
          throw new Error('Writer did not identify');
        }),
      ]);
      // Observe a real PostgreSQL lock wait, not a guessed timing delay.
      await expect
        .poll(
          async () =>
            Number(
              (await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS count', [pid]))
                .rows[0].count,
            ),
          { timeout: 2000 },
        )
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    const [snapshot] = await Promise.all([capturing, removing]);
    const expected = {
      status: 'purged',
      reason: kind === 'consent' ? 'consent_withdrawn' : 'source_deleted',
    };
    expect(await repo.read(athlete, snapshot.id)).toMatchObject(expected);
    expect(await repo.capture(athlete, conversation.id, command)).toMatchObject(expected);
    expect(await repo.capture(athlete, conversation.id, command)).not.toHaveProperty('body');
  },
);

it('captures constraint content and head together, freezes corrections, and irreversibly purges explicit deletion', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database),
    constraints = createCoachingConstraintRepository(database);
  const absentSnapshot = await repo.capture(athlete, conversation.id, input());
  expect(absentSnapshot).toMatchObject({
    status: 'available',
    body: {
      schemaVersion: 2,
      scope: 'running-core-v2',
      userConstraints: { headRevision: null, items: [] },
      dependencies: { schemaVersion: 2, userConstraints: { kind: 'absent' } },
    },
  });
  const initial = await constraints.create(athlete, {
    expectedHeadRevision: null,
    confirmed: true,
    text: 'Original confirmed text',
    idempotencyKey: randomUUID(),
  });
  const command = input(),
    frozen = await repo.capture(athlete, conversation.id, command);
  expect(frozen).toMatchObject({
    body: {
      userConstraints: {
        headRevision: 1,
        items: [{ id: initial.id, revision: 1, text: 'Original confirmed text' }],
      },
      dependencies: { userConstraints: { kind: 'exists', revision: 1 } },
    },
  });
  await constraints.update(athlete, initial.id, {
    expectedHeadRevision: 1,
    expectedRevision: 1,
    confirmed: true,
    text: 'Corrected confirmed text',
    idempotencyKey: randomUUID(),
  });
  expect(await repo.read(athlete, frozen.id)).toEqual(frozen);
  const corrected = await repo.capture(athlete, conversation.id, input());
  expect(corrected).toMatchObject({
    body: {
      userConstraints: {
        headRevision: 2,
        items: [{ revision: 2, text: 'Corrected confirmed text' }],
      },
      dependencies: { userConstraints: { kind: 'exists', revision: 2 } },
    },
  });
  expect(await repo.read(randomUUID(), frozen.id)).toBeNull();
  await constraints.remove(athlete, initial.id, {
    expectedHeadRevision: 2,
    expectedRevision: 2,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  for (const snapshot of [frozen, corrected])
    expect(await repo.read(athlete, snapshot.id)).toMatchObject({
      status: 'purged',
      reason: 'source_deleted',
    });
  expect(await repo.capture(athlete, conversation.id, command)).toMatchObject({ status: 'purged' });
  expect(await repo.read(athlete, absentSnapshot.id)).toEqual(absentSnapshot);
  expect(await repo.capture(athlete, conversation.id, input())).toMatchObject({
    body: {
      userConstraints: { headRevision: 3, items: [] },
      dependencies: { userConstraints: { kind: 'exists', revision: 3 } },
    },
  });
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(JSON.stringify(exported)).not.toContain('Original confirmed text');
  expect(JSON.stringify(exported)).not.toContain('Corrected confirmed text');
});

it('preserves original v1 snapshot receipts and rejects oversized current constraint sources', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database),
    current = await repo.capture(athlete, conversation.id, input());
  if (current.status !== 'available') throw new Error('Missing synthetic evidence');
  const legacy = coreEvidenceSnapshotSchema.parse({
    ...current,
    id: randomUUID(),
    body: {
      ...Object.fromEntries(
        Object.entries(current.body).filter(([key]) => key !== 'userConstraints'),
      ),
      schemaVersion: 1,
      scope: 'running-core-v1',
      dependencies: {
        ...Object.fromEntries(
          Object.entries(current.body.dependencies).filter(([key]) => key !== 'userConstraints'),
        ),
        schemaVersion: 1,
        scope: 'core-ledgers-v1',
      },
    },
  });
  if (legacy.status !== 'available') throw new Error('Missing legacy fixture');
  const command = input();
  await database.tenant(athlete, async (tx) => {
    await tx.query(
      'INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body) VALUES($1,$2,$3,$4,$5)',
      [athlete, legacy.id, conversation.id, legacy.createdAt, JSON.stringify(legacy.body)],
    );
    await tx.query(
      'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3,$4)',
      [
        athlete,
        `evidence:capture:${createHash('sha256').update(command.idempotencyKey).digest('hex')}`,
        JSON.stringify({
          threadId: conversation.id,
          window: command.window,
          expectedConversationRevision: 1,
        }),
        JSON.stringify({ snapshotId: legacy.id }),
      ],
    );
    await tx.query('INSERT INTO coaching_constraint_head(athlete_id,revision) VALUES($1,51)', [
      athlete,
    ]);
    await tx.query(
      "INSERT INTO coaching_constraint(athlete_id,id,revision,text,confirmed_at,updated_at) SELECT $1,gen_random_uuid(),1,'Synthetic bounded source',clock_timestamp(),clock_timestamp() FROM generate_series(1,51)",
      [athlete],
    );
  });
  expect(await repo.capture(athlete, conversation.id, command)).toEqual(legacy);
  await expect(repo.capture(athlete, conversation.id, input())).rejects.toMatchObject({
    code: 'EVIDENCE_TOO_LARGE',
  });
});

it('reserves multi-revision maintenance advances to the owner and purges owner hard deletions', async () => {
  const athlete = randomUUID(),
    plan = await seed(athlete),
    conversation = await thread(athlete, plan.id),
    repo = createCoreEvidenceSnapshotRepository(database);
  const constraint = await createCoachingConstraintRepository(database).create(athlete, {
    expectedHeadRevision: null,
    confirmed: true,
    text: 'Private owner fixture',
    idempotencyKey: randomUUID(),
  });
  const snapshot = await repo.capture(athlete, conversation.id, input());
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('UPDATE coaching_constraint SET revision=revision+2 WHERE athlete_id=$1', [athlete]),
    ),
  ).rejects.toThrow('IMMUTABLE_CONSTRAINT_IDENTITY');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('UPDATE coaching_constraint SET revision=revision+2 WHERE athlete_id=$1', [
      athlete,
    ]);
    await client.query(
      'UPDATE coaching_constraint_head SET revision=revision+2 WHERE athlete_id=$1',
      [athlete],
    );
    await client.query('COMMIT');
    expect(await repo.read(athlete, snapshot.id)).toEqual(snapshot);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('DELETE FROM coaching_constraint WHERE athlete_id=$1 AND id=$2', [
      athlete,
      constraint.id,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect(await repo.read(athlete, snapshot.id)).toMatchObject({
    status: 'purged',
    reason: 'source_deleted',
  });
});
