import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { ManualPlanCommand } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON plan_snapshot,plan_head,plan_history,command_receipt,outbox TO workout_runtime',
  );
  await admin.query(
    'GRANT SELECT ON consent,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
function command(): ManualPlanCommand {
  return {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      title: 'Manual season',
      timezone: 'UTC',
      periods: [
        {
          id: 'season',
          parentId: null,
          level: 'season',
          title: 'Season',
          startDate: '2026-01-01',
          endDateExclusive: '2026-02-01',
          timezone: 'UTC',
          intent: 'Base',
          isPartial: false,
        },
      ],
      sessions: [],
    },
  };
}
describe('M1-02 manual plans real transaction invariants', () => {
  it('starts absent and saves immutable version/head/history/outbox and original receipt', async () => {
    const repository = createPlanningRepository(database);
    const athlete = randomUUID();
    const input = command();
    expect(await repository.read(athlete)).toEqual({ head: null, history: [] });
    const first = await repository.save(athlete, input);
    const second = await repository.save(athlete, {
      ...input,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: { ...input.draft, title: 'Revised' },
    });
    expect(second.version).toBe(2);
    expect(await repository.save(athlete, input)).toEqual(first);
    const read = await repository.read(athlete);
    expect(read.head).toEqual(second);
    expect(read.history.map((entry) => entry.version)).toEqual([2, 1]);
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM plan_history')).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
    });
    await expect(
      database.tenant(athlete, (tx) => tx.query("UPDATE plan_snapshot SET draft='{}'::jsonb")),
    ).rejects.toThrow('IMMUTABLE_PLAN_RECORD');
    await expect(
      database.tenant(athlete, (tx) => tx.query('DELETE FROM plan_history')),
    ).rejects.toThrow('IMMUTABLE_PLAN_RECORD');
  });
  it('serializes concurrent missing heads, duplicate saves and competing revisions', async () => {
    const repository = createPlanningRepository(database);
    const athlete = randomUUID();
    const input = command();
    const duplicate = await Promise.all([
      repository.save(athlete, input),
      repository.save(athlete, input),
    ]);
    expect(duplicate[0]).toEqual(duplicate[1]);
    const current = duplicate[0];
    if (!current) throw new Error('Missing version');
    const attempts = await Promise.allSettled([
      repository.save(athlete, {
        ...input,
        expectedVersionId: current.id,
        idempotencyKey: randomUUID(),
      }),
      repository.save(athlete, {
        ...input,
        expectedVersionId: current.id,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    await expect(
      repository.save(athlete, { ...input, draft: { ...input.draft, title: 'Changed same key' } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const newAthlete = randomUUID();
    const missingRace = await Promise.allSettled([
      repository.save(newAthlete, command()),
      repository.save(newAthlete, command()),
    ]);
    expect(missingRace.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  });
  it('RLS isolates plans, history, heads and rejects forged ownership', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const repository = createPlanningRepository(database);
    const saved = await repository.save(first, command());
    expect(await repository.read(second)).toEqual({ head: null, history: [] });
    await database.tenant(second, async (tx) => {
      for (const table of ['plan_snapshot', 'plan_head', 'plan_history'])
        expect((await tx.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    });
    await expect(
      database.tenant(second, (tx) =>
        tx.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [first, saved.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rolls back version/head/history when outbox insertion fails', async () => {
    const athlete = randomUUID();
    const input = command();
    const repository = createPlanningRepository(database);
    await database.tenant(athlete, (tx) =>
      tx.query(
        "INSERT INTO outbox(athlete_id,id,idempotency_key,topic,payload) VALUES($1,$2,$3,'fixture.collision','{}')",
        [athlete, randomUUID(), input.idempotencyKey],
      ),
    );
    await expect(repository.save(athlete, input)).rejects.toThrow();
    expect(await repository.read(athlete)).toEqual({ head: null, history: [] });
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM plan_history')).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM command_receipt')).rows).toEqual([]);
    });
  });
  it('requires a prior unlock version before moving protected sessions', async () => {
    const input = command();
    const root = input.draft.periods[0];
    if (root === undefined) throw new Error('Fixture season missing');
    input.draft.periods.push(
      { ...root, id: 'wave', parentId: 'season', level: 'wave' },
      { ...root, id: 'phase', parentId: 'wave', level: 'phase' },
      { ...root, id: 'block', parentId: 'phase', level: 'block' },
    );
    input.draft.sessions = [
      {
        id: 'run',
        blockId: 'block',
        date: '2026-01-02',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: true, time: false, intensity: false },
        steps: [],
      },
    ];
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const first = await repository.save(athlete, input);
    const moved = {
      ...input,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...input.draft,
        sessions: input.draft.sessions.map((session) => ({
          ...session,
          date: '2026-01-03',
          locks: { ...session.locks, date: false },
        })),
      },
    };
    await expect(repository.save(athlete, moved)).rejects.toMatchObject({ code: 'PLAN_LOCKED' });
    const reassigned = {
      ...moved,
      idempotencyKey: randomUUID(),
      draft: {
        ...moved.draft,
        periods: moved.draft.periods.map((period) =>
          period.id === 'block' ? { ...period, id: 'replacement-block' } : period,
        ),
        sessions: moved.draft.sessions.map((session) => ({
          ...session,
          date: '2026-01-02',
          blockId: 'replacement-block',
        })),
      },
    };
    await expect(repository.save(athlete, reassigned)).rejects.toMatchObject({
      code: 'PLAN_LOCKED',
    });
    expect((await repository.read(athlete)).head).toEqual(first);
    expect((await repository.read(athlete)).history).toHaveLength(1);
    const unlocked = await repository.save(athlete, {
      ...moved,
      draft: {
        ...moved.draft,
        sessions: moved.draft.sessions.map((session) => ({ ...session, date: '2026-01-02' })),
      },
    });
    const updated = await repository.save(athlete, {
      ...moved,
      expectedVersionId: unlocked.id,
      idempotencyKey: randomUUID(),
    });
    expect(updated.draft.sessions[0]?.date).toBe('2026-01-03');
  });
  it('never treats unconfirmed or AI proposal input as manual approval', async () => {
    const input = command();
    const repository = createPlanningRepository(database);
    // @ts-expect-error Exercise the runtime boundary with an unconfirmed command.
    await expect(repository.save(randomUUID(), { ...input, confirmed: false })).rejects.toThrow();
  });
});

function intensityCommand(): ManualPlanCommand {
  const input = command();
  const root = input.draft.periods[0];
  if (!root) throw new Error('Missing fixture season');
  input.draft.periods.push(
    { ...root, id: 'wave', parentId: 'season', level: 'wave' },
    { ...root, id: 'phase', parentId: 'wave', level: 'phase' },
    { ...root, id: 'block', parentId: 'phase', level: 'block' },
  );
  input.draft.sessions = [
    {
      id: 'run',
      blockId: 'block',
      date: '2026-01-02',
      localStartTime: null,
      title: 'Run',
      sport: 'running',
      durationSeconds: 0,
      distanceMeters: null,
      targetRpe: 0,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [
        { id: 'step', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 1 },
      ],
    },
  ];
  return input;
}

describe('S06 intensity label snapshot compatibility', () => {
  it('preserves absent legacy fields and original receipts after a labeled version is saved', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const legacy = intensityCommand();
    const first = await repository.save(athlete, legacy);
    expect(first.draft.sessions[0]).not.toHaveProperty('intensityLabel');
    const second = await repository.save(athlete, {
      ...legacy,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...legacy.draft,
        sessions: legacy.draft.sessions.map((session) => ({ ...session, intensityLabel: 'C' })),
      },
    });
    expect(second.draft.sessions[0]).toEqual({ ...legacy.draft.sessions[0], intensityLabel: 'C' });
    expect(await repository.save(athlete, legacy)).toEqual(first);
    const read = await repository.read(athlete);
    expect(read.head).toEqual(second);
    expect(read.history).toHaveLength(2);
    await database.tenant(athlete, async (tx) => {
      const stored = await tx.query(
        "SELECT (draft->'sessions'->0) ? 'intensityLabel' AS has_label FROM plan_snapshot WHERE id=$1",
        [first.id],
      );
      expect(stored.rows[0]?.['has_label']).toBe(false);
      expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM plan_history')).rowCount).toBe(2);
    });
    expect(
      (await admin.query('SELECT id FROM activity_canonical WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
  });
  it('rejects changing or clearing a locked label, including simultaneous unlock', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const input = intensityCommand();
    input.draft.sessions = input.draft.sessions.map((session) => ({
      ...session,
      intensityLabel: 'A',
      locks: { ...session.locks, intensity: true },
    }));
    const first = await repository.save(athlete, input);
    for (const label of ['B', null, undefined] as const) {
      for (const unlock of [false, true]) {
        const sessions = input.draft.sessions.map((session) => {
          const replacement = { ...session, locks: { ...session.locks, intensity: !unlock } };
          if (label === undefined) delete replacement.intensityLabel;
          else replacement.intensityLabel = label;
          return replacement;
        });
        await expect(
          repository.save(athlete, {
            ...input,
            expectedVersionId: first.id,
            idempotencyKey: randomUUID(),
            draft: { ...input.draft, sessions },
          }),
        ).rejects.toMatchObject({ code: 'PLAN_LOCKED' });
      }
    }
    expect((await repository.read(athlete)).head).toEqual(first);
    expect((await repository.read(athlete)).history).toHaveLength(1);
    const unlocked = await repository.save(athlete, {
      ...input,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...input.draft,
        sessions: input.draft.sessions.map((session) => ({
          ...session,
          locks: { ...session.locks, intensity: false },
        })),
      },
    });
    const changed = await repository.save(athlete, {
      ...input,
      expectedVersionId: unlocked.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...unlocked.draft,
        sessions: unlocked.draft.sessions.map((session) => ({ ...session, intensityLabel: 'B' })),
      },
    });
    expect(changed.version).toBe(3);
    expect(changed.draft.sessions[0]?.intensityLabel).toBe('B');
    await database.tenant(athlete, async (tx) => {
      expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(3);
      expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(3);
    });
    expect(
      (await admin.query('SELECT id FROM activity_canonical WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
  });
  it('treats missing and null as the same unspecified value under an intensity lock', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const input = intensityCommand();
    input.draft.sessions = input.draft.sessions.map((session) => ({
      ...session,
      locks: { ...session.locks, intensity: true },
    }));
    const absent = await repository.save(athlete, input);
    const explicit = await repository.save(athlete, {
      ...input,
      expectedVersionId: absent.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...input.draft,
        sessions: input.draft.sessions.map((session) => ({ ...session, intensityLabel: null })),
      },
    });
    expect(explicit.draft.sessions[0]?.intensityLabel).toBeNull();
    const absentAgain = await repository.save(athlete, {
      ...input,
      expectedVersionId: explicit.id,
      idempotencyKey: randomUUID(),
    });
    expect(absentAgain.draft.sessions[0]).not.toHaveProperty('intensityLabel');
    expect(absentAgain.draft.sessions).toEqual(input.draft.sessions);
  });
});

it('reads an owned immutable version outside the latest 100 history entries without write side effects', async () => {
  const athlete = randomUUID(),
    foreign = randomUUID();
  const repository = createPlanningRepository(database);
  const legacy = intensityCommand();
  const first = await repository.save(athlete, legacy);
  const second = await repository.save(athlete, {
    ...legacy,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: { ...legacy.draft, title: 'Second' },
  });
  expect(await repository.readVersion(athlete, first.id.toUpperCase())).toEqual(first);
  expect((await repository.readVersion(athlete, first.id))?.draft.sessions[0]).not.toHaveProperty(
    'intensityLabel',
  );
  expect(await repository.readVersion(foreign, first.id)).toBeNull();
  expect(await repository.readVersion(athlete, randomUUID())).toBeNull();
  let latest = second;
  for (let version = 3; version <= 102; version++) {
    latest = await repository.save(athlete, {
      ...legacy,
      expectedVersionId: latest.id,
      idempotencyKey: randomUUID(),
      draft: { ...legacy.draft, title: `Version ${version}` },
    });
  }
  const before = await repository.read(athlete);
  expect(before.history).toHaveLength(100);
  expect(before.history.some((item) => item.id === first.id)).toBe(false);
  expect(before.head).toEqual(latest);
  const count = () =>
    database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM command_receipt) AS receipts,(SELECT count(*)::int FROM outbox) AS events,(SELECT count(*)::int FROM plan_history) AS history',
      ),
    );
  const prior = await count();
  expect(await repository.readVersion(athlete, first.id)).toEqual(first);
  expect(await repository.readVersion(athlete, second.id)).toEqual(second);
  expect(await repository.read(athlete)).toEqual(before);
  expect((await count()).rows).toEqual(prior.rows);
});

