import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import { createRaceResultV2Repository } from '../src/race-result-v2.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const values = {
  kind: 'race-result' as const,
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'UTC',
  source: { kind: 'manual' as const },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: null,
  proofs: { link: null, attachments: [] },
};
function fixture(
  options: {
    app?: boolean;
    receipt?: Record<string, unknown>;
    rows?: Record<string, unknown>[];
    oversize?: boolean;
    head?: Record<string, unknown>;
    prior?: number;
  } = {},
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic',
    async query(sql, args = []) {
      calls.push({ sql, values: args });
      if (sql.includes('FROM consent'))
        return { rows: [{ kind: 'app', granted: options.app ?? true, revision: 1 }], rowCount: 1 };
      if (sql.includes('FROM race_command_receipt'))
        return { rows: options.receipt ? [options.receipt] : [], rowCount: 0 };
      if (sql.includes('SELECT revision FROM race_result'))
        return {
          rows: options.prior ? [{ revision: options.prior }] : [],
          rowCount: options.prior ? 1 : 0,
        };
      if (sql.includes('FROM race_collection_head'))
        return { rows: options.head ? [options.head] : [], rowCount: 0 };
      if (sql.includes('sum(n)'))
        return {
          rows: [
            {
              count: options.rows?.length ?? 0,
              bytes: options.oversize ? '999999999' : '100',
              maximum: options.oversize ? '999999999' : '100',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('SELECT id,revision,values_json'))
        return { rows: options.rows ?? [], rowCount: options.rows?.length ?? 0 };
      if (sql.includes('INSERT INTO outbox')) return { rows: [{ id: args[1] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const database: Database = {
    async tenant(athlete, operation) {
      expect(athlete).toBe(tx.athleteId);
      return operation(tx);
    },
    async exclusiveTenant(athlete, operation) {
      return operation(tx);
    },
    async close() {},
  };
  return {
    repo: createRaceResultV2Repository(database, {
      createId: () => id,
      now: () => new Date('2026-10-07T00:00:00Z'),
    }),
    calls,
  };
}
describe('race result V2 query-port units; not real PG', () => {
  it('writes relational identity and V2 values atomically through one tenant transaction without verification truth', async () => {
    const { repo, calls } = fixture();
    expect(
      await repo.create('synthetic', {
        schemaVersion: 2,
        idempotencyKey: 'synthetic-create',
        values,
      }),
    ).toEqual({ id, revision: 1 });
    const inserts = calls.filter((c) => c.sql.startsWith('INSERT'));
    expect(inserts.map((c) => c.sql.split('(')[0])).toEqual([
      'INSERT INTO race_result',
      'INSERT INTO race_result_revision',
      'INSERT INTO race_collection_head',
      'INSERT INTO race_command_receipt',
      'INSERT INTO outbox ',
    ]);
    const body = JSON.parse(String(inserts[0]?.values[3]));
    expect(body).toMatchObject({ schemaVersion: 2, chipSeconds: 0, gunSeconds: null });
    expect(body).not.toHaveProperty('id');
    expect(body.source).not.toHaveProperty('verifiedAt');
  });
  it('successful receipt precedes revoked admission while changed request conflicts', async () => {
    const first = fixture();
    const command = { schemaVersion: 2, idempotencyKey: 'synthetic-create', values };
    await first.repo.create('synthetic', command);
    const saved = first.calls.find((c) => c.sql.startsWith('INSERT INTO race_command_receipt'));
    if (!saved) throw Error('missing receipt');
    const replay = fixture({
      app: false,
      receipt: { request_hash: saved.values[2], result: { id, revision: 1 } },
    });
    expect(await replay.repo.create('synthetic', command)).toEqual({ id, revision: 1 });
    expect(replay.calls.some((c) => c.sql.includes('FROM consent'))).toBe(false);
    await expect(
      replay.repo.create('synthetic', { ...command, values: { ...values, chipSeconds: 1 } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('withdrawn fresh write produces no artifact queries', async () => {
    const { repo, calls } = fixture({ app: false });
    await expect(
      repo.create('synthetic', { schemaVersion: 2, idempotencyKey: 'synthetic-create', values }),
    ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
    expect(calls.some((c) => /INSERT|UPDATE/.test(c.sql))).toBe(false);
  });
  it('foreign/missing own head precedes source resolution and stale CAS never writes', async () => {
    const absent = fixture();
    await expect(
      absent.repo.update('synthetic', id, {
        schemaVersion: 2,
        idempotencyKey: 'synthetic-update',
        expectedRevision: 1,
        values,
      }),
    ).rejects.toMatchObject({ code: 'RACE_NOT_FOUND' });
    const stale = fixture({ prior: 2 });
    await expect(
      stale.repo.update('synthetic', id, {
        schemaVersion: 2,
        idempotencyKey: 'synthetic-update',
        expectedRevision: 1,
        values,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(
      stale.calls.some((c) => /INSERT|UPDATE/.test(c.sql) && !c.sql.includes('FOR UPDATE')),
    ).toBe(false);
  });
  it('retained V1 and V2 reads preserve zero/null without app gate', async () => {
    for (const body of [
      Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'proofs')),
      { ...values, schemaVersion: 2 },
    ]) {
      const { repo, calls } = fixture({
        app: false,
        rows: [{ id, revision: 1, values_json: body }],
      });
      expect(await repo.read('synthetic', { schemaVersion: 2, id })).toMatchObject({
        id,
        revision: 1,
        chipSeconds: 0,
        gunSeconds: null,
      });
      expect(calls.some((c) => c.sql.includes('FROM consent'))).toBe(false);
    }
  });
  it('oversized preflight denies before body fetch', async () => {
    const { repo, calls } = fixture({ oversize: true });
    await expect(repo.read('synthetic', { schemaVersion: 2, id })).rejects.toMatchObject({
      code: 'RACE_RESULT_READ_LIMIT',
    });
    expect(calls.some((c) => c.sql.includes('SELECT id,revision,values_json'))).toBe(false);
  });
  it('forged relational aliases and malformed unknown commands fail closed', async () => {
    const { repo } = fixture({
      rows: [{ id, revision: 1, values_json: { ...values, schemaVersion: 2, id: randomUUID() } }],
    });
    await expect(repo.read('synthetic', { schemaVersion: 2, id })).rejects.toMatchObject({
      code: 'RACE_RESULT_INVALID_SOURCE',
    });
    await expect(
      repo.create('synthetic', {
        schemaVersion: 2,
        idempotencyKey: 'synthetic-create',
        values: { ...values, reviewer: 'forged' },
      }),
    ).rejects.toThrow();
  });
  it('privacy generation invalidates cursor before private JSON fetch', async () => {
    const { repo, calls } = fixture({ head: { revision: 1, privacyGeneration: '2' } });
    await expect(
      repo.list('synthetic', {
        schemaVersion: 2,
        limit: 1,
        cursor: {
          kind: 'race-result',
          afterId: id,
          collection: { revision: 1, privacyGeneration: '1' },
        },
      }),
    ).rejects.toMatchObject({ code: 'RACE_CURSOR_STALE' });
    expect(calls.some((c) => c.sql.includes('SELECT id,revision,values_json'))).toBe(false);
  });
});
