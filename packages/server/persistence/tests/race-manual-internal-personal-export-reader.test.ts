import { expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import { RetainedPersonalExportError } from '../src/retained-personal-export.js';
import { readRaceManualInternalPersonalExportV1In } from '../src/race-manual-internal-personal-export-reader.js';
import { renderRaceManualInternalPersonalExport } from '../src/race-manual-internal-personal-export-renderer.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const now = '2026-10-08T00:00:00.123456Z';
function source() {
  const chain = { evidenceId: id(1), decisionId: id(2), proposalId: id(3) };
  const purge = { purgedAt: now, purgeEventId: id(4) };
  return {
    schemaVersion: 1,
    chains: [
      {
        ...chain,
        createdAt: now,
        bodyState: 'purged',
        preparation: null,
        purge,
        originalResult: {
          schemaVersion: 2,
          ...chain,
          candidateDigest: 'a'.repeat(64),
          createdAt: now,
          applicable: false,
          approvalAllowed: false,
        },
      },
    ],
    candidates: [
      { candidateId: id(5), chain, createdAt: now, bodyState: 'purged', candidate: null, purge },
    ],
    approvalResults: [],
    approvalHistory: [],
  };
}
function transaction(
  options: {
    source?: unknown;
    bytes?: string;
    capability?: unknown;
    response?: unknown;
    error?: unknown;
    probeRows?: Record<string, unknown>[];
  } = {},
) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'server-owned-tenant',
    async query(sql, values) {
      calls.push({ sql, values });
      if (options.error !== undefined) throw options.error;
      if (sql.includes('to_regprocedure'))
        return {
          rows: options.probeRows ?? [
            Object.assign({}, options.capability ?? { installed: true, executable: true }),
          ],
          rowCount: 1,
        };
      const body = options.source === undefined ? source() : options.source;
      return {
        rows: [
          Object.assign(
            {},
            options.response ?? {
              bytes: options.bytes ?? String(Buffer.byteLength(JSON.stringify(body))),
              source: body,
            },
          ),
        ],
        rowCount: 1,
      };
    },
  };
  return { tx, calls };
}
it('reads one fixed bounded SQL129 call and returns only historical safe planned facts', async () => {
  const { tx, calls } = transaction();
  const measured = vi.fn();
  const output = await readRaceManualInternalPersonalExportV1In(tx, 8388608, measured);
  expect(output).toEqual(renderRaceManualInternalPersonalExport(source()));
  expect(output.manualInternalCandidates[0]?.body.state).toBe('purged');
  expect(JSON.stringify(output)).not.toMatch(/originalResult|preparation|candidateDigest/);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual([
    'public.read_manual_race_internal_personal_export_v1(integer)',
  ]);
  expect(calls[1]?.values).toEqual([8388608]);
  expect(calls[1]?.sql.match(/read_manual_race_internal_personal_export_v1/g)).toHaveLength(1);
  expect(calls[1]?.sql).toContain('observed AS MATERIALIZED');
  expect(calls[1]?.sql).toContain('CASE WHEN bytes<=$1::integer THEN source ELSE NULL');
  expect(calls.every((c) => !/INSERT|UPDATE|DELETE/.test(c.sql))).toBe(true);
  expect(measured).toHaveBeenCalledExactlyOnceWith(Buffer.byteLength(JSON.stringify(source())));
});
it('debits measured JSONB, not compact DTO length, before pure projection', async () => {
  const { tx } = transaction({ bytes: '2000' });
  const measured: number[] = [];
  const output = await readRaceManualInternalPersonalExportV1In(tx, 2500, (n) => measured.push(n));
  expect(measured).toEqual([2000]);
  expect(output).toEqual(renderRaceManualInternalPersonalExport(source()));
});
it('debits before a malformed renderer source fails; it does not erase accounting', async () => {
  const { tx } = transaction({ source: { schemaVersion: 1 }, bytes: '100' });
  const measured = vi.fn();
  await expect(readRaceManualInternalPersonalExportV1In(tx, 200, measured)).rejects.toMatchObject({
    code: 'CORRUPT',
  });
  expect(measured).toHaveBeenCalledExactlyOnceWith(100);
});
it('propagates a shared budget rejection before returning a rendered body', async () => {
  const { tx } = transaction();
  const failure = new RetainedPersonalExportError('TOO_LARGE');
  await expect(
    readRaceManualInternalPersonalExportV1In(tx, 8388608, () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
it.each([0, -1, 1.5, NaN, Infinity, 8388609])(
  'invalid remaining limit %s refuses all SQL',
  async (limit) => {
    const { tx, calls } = transaction();
    await expect(readRaceManualInternalPersonalExportV1In(tx, limit)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    expect(calls).toHaveLength(0);
  },
);
it.each([
  { installed: false, executable: false },
  { installed: true, executable: false },
  { installed: false, executable: true },
])('missing/denied availability never invokes RPC (%j)', async (capability) => {
  const { tx, calls } = transaction({ capability });
  await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
    code: 'UNSUPPORTED',
  });
  expect(calls).toHaveLength(1);
});
it('malformed and ambiguous capability is corrupt, never upgraded to permission', async () => {
  for (const options of [
    { capability: {} },
    { capability: { installed: true, executable: true, approved: true } },
    { probeRows: [] },
  ]) {
    const { tx, calls } = transaction(options);
    await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    expect(calls).toHaveLength(1);
  }
});
it('scalar overbudget gate runs before body traversal and debit', async () => {
  let visits = 0;
  const body = Object.defineProperty({}, 'private', {
    get() {
      visits++;
      return 'never';
    },
    enumerable: true,
  });
  const { tx } = transaction({ bytes: '101', source: body });
  const measured = vi.fn();
  await expect(readRaceManualInternalPersonalExportV1In(tx, 100, measured)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(measured).not.toHaveBeenCalled();
  expect(visits).toBe(0);
  const nullGate = transaction({ bytes: '101', source: null });
  await expect(readRaceManualInternalPersonalExportV1In(nullGate.tx, 100)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
});
it('null/malformed/unknown response refuses safe projection', async () => {
  for (const response of [
    { bytes: '1', source: null },
    { bytes: '-1', source: {} },
    { bytes: '01', source: {} },
    { bytes: '99999999999999999', source: {} },
    { bytes: '1', source: {}, private: true },
    {},
  ]) {
    const { tx } = transaction({ response });
    await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  }
});
it('underreported body strings and UTF8 keys cannot exceed the real local remaining bound', async () => {
  for (const body of [{ private: 'x'.repeat(100) }, { ['한'.repeat(40)]: null }]) {
    const { tx } = transaction({ source: body, bytes: '1' });
    await expect(readRaceManualInternalPersonalExportV1In(tx, 64)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
  }
});
it('body accessors/cycles/sparse arrays/nonplain objects are rejected without getter execution', async () => {
  let visits = 0;
  const getter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      visits++;
      return 'raw';
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class Nonplain extends Array<unknown> {}
  for (const body of [
    getter,
    cycle,
    Array(1),
    new Nonplain(),
    { x: NaN },
    { [Symbol('private')]: 0 },
  ]) {
    const { tx } = transaction({ source: body, bytes: '8388608' });
    await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  }
  expect(visits).toBe(0);
});
it.each([
  [{ code: '42501', message: 'private' }, 'UNSUPPORTED'],
  [{ code: '42883' }, 'UNSUPPORTED'],
  [{ message: 'MANUAL_INTERNAL_EXPORT_TOO_LARGE' }, 'TOO_LARGE'],
  [{ message: 'MANUAL_INTERNAL_EXPORT_CORRUPT' }, 'CORRUPT'],
  [{ message: 'MANUAL_INTERNAL_EXPORT_SNAPSHOT_REQUIRED' }, 'CORRUPT'],
  [Error('private token'), 'CORRUPT'],
])('sanitizes SQL/fence failures without source payload (%j)', async (error, code) => {
  const { tx, calls } = transaction({ error });
  await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
    code,
    message: code,
  });
  expect(calls).toHaveLength(1);
});
it('driver envelope accessors and reflective traps are sanitized without evaluating bytes', async () => {
  let reads = 0;
  const unsafe = Object.defineProperty({ source: source() }, 'bytes', {
    enumerable: true,
    get() {
      reads++;
      return '1000';
    },
  });
  for (const value of [
    unsafe,
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error('private driver');
        },
      },
    ),
  ]) {
    const tx: Transaction = {
      athleteId: 'actual-server-tenant',
      async query(sql) {
        return {
          rows: sql.includes('to_regprocedure') ? [{ installed: true, executable: true }] : [value],
          rowCount: 1,
        };
      },
    };
    await expect(readRaceManualInternalPersonalExportV1In(tx)).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  }
  expect(reads).toBe(0);
});

it('rejects dishonest positive and zero measurement despite a larger remaining budget', async () => {
  const { tx } = transaction({ bytes: '1' });
  const debit = vi.fn();
  await expect(readRaceManualInternalPersonalExportV1In(tx, 8388608, debit)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(debit).toHaveBeenCalledExactlyOnceWith(1);
  const zero = transaction({ bytes: '0' });
  await expect(readRaceManualInternalPersonalExportV1In(zero.tx)).rejects.toMatchObject({
    code: 'CORRUPT',
  });
});
it('does not charge dense array index strings as serialized JSON bytes', async () => {
  // This invalid domain body has an exact dense JSON byte bound. It must reach
  // the strict renderer rejection, rather than fail a fictitious index charge.
  const dense = Array.from({ length: 1000 }, () => 0);
  const bytes = Buffer.byteLength(JSON.stringify(dense));
  const { tx } = transaction({ source: dense, bytes: String(bytes) });
  await expect(readRaceManualInternalPersonalExportV1In(tx, bytes)).rejects.toMatchObject({
    code: 'CORRUPT',
  });
});
it('accepts valid1000 purged chains at their exact compact measured bound', async () => {
  const body = source();
  const template = body.chains[0];
  if (!template) throw Error('fixture');
  body.candidates = [];
  body.chains = Array.from({ length: 1000 }, (_, i) => ({
    ...template,
    evidenceId: id(i + 100),
    decisionId: id(i + 1100),
    proposalId: id(i + 2100),
    originalResult: {
      ...template.originalResult,
      evidenceId: id(i + 100),
      decisionId: id(i + 1100),
      proposalId: id(i + 2100),
    },
  }));
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const { tx } = transaction({ source: body, bytes: String(bytes) });
  expect(
    (await readRaceManualInternalPersonalExportV1In(tx, bytes)).manualInternalChains,
  ).toHaveLength(1000);
});
