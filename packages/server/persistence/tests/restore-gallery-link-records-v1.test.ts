import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createGalleryLinkAccumulatorV1,
  parseGalleryLinkHeaderV1,
  parseGalleryLinkChunkV1,
  galleryLinkEncodingV1,
} from '../src/restore-gallery-link-records-v1.js';
const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const header = (n = 1) => ({
  schemaVersion: 1,
  encoding: galleryLinkEncodingV1,
  source_event_id: id(1),
  athlete_id: 'tenant',
  kind: 'album_deleted',
  idempotency_key: 'key-delete-1',
  request_digest: 'a'.repeat(64),
  album_id: id(2),
  deleted_revision: 2,
  occurred_at: '2026-10-10T00:00:00.123456Z',
  affected_count: n,
});
const row = (n = 1) => ({
  athlete_id: 'tenant',
  kind: 'album_deleted',
  idempotency_key: 'key-delete-1',
  media_item_id: id(n),
  expected_access_revision: 3,
  access_revision: 4,
  album_id: null,
  course_id: null,
  course_revision: null,
  revision_id: null,
});
const chunk = (rows: readonly unknown[] = [row()]) => ({
  schemaVersion: 1,
  encoding: galleryLinkEncodingV1,
  source_event_id: id(1),
  children: rows,
});
test('accepts SQL fields and separates supplied source UUID from authenticated authority', () => {
  const a = createGalleryLinkAccumulatorV1(header());
  assert.equal(a.append(chunk(), 1).ok, true);
  const r = a.complete(id(1), 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.authority, 'none');
    assert.equal(r.value.authenticated, false);
    assert.equal(r.value.admission, false);
    assert.equal(Object.isFrozen(r.value.header), true);
  }
  assert.deepEqual(a.append(chunk(), 1), { ok: false, reason: 'closed' });
});
test('streams 1001 children with chunks bounded to 100 and constant retained summary', () => {
  const a = createGalleryLinkAccumulatorV1(header(1001));
  for (let start = 1; start <= 1001; start += 100) {
    const rows = Array.from({ length: Math.min(100, 1002 - start) }, (_, i) => row(start + i));
    assert.equal(a.append(chunk(rows), 1).ok, true);
  }
  const r = a.complete(id(1001), 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.childCount, 1001);
});
test('empty deletion closes only count0 and null final key, no empty chunks', () => {
  assert.equal(createGalleryLinkAccumulatorV1(header(0)).complete(null, 1).ok, true);
  assert.equal(createGalleryLinkAccumulatorV1(header(0)).complete(id(1), 1).ok, false);
  assert.equal(parseGalleryLinkChunkV1(chunk([])).ok, false);
});
test('int32 count accepts max without allocating roster and rejects overflow', () => {
  assert.equal(parseGalleryLinkHeaderV1(header(2147483647)).ok, true);
  for (const n of [-1, 2147483648, NaN, Infinity, 1.1])
    assert.equal(parseGalleryLinkHeaderV1(header(n)).ok, false);
});
test('membership event has exactly one child and no deleted album identity', () => {
  const h = {
    ...header(),
    kind: 'membership_postimage',
    album_id: null,
    deleted_revision: null,
  };
  const c = { ...row(), kind: 'membership_postimage', album_id: id(3) };
  const a = createGalleryLinkAccumulatorV1(h);
  assert.equal(a.append(chunk([c]), 1).ok, true);
  assert.equal(a.complete(id(1), 1).ok, true);
  assert.equal(parseGalleryLinkHeaderV1({ ...h, affected_count: 0 }).ok, false);
});
test('strict schema denies missing/extra/version/kind/digest/UUID fields', () => {
  for (const h of [
    { ...header(), extra: true },
    { ...header(), schemaVersion: 2 },
    { ...header(), encoding: 'other' },
    { ...header(), kind: 'other' },
    { ...header(), request_digest: 'A'.repeat(64) },
    { ...header(), album_id: 'uuid' },
  ])
    assert.equal(parseGalleryLinkHeaderV1(h).ok, false);
  const { request_digest, ...missing } = header();
  void request_digest;
  assert.equal(parseGalleryLinkHeaderV1(missing).ok, false);
});
test('does not invoke getters, rejects proxy descriptor errors and sparse/extra arrays', () => {
  let calls = 0;
  const h = header();
  Object.defineProperty(h, 'occurred_at', {
    get() {
      calls++;
      return '';
    },
    enumerable: true,
  });
  assert.equal(parseGalleryLinkHeaderV1(h).ok, false);
  assert.equal(calls, 0);
  assert.equal(
    parseGalleryLinkHeaderV1(
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error('private');
          },
        },
      ),
    ).ok,
    false,
  );
  const rows = [row()];
  Object.defineProperty(rows, '0', {
    get() {
      calls++;
      return row();
    },
    enumerable: true,
  });
  assert.equal(parseGalleryLinkChunkV1(chunk(rows)).ok, false);
  assert.equal(calls, 0);
  assert.equal(parseGalleryLinkChunkV1(chunk(new Array(1))).ok, false);
  const extra = [row()];
  Object.defineProperty(extra, 'other', { value: 1 });
  assert.equal(parseGalleryLinkChunkV1(chunk(extra)).ok, false);
});
test('owns immutable row/chunk copies, mutations cannot alter accepted records', () => {
  const ownedRow = row();
  const input = chunk([ownedRow]);
  const r = parseGalleryLinkChunkV1(input);
  assert.equal(r.ok, true);
  ownedRow.access_revision = 99;
  if (r.ok) {
    assert.equal(r.value.children[0]?.access_revision, 4);
    assert.equal(Object.isFrozen(r.value.children), true);
    assert.equal(Object.isFrozen(r.value.children[0]), true);
  }
});
test('revision+1 and complete saved-course tuple are mandatory', () => {
  for (const c of [
    { ...row(), access_revision: 5 },
    {
      ...row(),
      expected_access_revision: 2147483646,
      access_revision: 2147483647,
    },
    { ...row(), course_id: id(5) },
    { ...row(), course_revision: 1 },
    { ...row(), revision_id: id(4) },
    { ...row(), course_id: id(5), course_revision: 0, revision_id: id(4) },
    { ...row(), album_id: id(3) },
  ])
    assert.equal(parseGalleryLinkChunkV1(chunk([c])).ok, false);
  assert.equal(
    parseGalleryLinkChunkV1(
      chunk([
        {
          ...row(),
          course_id: id(5),
          course_revision: 2147483646,
          revision_id: id(4),
        },
      ]),
    ).ok,
    true,
  );
});
test('100 row boundary and strict native UUID byte order', () => {
  assert.equal(
    parseGalleryLinkChunkV1(chunk(Array.from({ length: 100 }, (_, i) => row(i + 1)))).ok,
    true,
  );
  assert.equal(
    parseGalleryLinkChunkV1(chunk(Array.from({ length: 101 }, (_, i) => row(i + 1)))).ok,
    false,
  );
  for (const rows of [
    [row(), row()],
    [row(2), row(1)],
  ])
    assert.deepEqual(parseGalleryLinkChunkV1(chunk(rows)), {
      ok: false,
      reason: 'order_or_duplicate',
    });
});
test('orphan/foreign source, athlete, kind and command are denied', () => {
  for (const c of [
    { ...chunk(), source_event_id: id(99) },
    chunk([{ ...row(), athlete_id: 'foreign' }]),
    chunk([{ ...row(), kind: 'membership_postimage' }]),
    chunk([{ ...row(), idempotency_key: 'key-other-1' }]),
  ]) {
    const a = createGalleryLinkAccumulatorV1(header());
    assert.deepEqual(a.append(c, 1), { ok: false, reason: 'foreign_group' });
    assert.equal(a.complete(null, 1).ok, false);
  }
});
test('cross-chunk duplicate/reorder poison closure and extra child rejected', () => {
  const a = createGalleryLinkAccumulatorV1(header(2));
  assert.equal(a.append(chunk([row(2)]), 1).ok, true);
  assert.deepEqual(a.append(chunk([row(1)]), 1), {
    ok: false,
    reason: 'order_or_duplicate',
  });
  assert.equal(a.complete(id(2), 1).ok, false);
  assert.deepEqual(createGalleryLinkAccumulatorV1(header()).append(chunk([row(), row(2)]), 1), {
    ok: false,
    reason: 'extra_children',
  });
});
test('missing children and final native key mismatch fail closed', () => {
  const a = createGalleryLinkAccumulatorV1(header(2));
  a.append(chunk(), 1);
  assert.deepEqual(a.complete(id(1), 1), {
    ok: false,
    reason: 'missing_children',
  });
  const b = createGalleryLinkAccumulatorV1(header());
  b.append(chunk(), 1);
  assert.deepEqual(b.complete(id(2), 1), {
    ok: false,
    reason: 'last_key_mismatch',
  });
});
test('cancel/reset prevent late old generation from modifying new group', () => {
  const a = createGalleryLinkAccumulatorV1(header());
  a.cancel();
  assert.deepEqual(a.append(chunk(), 1), { ok: false, reason: 'cancelled' });
  assert.equal(a.reset({ ...header(), source_event_id: id(7) }).ok, true);
  assert.deepEqual(a.append(chunk(), 1), {
    ok: false,
    reason: 'stale_generation',
  });
  assert.equal(a.append({ ...chunk(), source_event_id: id(7) }, 2).ok, true);
  assert.equal(a.complete(id(1), 2).ok, true);
});
test('invalid reset cannot recover by accepting old events; timestamp not used as sequence', () => {
  const a = createGalleryLinkAccumulatorV1(header());
  assert.equal(a.reset({}).ok, false);
  assert.equal(a.append(chunk(), 2).ok, false);
  for (const stamp of [
    'infinity',
    '2026-02-30T00:00:00.000000Z',
    '2026-10-10T00:00:00.000000+01:00',
  ])
    assert.equal(parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp }).ok, false);
  assert.equal(
    parseGalleryLinkHeaderV1({
      ...header(),
      occurred_at: '2000-01-01T00:00:00.000000Z',
    }).ok,
    true,
  );
});