it('preserves legacy period priority absence and explicit values through immutable snapshots, receipts and export', async () => {
  const athlete = randomUUID();
  const repository = createPlanningRepository(database);
  const input = intensityCommand();
  input.draft.sessions = input.draft.sessions.map((session) => ({
    ...session,
    locks: { date: true, time: true, intensity: true },
  }));
  const first = await repository.save(athlete, input);
  for (const period of first.draft.periods) expect(period).not.toHaveProperty('priority');
  const second = await repository.save(athlete, {
    ...input,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: {
      ...input.draft,
      periods: input.draft.periods.map((period) => ({
        ...period,
        priority: period.level === 'wave' ? null : 'high',
      })),
    },
  });
  expect(second.draft.sessions).toEqual(first.draft.sessions);
  expect(second.draft.periods.map((period) => period.priority)).toEqual([
    'high',
    null,
    'high',
    'high',
  ]);
  expect(await repository.save(athlete, input)).toEqual(first);
  expect((await repository.read(athlete)).head).toEqual(second);
  expect(await repository.readVersion(athlete, first.id)).toEqual(first);
  expect(await repository.readVersion(athlete, second.id)).toEqual(second);
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported.data.planSnapshots.find((row) => row['id'] === first.id)?.['draft']).toEqual(
    first.draft,
  );
  expect(exported.data.planSnapshots.find((row) => row['id'] === second.id)?.['draft']).toEqual(
    second.draft,
  );
  const cleared = await repository.save(athlete, {
    ...input,
    expectedVersionId: second.id,
    idempotencyKey: randomUUID(),
    draft: {
      ...second.draft,
      periods: second.draft.periods.map((period) => ({ ...period, priority: null })),
    },
  });
  expect(cleared.draft.sessions).toEqual(input.draft.sessions);
  expect(cleared.draft.periods.every((period) => period.priority === null)).toBe(true);
  expect(await repository.readVersion(athlete, second.id)).toEqual(second);
  expect(
    (await admin.query('SELECT * FROM activity_canonical WHERE athlete_id=$1', [athlete])).rowCount,
  ).toBe(0);
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(3);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(3);
    expect((await tx.query('SELECT * FROM plan_history')).rowCount).toBe(3);
  });
});

