import { expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import {
  raceMediaCleanupSourceSchema,
  readRaceMediaCleanupSource,
} from '../src/race-media-cleanup-source.js';
const media = '00000000-0000-4000-8000-00000000000a',
  hash = '1'.repeat(64);
const request = { mediaItemId: media, expectedAccessRevision: 2 };
function source() {
  return raceMediaCleanupSourceSchema.parse({
    schemaVersion: 1,
    authority: 'db_cleanup_status_only',
    mediaItemId: media,
    expectedAccessRevision: 2,
    observedAccessRevision: 2,
    deleted: true,
    inventoryComplete: true,
    state: 'pending',
    reason: null,
    refs: [{ digest: hash, reason: 'resource_deleted', state: 'pending' }],
    digestVersion: 'postgres-jsonb-v1',
    sourceDigest: hash,
  });
}
function tx(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string) =>
    sql.includes('AS available')
      ? { rows: [{ available: true }], rowCount: 1 }
      : { rows, rowCount: rows.length },
  );
  const transaction: Transaction = { athleteId: media, query };
  return { transaction, query };
}
it('reads only the narrow DB port and keeps the DB-only authority', async () => {
  const s = source(),
    t = tx([{ source: s }]);
  expect(await readRaceMediaCleanupSource(t.transaction, request)).toEqual({
    status: 'available',
    source: s,
  });
  expect(t.query).toHaveBeenCalledWith(
    'SELECT source FROM public.read_race_media_cleanup($1::uuid,$2::integer)',
    [media, 2],
  );
});
it('normalizes requested UUID while preserving exact observed revision', async () => {
  const t = tx([{ source: source() }]);
  expect(
    (
      await readRaceMediaCleanupSource(t.transaction, {
        ...request,
        mediaItemId: media.toUpperCase(),
      })
    ).status,
  ).toBe('available');
});
it.each(['absent', 'pending', 'completed', 'unavailable'] as const)(
  'preserves distinct %s DB statuses without external deletion claims',
  async (state) => {
    const s = source();
    s.state = state;
    if (state === 'absent') {
      s.deleted = false;
      s.refs = [{ digest: hash, reason: null, state: 'absent' }];
    }
    if (state === 'completed')
      s.refs = [{ digest: hash, reason: 'resource_deleted', state: 'completed' }];
    if (state === 'unavailable') {
      s.inventoryComplete = false;
      s.reason = 'QUEUE_TUPLE_UNAVAILABLE';
      s.refs = [{ digest: hash, reason: null, state: 'absent' }];
    }
    expect(
      (await readRaceMediaCleanupSource(tx([{ source: s }]).transaction, request)).status,
    ).toBe('available');
  },
);
it.each([
  { mediaItemId: 'invalid', expectedAccessRevision: 2 },
  { ...request, expectedAccessRevision: 0 },
  { ...request, expectedAccessRevision: 2147483648 },
  { ...request, approved: true },
])('rejects invalid request before querying %j', async (input) => {
  const t = tx([{ source: source() }]);
  expect(await readRaceMediaCleanupSource(t.transaction, input)).toEqual({
    status: 'unavailable',
    reason: 'INVALID_REQUEST',
  });
  expect(t.query).not.toHaveBeenCalled();
});
it.each([
  'foreign',
  'revision',
  'empty',
  'unknown',
  'duplicates',
  'wrongreason',
  'unavailablecomplete',
  'missingpending',
] as const)('rejects invalid DB tuple/inventory %s', async (kind) => {
  let s: unknown = source();
  const v = source();
  if (kind === 'foreign') v.mediaItemId = '00000000-0000-4000-8000-00000000000b';
  if (kind === 'revision') v.expectedAccessRevision = 3;
  if (kind === 'empty') v.refs = [];
  if (kind === 'unknown') s = { ...v, storageRef: 'private/raw' };
  else {
    if (kind === 'duplicates')
      v.refs.push({ ...v.refs[0], digest: hash, reason: 'resource_deleted', state: 'pending' });
    if (kind === 'wrongreason')
      v.refs = [{ digest: hash, reason: 'upload_abandoned', state: 'pending' }];
    if (kind === 'unavailablecomplete') {
      v.state = 'unavailable';
      v.reason = 'INVENTORY_UNAVAILABLE';
    }
    if (kind === 'missingpending')
      v.refs = [{ digest: hash, reason: 'resource_deleted', state: 'completed' }];
    s = v;
  }
  expect(await readRaceMediaCleanupSource(tx([{ source: s }]).transaction, request)).toEqual({
    status: 'unavailable',
    reason: 'INVALID_CLEANUP_SOURCE',
  });
});
it.each(
  [[], [{}, {}], [{ source: null }], [{ source: source(), raw: 'private' }]].map((rows) => ({
    rows,
  })),
)('rejects missing/extra row metadata %j', async ({ rows }) => {
  expect((await readRaceMediaCleanupSource(tx(rows).transaction, request)).status).toBe(
    'unavailable',
  );
});
it('detects missing function or EXECUTE without an aborted query', async () => {
  const query = vi.fn(async () => ({ rows: [{ available: false }], rowCount: 1 }));
  const t: Transaction = { athleteId: media, query };
  expect(await readRaceMediaCleanupSource(t, request)).toEqual({
    status: 'unavailable',
    reason: 'READ_CAPABILITY_UNAVAILABLE',
  });
  expect(query).toHaveBeenCalledTimes(1);
});
it('rejects malformed capability facts rather than treating truthy values as grants', async () => {
  const t: Transaction = {
    athleteId: media,
    query: async () => ({ rows: [{ available: 'true' }], rowCount: 1 }),
  };
  expect(await readRaceMediaCleanupSource(t, request)).toEqual({
    status: 'unavailable',
    reason: 'INVALID_CLEANUP_SOURCE',
  });
});
it('propagates actual SQL caller/fence refusal for outer rollback', async () => {
  const t: Transaction = {
    athleteId: media,
    query: async (sql) => {
      if (sql.includes('AS available')) return { rows: [{ available: true }], rowCount: 1 };
      throw Object.assign(new Error('synthetic refusal'), { code: '42501' });
    },
  };
  await expect(readRaceMediaCleanupSource(t, request)).rejects.toThrow('synthetic refusal');
});
it('preserves unknown DB errors for transaction rollback', async () => {
  const t: Transaction = {
    athleteId: media,
    query: async () => {
      throw Object.assign(new Error('synthetic rollback'), { code: '40001' });
    },
  };
  await expect(readRaceMediaCleanupSource(t, request)).rejects.toThrow('synthetic rollback');
});
it('rejects oversized and cyclic port data', async () => {
  const cycle: Record<string, unknown> = {};
  cycle['cycle'] = cycle;
  for (const s of [cycle, { ...source(), padding: 'x'.repeat(16385) }])
    expect(
      (await readRaceMediaCleanupSource(tx([{ source: s }]).transaction, request)).status,
    ).toBe('unavailable');
});

it('accepts full PostgreSQL INT_MAX read revisions without a write-increment bound', async () => {
  const s = source();
  s.expectedAccessRevision = 2147483647;
  s.observedAccessRevision = 2147483647;
  expect(
    (
      await readRaceMediaCleanupSource(tx([{ source: s }]).transaction, {
        mediaItemId: media,
        expectedAccessRevision: 2147483647,
      })
    ).status,
  ).toBe('available');
});

it('rejects more than64 returned reference tuples before accepting completeness', async () => {
  const s = source();
  s.refs = Array.from({ length: 65 }, (_, n) => ({
    digest: n.toString(16).padStart(64, '0'),
    reason: 'resource_deleted',
    state: 'pending',
  }));
  expect((await readRaceMediaCleanupSource(tx([{ source: s }]).transaction, request)).status).toBe(
    'unavailable',
  );
});
