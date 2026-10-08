import { beforeEach, expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import { readRaceManualPooledParentDeltaTransportV1In as read } from '../src/race-manual-pooled-parent-delta-transport-v1.js';

const { decode } = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('../src/race-manual-pooled-parent-delta-v1.js', () => ({
  parseRaceManualPooledParentDeltaV1: decode,
}));
const id = '00000000-0000-4000-8000-000000000001';
const value = { parentDeltaVersion: 1 };
const output = {
  result: { evidenceId: id },
  payload: { minimalAudit: { athleteId: 'synthetic' } },
  authority: 'none',
  approvalAllowed: false,
};
function transaction(rows: Record<string, unknown>[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const tx: Transaction = { athleteId: 'synthetic', query };
  return { tx, query };
}
beforeEach(() => {
  decode.mockReset();
  decode.mockReturnValue(output);
});
it('reserves actual response bytes within the existing shared budget without new source authority', async () => {
  const { tx, query } = transaction([{ bytes: '80', value }]);
  const budget = { bytes: 100n, sources: 7 };
  expect(await read(tx, id, { fresh: true }, budget)).toMatchObject({
    status: 'read',
    authority: 'none',
    approvalAllowed: false,
  });
  expect(budget).toEqual({ bytes: 180n, sources: 7 });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]).toEqual([
    expect.stringContaining('read_manual_race_pooled_parent_delta_v1'),
    [id, '{"fresh":true}', '4194204'],
  ]);
});
it('rejects an oversized measured response before decoding and never falls back to the historical reader', async () => {
  const { tx, query } = transaction([{ bytes: '81', value: null }]);
  const budget = { bytes: 4194224n, sources: 0 };
  await expect(read(tx, id, {}, budget)).rejects.toThrow('CONTEXT_UNAVAILABLE');
  expect(decode).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(1);
  expect(budget.bytes).toBe(4194224n);
});
it('captures the fresh dictionary before awaiting SQL and decodes the same unmutated input', async () => {
  const input = { nested: { value: 1 } };
  const tx: Transaction = {
    athleteId: 'synthetic',
    query: async () => {
      input.nested.value = 2;
      return { rows: [{ bytes: '80', value }], rowCount: 1 };
    },
  };
  await read(tx, id, input, { bytes: 0n, sources: 0 });
  expect(decode).toHaveBeenCalledWith({ nested: { value: 1 } }, value);
  expect(input.nested.value).toBe(2);
});
it('missing parents remain unavailable and cannot be reconstructed from the fresh dictionary', async () => {
  const { tx } = transaction([{ bytes: '4', value: null }]);
  const budget = { bytes: 0n, sources: 0 };
  expect(await read(tx, id, {}, budget)).toMatchObject({ status: 'unavailable' });
  expect(decode).not.toHaveBeenCalled();
  expect(budget.bytes).toBe(4n);
});
it('rejects an inconsistent decoded null after a non-null SQL response', async () => {
  decode.mockReturnValue(null);
  const { tx } = transaction([{ bytes: '80', value }]);
  await expect(read(tx, id, {}, { bytes: 0n, sources: 0 })).rejects.toThrow('INVALID_CONTEXT');
});
it('rejects a foreign parent identity or athlete after strict reconstruction', async () => {
  for (const foreign of [
    { ...output, result: { evidenceId: '00000000-0000-4000-8000-000000000002' } },
    { ...output, payload: { minimalAudit: { athleteId: 'foreign' } } },
  ]) {
    decode.mockReturnValue(foreign);
    const { tx } = transaction([{ bytes: '80', value }]);
    await expect(read(tx, id, {}, { bytes: 0n, sources: 0 })).rejects.toThrow('INVALID_CONTEXT');
  }
});
it('rejects malformed scalar accounting and propagation failures without a retry or parser fallback', async () => {
  for (const rows of [[], [{ bytes: '0', value }], [{ bytes: '1', value, extra: true }]]) {
    const { tx, query } = transaction(rows);
    await expect(read(tx, id, {}, { bytes: 0n, sources: 0 })).rejects.toThrow('INVALID_CONTEXT');
    expect(query).toHaveBeenCalledTimes(1);
  }
  const query = vi.fn(async () => {
    throw Error('PERMISSION_DENIED');
  });
  await expect(
    read({ athleteId: 'synthetic', query }, id, {}, { bytes: 0n, sources: 0 }),
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(query).toHaveBeenCalledTimes(1);
});
it('rejects caller getters before SQL without invoking them', async () => {
  let calls = 0;
  const input = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const { tx, query } = transaction([]);
  await expect(read(tx, id, input, { bytes: 0n, sources: 0 })).rejects.toThrow('INVALID_CONTEXT');
  expect(calls).toBe(0);
  expect(query).not.toHaveBeenCalled();
});
