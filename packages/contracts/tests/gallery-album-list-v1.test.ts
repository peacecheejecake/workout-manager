import { expect, it } from 'vitest';
import {
  galleryAlbumListQueryV1Schema as Query,
  galleryAlbumListPageV1Schema as Page,
  galleryNavigationV2Limits,
} from '../src/gallery-navigation-v2.js';
const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00.000002Z',
  old = '2026-01-01T00:00:00.000001Z';
const query = (limit = 2) => ({ limit, sort: 'created_desc_id_asc', cursor: null });
const album = (n: number, createdAt = at) => ({
  schemaVersion: 1,
  id: id(n),
  title: `앨범 ${n}`,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
});
const cursor = (n: number, createdAt = at, limit = 2) => ({
  cursorVersion: 1,
  binding: { limit, sort: 'created_desc_id_asc' },
  after: { id: id(n), createdAt },
});
const page = () => ({
  schemaVersion: 1,
  query: query(),
  items: [album(1), album(2)],
  hasMore: false,
  nextCursor: null,
});
it('accepts known empty end and exact full continuation', () => {
  expect(Page.parse({ ...page(), items: [] }).items).toEqual([]);
  const full = { ...page(), hasMore: true, nextCursor: cursor(2) };
  expect(Page.parse(full).nextCursor).toEqual(full.nextCursor);
  expect(Page.parse(page()).hasMore).toBe(false);
});
it('sorts microseconds descending with ascending ID ties', () => {
  const p = { ...page(), items: [album(9), album(1, old)] };
  expect(Page.safeParse(p).success).toBe(true);
  expect(Page.safeParse({ ...p, items: [...p.items].reverse() }).success).toBe(false);
  expect(Page.safeParse({ ...page(), items: [album(2), album(1)] }).success).toBe(false);
});
it('requires strictly after boundary without losing submillisecond precision', () => {
  const p = { ...page(), query: { ...query(), cursor: cursor(9) }, items: [album(1, old)] };
  expect(Page.safeParse(p).success).toBe(true);
  for (const n of [8, 9]) expect(Page.safeParse({ ...p, items: [album(n)] }).success).toBe(false);
  expect(Page.safeParse({ ...p, items: [album(10)] }).success).toBe(true);
});
it('rejects duplicate identity even at different timestamps', () => {
  expect(Page.safeParse({ ...page(), items: [album(1), album(1, old)] }).success).toBe(false);
});
it.each([0, -1, 101, 1.5, '2', null])('rejects invalid query limit %s', (limit) => {
  expect(Query.safeParse({ ...query(), limit }).success).toBe(false);
});
it('binds cursor limit sort and version', () => {
  expect(Query.safeParse({ ...query(), cursor: cursor(1) }).success).toBe(true);
  for (const p of [
    { ...query(3), cursor: cursor(1) },
    { ...query(), sort: 'other' },
    { ...query(), cursor: { ...cursor(1), cursorVersion: 2 } },
    { ...query(), cursor: { ...cursor(1), binding: { limit: 2, sort: 'other' } } },
  ])
    expect(Query.safeParse(p).success).toBe(false);
});
it('requires full hasMore page with exact last key', () => {
  for (const p of [
    { ...page(), items: [album(1)], hasMore: true, nextCursor: cursor(1) },
    { ...page(), items: [], hasMore: true, nextCursor: cursor(1) },
    { ...page(), hasMore: true },
    { ...page(), nextCursor: cursor(2) },
  ])
    expect(Page.safeParse(p).success).toBe(false);
  for (const nextCursor of [cursor(1), cursor(2, old), cursor(2, at, 3)])
    expect(Page.safeParse({ ...page(), hasMore: true, nextCursor }).success).toBe(false);
});
it('rejects impossible updated time and unsupported precision', () => {
  expect(Page.safeParse({ ...page(), items: [{ ...album(1), updatedAt: old }] }).success).toBe(
    false,
  );
  expect(
    Page.safeParse({ ...page(), items: [album(1, '2026-01-01T00:00:00.0000001Z')] }).success,
  ).toBe(false);
});
it('rejects page capacity overflow and query limit overflow', () => {
  expect(
    Page.safeParse({
      ...page(),
      query: query(100),
      items: Array.from({ length: 101 }, (_, i) => album(i + 1)),
    }).success,
  ).toBe(false);
  expect(Page.safeParse({ ...page(), query: query(1) }).success).toBe(false);
});
it('rejects unknown properties and wrong types/version', () => {
  for (const p of [
    null,
    [],
    { ...page(), schemaVersion: 2 },
    { ...page(), authority: true },
    { ...page(), hasMore: 'false' },
    { ...page(), items: [{ ...album(1), revision: '1' }] },
  ])
    expect(Page.safeParse(p).success).toBe(false);
});
it('never invokes outer or nested getters', () => {
  let invoked = 0;
  const q = query();
  Object.defineProperty(q, 'limit', {
    enumerable: true,
    get() {
      invoked++;
      return 2;
    },
  });
  const entry = album(1);
  Object.defineProperty(entry, 'title', {
    enumerable: true,
    get() {
      invoked++;
      return 'bad';
    },
  });
  expect(Query.safeParse(q).success).toBe(false);
  expect(Page.safeParse({ ...page(), items: [entry] }).success).toBe(false);
  expect(invoked).toBe(0);
});
it('fails closed without throwing for hostile traps and nonplain inputs', () => {
  for (const p of [
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    ),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    ),
    new Date(),
    Object.create(null),
  ]) {
    let success = true;
    expect(() => {
      success = Query.safeParse(p).success;
    }).not.toThrow();
    expect(success).toBe(false);
  }
});
it('rejects sparse extra symbol cyclic and escaped oversized input', () => {
  const extra = [album(1)];
  Object.defineProperty(extra, 'extra', { enumerable: true, value: true });
  const symbol = page();
  Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const p of [
    { ...page(), items: new Array(1) },
    { ...page(), items: extra },
    symbol,
    { ...page(), items: cycle },
    {
      ...page(),
      items: [{ ...album(1), title: '\\'.repeat(galleryNavigationV2Limits.encodedBytes) }],
    },
  ])
    expect(Page.safeParse(p).success).toBe(false);
});
