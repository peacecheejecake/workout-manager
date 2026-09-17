import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { ManualPlanCommand } from '@workout/contracts/planning';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantOperations } from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
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