test('preserves finite BC1 and earliest PG UTC6 microseconds without epoch coercion', () => {
  for (const stamp of [
    '0001-01-01T00:00:00.000000Z BC',
    '0001-02-29T23:59:59.999999Z BC',
    '4714-11-24T00:00:00.000000Z BC',
    '4714-11-24T00:00:00.000001Z BC',
  ]) {
    const r = parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.occurred_at, stamp);
  }
  for (const stamp of [
    '4714-11-23T23:59:59.999999Z BC',
    '4715-01-01T00:00:00.000000Z BC',
    '0000-01-01T00:00:00.000000Z BC',
    '0002-02-29T00:00:00.000000Z BC',
  ])
    assert.equal(parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp }).ok, false);
});
test('accepts extended years and exact PG upper edge, rejects next microsecond', () => {
  for (const stamp of [
    '10000-01-01T00:00:00.000001Z',
    '10000-02-29T00:00:00.123456Z',
    '294276-12-31T23:59:59.999998Z',
    '294276-12-31T23:59:59.999999Z',
  ]) {
    const r = parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.occurred_at, stamp);
  }
  for (const stamp of [
    '294277-01-01T00:00:00.000000Z',
    '999999-12-31T23:59:59.999999Z',
    '294276-12-31T24:00:00.000000Z',
    '1000000-01-01T00:00:00.000000Z',
  ])
    assert.equal(parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp }).ok, false);
});
test('rejects infinities and malformed calendar/time while preserving leap and microsecond text', () => {
  for (const stamp of [
    'infinity',
    '-infinity',
    '1900-02-29T00:00:00.000000Z',
    '2100-02-29T00:00:00.000000Z',
    '10000-13-01T00:00:00.000000Z',
    '10000-04-31T00:00:00.000000Z',
    '10000-00-01T00:00:00.000000Z',
    '10000-01-00T00:00:00.000000Z',
    '10000-01-01T00:60:00.000000Z',
    '10000-01-01T00:00:60.000000Z',
    '10000-01-01T00:00:00.00000Z',
    '10000-01-01T00:00:00.0000000Z',
    '10000-01-01T00:00:00.000000+00:00',
    '0000-01-01T00:00:00.000000Z',
  ])
    assert.equal(parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp }).ok, false);
  for (const stamp of [
    '2000-02-29T00:00:00.000000Z',
    '2000-02-29T00:00:00.000001Z',
    '2400-02-29T00:00:00.999999Z',
  ]) {
    const r = parseGalleryLinkHeaderV1({ ...header(), occurred_at: stamp });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.occurred_at, stamp);
  }
});
