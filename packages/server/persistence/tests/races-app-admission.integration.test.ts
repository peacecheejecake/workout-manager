import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  RaceEventValues,
  RaceResultValues,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantOperations, grantRaces } from '../src/migrate.js';
import { createRaceRepository } from '../src/races.js';
import { createConsentRepository } from '../src/repositories.js';
import { createOperationsRepository } from '../src/operations.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const runtimeUrl = z.string().min(1).parse(process.env['TEST_DATABASE_URL']);
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const event: RaceEventValues = {
  title: 'Synthetic admission',
  localDate: '2080-01-03',
  localStartTime: null,
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'considering',
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
};
const result: RaceResultValues = {
  kind: 'race-result',
  raceEventId: null,
  localDate: '2080-01-03',
  timezone: 'UTC',
  source: { kind: 'official', authority: 'Synthetic', resultUrl: 'https://example.invalid/result' },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: null,
};
const best: TrainingBestValues = {
  kind: 'training-best',
  observedAt: '2080-01-03T00:00:00+09:00',
  source: { kind: 'manual' },
  basis: 'user-entered',
  distanceMeters: null,
  elapsedSeconds: 0,
};
function families(db: Database = database) {
  const repo = createRaceRepository(db);
  return [
    {
      name: 'event',
      create: (a: string, k: string) =>
        repo.createRaceEvent(a, { idempotencyKey: k, values: event }),
      update: (a: string, id: string, k: string, revision: number) =>
        repo.updateRaceEvent(a, id, {
          idempotencyKey: k,
          expectedRevision: revision,
          values: event,
        }),
      read: (a: string, id: string) => repo.getRaceEvent(a, id),
      list: (a: string) => repo.listRaceEvents(a),
      remove: (a: string, id: string, r: number) =>
        repo.deleteRaceEvent(a, id, { expectedRevision: r, idempotencyKey: randomUUID() }),
    },
    {
      name: 'result',
      create: (a: string, k: string) =>
        repo.createRaceResult(a, { idempotencyKey: k, values: result }),
      update: (a: string, id: string, k: string, revision: number) =>
        repo.updateRaceResult(a, id, {
          idempotencyKey: k,
          expectedRevision: revision,
          values: result,
        }),
      read: (a: string, id: string) => repo.getRaceResult(a, id),
      list: (a: string) => repo.listRaceResults(a),
      remove: (a: string, id: string, r: number) =>
        repo.deleteRaceResult(a, id, { expectedRevision: r, idempotencyKey: randomUUID() }),
    },
    {
      name: 'best',
      create: (a: string, k: string) =>
        repo.createTrainingBest(a, { idempotencyKey: k, values: best }),
      update: (a: string, id: string, k: string, revision: number) =>
        repo.updateTrainingBest(a, id, {
          idempotencyKey: k,
          expectedRevision: revision,
          values: best,
        }),
      read: (a: string, id: string) => repo.getTrainingBest(a, id),
      list: (a: string) => repo.listTrainingBests(a),
      remove: (a: string, id: string, r: number) =>
        repo.deleteTrainingBest(a, id, { expectedRevision: r, idempotencyKey: randomUUID() }),
    },
  ];
}
async function permission(
  a: string,
  granted: boolean,
  kind: 'app' | 'provider' | 'ai' | 'healthkit' = 'app',
) {
  const consent = createConsentRepository(database);
  const previous = await consent.getConsent(a, kind);
  return consent.setConsent(a, {
    kind,
    granted,
    expectedRevision: previous.revision,
    idempotencyKey: randomUUID(),
  });
}
const tables = [
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
  'outbox',
];
async function facts(a: string) {
  const rows: Record<string, unknown> = {};
  for (const table of tables)
    rows[table] = (
      await admin.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE athlete_id=$1 ORDER BY to_jsonb(t)::text`,
        [a],
      )
    ).rows;
  return rows;
}
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantRaces(adminUrl, 'workout_runtime');
  // Test runtime also exercises the real consent command; this is not a race production grant.
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT ON command_receipt TO workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON outbox TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  const role = await admin.query(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='workout_runtime'",
  );
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
describe('race app admission with restricted real PostgreSQL runtime', () => {
  for (const index of [0, 1, 2])
    for (const state of ['absent', 'false'] as const) {
      it(`${index} create denies ${state} without ledger/receipt/outbox changes`, async () => {
        const a = randomUUID(),
          f = families()[index];
        if (!f) throw new Error('FAMILY');
        if (state === 'false') await permission(a, false);
        const before = await facts(a);
        await expect(f.create(a, randomUUID())).rejects.toMatchObject({
          code: 'APP_CONSENT_REQUIRED',
        });
        expect(await facts(a)).toEqual(before);
      });
      it(`${index} update denies ${state} without partial artifacts`, async () => {
        const a = randomUUID(),
          f = families()[index];
        if (!f) throw new Error('FAMILY');
        await permission(a, true);
        const record = await f.create(a, randomUUID());
        if (state === 'absent') await absentConsent(a);
        else await permission(a, false);
        const before = await facts(a);
        await expect(f.update(a, record.id, randomUUID(), record.revision)).rejects.toMatchObject({
          code: 'APP_CONSENT_REQUIRED',
        });
        expect(await facts(a)).toEqual(before);
      });
    }
  for (const index of [0, 1, 2])
    it(`${index} true/regrant, successful replay before fresh gate, read/list/delete retained`, async () => {
      const a = randomUUID(),
        f = families()[index];
      if (!f) throw new Error('FAMILY');
      await permission(a, true);
      const key = randomUUID(),
        first = await f.create(a, key),
        updateKey = randomUUID(),
        second = await f.update(a, first.id, updateKey, 1);
      await permission(a, false);
      const before = await facts(a);
      expect(await f.create(a, key)).toEqual(first);
      expect(await f.update(a, first.id, updateKey, 1)).toEqual(second);
      expect(await facts(a)).toEqual(before);
      expect(await f.read(a, first.id)).not.toBeNull();
      expect((await f.list(a)).items).toHaveLength(1);
      await expect(f.update(a, first.id, key, 2)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await permission(a, true);
      await expect(f.update(a, first.id, randomUUID(), 1)).rejects.toThrow('REVISION_CONFLICT');
      const third = await f.update(a, first.id, randomUUID(), 2);
      await permission(a, false);
      await f.remove(a, first.id, third.revision);
      expect(await f.read(a, first.id)).toBeNull();
      expect(await f.create(a, key)).toEqual(first);
      expect(await f.read(a, first.id)).toBeNull();
    });
  it('other consent kinds and another tenant cannot authorize app writes; foreign records remain unavailable', async () => {
    const a = randomUUID(),
      b = randomUUID();
    for (const kind of ['provider', 'ai', 'healthkit'] as const) await permission(a, true, kind);
    await permission(b, true);
    const f = families()[0];
    if (!f) throw new Error('FAMILY');
    const foreign = await f.create(b, randomUUID());
    await expect(f.create(a, randomUUID())).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
    expect(await f.read(a, foreign.id)).toBeNull();
    await permission(a, true);
    await expect(f.update(a, foreign.id, randomUUID(), 1)).rejects.toThrow('RACE_NOT_FOUND');
    expect((await f.list(a)).items).toHaveLength(0);
    await permission(a, false);
    expect(
      (await createOperationsRepository(database).exportAccount(a)).data.consents.some(
        (c) => c.kind === 'app' && !c.granted,
      ),
    ).toBe(true);
  });
  for (const first of ['writer', 'revoke'] as const)
    it(`real advisory serialization: ${first} commits first`, async () => {
      const a = randomUUID();
      await permission(a, true);
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        proceed = new Promise<void>((resolve) => {
          release = resolve;
        });
      let intercepted = false;
      const wrapped: Database = {
        ...database,
        tenant(athlete, operation) {
          return database.tenant(athlete, (tx) =>
            operation({
              ...tx,
              async query(sql, values) {
                if (
                  !intercepted &&
                  sql.includes(
                    first === 'writer' ? 'FROM race_command_receipt' : 'FROM command_receipt',
                  )
                ) {
                  intercepted = true;
                  entered();
                  await proceed;
                }
                return tx.query(sql, values);
              },
            } satisfies Transaction),
          );
        },
      };
      const write = () =>
        families(first === 'writer' ? wrapped : database)[0]?.create(a, randomUUID());
      const revoke = () =>
        createConsentRepository(first === 'revoke' ? wrapped : database).setConsent(a, {
          kind: 'app',
          granted: false,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        });
      const firstCommand = first === 'writer' ? write() : revoke();
      await held;
      const secondCommand = first === 'writer' ? revoke() : write();
      const observed = secondCommand?.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: error instanceof Error ? error.message : 'unknown' }),
      );
      try {
        const deadline = Date.now() + 2000;
        let blocked = false;
        while (Date.now() < deadline) {
          const locks = await admin.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          );
          if (locks.rowCount) {
            blocked = true;
            break;
          }
          await setImmediate();
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      await firstCommand;
      const second = await observed;
      if (first === 'writer') {
        expect(second?.ok).toBe(true);
        expect((await families()[0]?.list(a))?.items).toHaveLength(1);
      } else {
        expect(second).toEqual({ ok: false, error: 'APP_CONSENT_REQUIRED' });
        expect((await families()[0]?.list(a))?.items).toHaveLength(0);
      }
      expect((await createConsentRepository(database).getConsent(a, 'app')).granted).toBe(false);
    });
});

/** Exercise a historical ledger with an absent admission head, in its tenant scope. */
async function absentConsent(athlete: string) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query("DELETE FROM consent WHERE athlete_id=$1 AND kind='app'", [athlete]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