it('stores explicit scheduling conflicts and unknown duration constraints without changing locked sessions or old versions', async () => {
  const athlete = randomUUID();
  const repository = createPlanningRepository(database);
  const input = intensityCommand();
  input.draft.sessions = input.draft.sessions.flatMap((session) => [
    { ...session, durationSeconds: 60, locks: { date: true, time: true, intensity: true } },
    {
      ...session,
      id: 'unknown-duration',
      date: '2026-01-03',
      durationSeconds: null,
      locks: { date: true, time: true, intensity: true },
    },
  ]);
  const first = await repository.save(athlete, input);
  for (const period of first.draft.periods) expect(period).not.toHaveProperty('constraints');
  const constraints = {
    unavailableDates: ['2026-01-02'],
    dailyTimeLimits: [
      { date: '2026-01-02', availableSeconds: 0 },
      { date: '2026-01-03', availableSeconds: 86400 },
    ],
  };
  const second = await repository.save(athlete, {
    ...input,
    expectedVersionId: first.id,
    idempotencyKey: randomUUID(),
    draft: {
      ...input.draft,
      periods: input.draft.periods.map((period) =>
        period.level === 'season' ? { ...period, constraints } : period,
      ),
    },
  });
  expect(second.draft.sessions).toEqual(first.draft.sessions);
  expect(second.draft.periods[0]?.constraints).toEqual(constraints);
  expect((await repository.read(athlete)).head).toEqual(second);
  expect(await repository.readVersion(athlete, first.id)).toEqual(first);
  expect(await repository.save(athlete, input)).toEqual(first);
  expect((await repository.read(athlete)).head).toEqual(second);
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported.data.planSnapshots.find((row) => row['id'] === first.id)?.['draft']).toEqual(
    first.draft,
  );
  expect(exported.data.planSnapshots.find((row) => row['id'] === second.id)?.['draft']).toEqual(
    second.draft,
  );
  const cleared = await repository.save(athlete, {
    ...input,
    expectedVersionId: second.id,
    idempotencyKey: randomUUID(),
    draft: {
      ...second.draft,
      periods: second.draft.periods.map((period) =>
        period.level === 'season'
          ? { ...period, constraints: { unavailableDates: [], dailyTimeLimits: [] } }
          : period,
      ),
    },
  });
  expect(cleared.draft.periods[0]?.constraints).toEqual({
    unavailableDates: [],
    dailyTimeLimits: [],
  });
  expect(cleared.draft.sessions).toEqual(first.draft.sessions);
  expect(await repository.readVersion(athlete, second.id)).toEqual(second);
  expect(
    (await admin.query('SELECT * FROM activity_canonical WHERE athlete_id=$1', [athlete])).rowCount,
  ).toBe(0);
  await database.tenant(athlete, async (tx) => {
    expect((await tx.query('SELECT * FROM command_receipt')).rowCount).toBe(3);
    expect((await tx.query('SELECT * FROM outbox')).rowCount).toBe(3);
  });
});

describe('S06 pace and heart-rate target persistence', () => {
  it('preserves legacy absence and original receipts while saving and exporting explicit target ranges', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const legacy = intensityCommand();
    const first = await repository.save(athlete, legacy);
    const targets = {
      paceTarget: { minSecondsPerKm: 300.5, maxSecondsPerKm: 360 },
      heartRateTarget: { minBpm: 120, maxBpm: 140 },
    };
    const second = await repository.save(athlete, {
      ...legacy,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...legacy.draft,
        sessions: legacy.draft.sessions.map((session) => ({ ...session, ...targets })),
      },
    });
    expect(second.draft.sessions[0]).toEqual({ ...first.draft.sessions[0], ...targets });
    expect(await repository.save(athlete, legacy)).toEqual(first);
    expect(await repository.readVersion(athlete, first.id)).toEqual(first);
    expect(first.draft.sessions[0]).not.toHaveProperty('paceTarget');
    expect(first.draft.sessions[0]).not.toHaveProperty('heartRateTarget');
    expect((await repository.read(athlete)).head).toEqual(second);
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    expect(exported.data.planSnapshots.find((row) => row['id'] === second.id)?.['draft']).toEqual(
      second.draft,
    );
    expect(exported.data.planSnapshots.find((row) => row['id'] === first.id)?.['draft']).toEqual(
      first.draft,
    );
    await database.tenant(athlete, async (tx) => {
      for (const table of ['command_receipt', 'plan_history', 'outbox'])
        expect((await tx.query(`SELECT * FROM ${table}`)).rowCount).toBe(2);
      expect((await tx.query('SELECT * FROM activity_canonical')).rowCount).toBe(0);
    });
  });
  it('requires a separate unlock before changing, clearing or omitting either protected target', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const input = intensityCommand();
    input.draft.sessions = input.draft.sessions.map((session) => ({
      ...session,
      paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 300 },
      heartRateTarget: { minBpm: 130, maxBpm: 130 },
      locks: { ...session.locks, intensity: true },
    }));
    const first = await repository.save(athlete, input);
    for (const field of ['paceTarget', 'heartRateTarget'] as const) {
      for (const mode of ['change', 'clear', 'omit'] as const) {
        for (const unlock of [false, true]) {
          const candidate = structuredClone(first.draft);
          for (const session of candidate.sessions) {
            session.locks.intensity = !unlock;
            if (mode === 'omit') {
              if (field === 'paceTarget') delete session.paceTarget;
              else delete session.heartRateTarget;
            } else if (mode === 'clear') session[field] = null;
            else if (field === 'paceTarget')
              session.paceTarget = { minSecondsPerKm: 301, maxSecondsPerKm: 320 };
            else session.heartRateTarget = { minBpm: 131, maxBpm: 140 };
          }
          await expect(
            repository.save(athlete, {
              ...input,
              expectedVersionId: first.id,
              idempotencyKey: randomUUID(),
              draft: candidate,
            }),
          ).rejects.toMatchObject({ code: 'PLAN_LOCKED' });
        }
      }
    }
    const unlocked = await repository.save(athlete, {
      ...input,
      expectedVersionId: first.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...first.draft,
        sessions: first.draft.sessions.map((session) => ({
          ...session,
          locks: { ...session.locks, intensity: false },
        })),
      },
    });
    const cleared = await repository.save(athlete, {
      ...input,
      expectedVersionId: unlocked.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...unlocked.draft,
        sessions: unlocked.draft.sessions.map((session) => ({
          ...session,
          paceTarget: null,
          heartRateTarget: null,
        })),
      },
    });
    expect(cleared.draft.sessions[0]).toMatchObject({
      paceTarget: null,
      heartRateTarget: null,
      durationSeconds: 0,
      distanceMeters: null,
      targetRpe: 0,
    });
    expect((await repository.read(athlete)).history).toHaveLength(3);
  });
  it('treats absent and null as equivalent only for locks while preserving each saved representation', async () => {
    const athlete = randomUUID();
    const repository = createPlanningRepository(database);
    const input = intensityCommand();
    input.draft.sessions.forEach((session) => {
      session.locks.intensity = true;
    });
    const absent = await repository.save(athlete, input);
    const explicit = await repository.save(athlete, {
      ...input,
      expectedVersionId: absent.id,
      idempotencyKey: randomUUID(),
      draft: {
        ...input.draft,
        sessions: input.draft.sessions.map((session) => ({
          ...session,
          paceTarget: null,
          heartRateTarget: null,
        })),
      },
    });
    expect(explicit.draft.sessions[0]).toMatchObject({ paceTarget: null, heartRateTarget: null });
    const restored = await repository.save(athlete, {
      ...input,
      expectedVersionId: explicit.id,
      idempotencyKey: randomUUID(),
    });
    expect(restored.draft.sessions[0]).not.toHaveProperty('paceTarget');
    expect(restored.draft.sessions[0]).not.toHaveProperty('heartRateTarget');
    expect(await repository.save(athlete, input)).toEqual(absent);
  });
});
