/** Presentation-neutral source records. UUID provenance is not authenticated WAL authority. */
export const galleryLinkEncodingV1 = 'gallery-link-source-event-v1';
export type GalleryLinkKindV1 = 'membership_postimage' | 'album_deleted';
export type GalleryLinkHeaderV1 = Readonly<{
  schemaVersion: 1;
  encoding: typeof galleryLinkEncodingV1;
  source_event_id: string;
  athlete_id: string;
  kind: GalleryLinkKindV1;
  idempotency_key: string;
  request_digest: string;
  album_id: string | null;
  deleted_revision: number | null;
  occurred_at: string;
  affected_count: number;
}>;
export type GalleryLinkChildV1 = Readonly<{
  athlete_id: string;
  kind: GalleryLinkKindV1;
  idempotency_key: string;
  media_item_id: string;
  expected_access_revision: number;
  access_revision: number;
  album_id: string | null;
  course_id: string | null;
  course_revision: number | null;
  revision_id: string | null;
}>;
export type GalleryLinkChunkV1 = Readonly<{
  schemaVersion: 1;
  encoding: typeof galleryLinkEncodingV1;
  source_event_id: string;
  children: readonly GalleryLinkChildV1[];
}>;
export type GalleryLinkFailureV1 =
  | 'invalid'
  | 'foreign_group'
  | 'order_or_duplicate'
  | 'extra_children'
  | 'missing_children'
  | 'last_key_mismatch'
  | 'cancelled'
  | 'closed'
  | 'stale_generation';
export type GalleryLinkResultV1<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: GalleryLinkFailureV1 }>;
const success = <T>(value: T): GalleryLinkResultV1<T> => Object.freeze({ ok: true, value });
const failure = (reason: GalleryLinkFailureV1): GalleryLinkResultV1<never> =>
  Object.freeze({ ok: false, reason });
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const kind = (v: unknown): v is GalleryLinkKindV1 =>
  v === 'membership_postimage' || v === 'album_deleted';
const tenant = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length >= 1 &&
  v.length <= 400 &&
  Array.from(v).length <= 200 &&
  !v.includes(String.fromCharCode(0)) &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const commandKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(v);
function fields(raw: unknown, names: readonly string[]): Record<string, unknown> | null {
  try {
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype
    )
      return null;
    const keys = Reflect.ownKeys(raw);
    if (
      keys.length !== names.length ||
      keys.some((k) => typeof k !== 'string' || !names.includes(k))
    )
      return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}
// Adapted from physical V2 calendar (PostgreSQL REL_17_6 date2j/timestamp limits).
// Only finite UTC6 values: retained text is returned unchanged; no epoch Number/Date.
function instant(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 36) return false;
  const match = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z( BC)?$/.exec(v);
  if (!match) return false;
  const [yearText, monthText, dayText, hourText, minuteText, secondText, microText] = match.slice(
    1,
    8,
  );
  if (!yearText || !monthText || !dayText || !hourText || !minuteText || !secondText || !microText)
    return false;
  const year = BigInt(yearText),
    bc = Boolean(match[8]);
  if (year === 0n || (bc && year > 4714n)) return false;
  const y = bc ? 1n - year : year;
  const month = BigInt(monthText),
    day = BigInt(dayText);
  const leap = y % 4n === 0n && (y % 100n !== 0n || y % 400n === 0n);
  const days = month === 2n ? (leap ? 29n : 28n) : [4n, 6n, 9n, 11n].includes(month) ? 30n : 31n;
  if (month < 1n || month > 12n || day < 1n || day > days) return false;
  const adjustedYear = y + (month > 2n ? 4800n : 4799n);
  const adjustedMonth = month + (month > 2n ? 1n : 13n);
  const century = adjustedYear / 100n;
  const julian =
    adjustedYear * 365n -
    32167n +
    adjustedYear / 4n -
    century +
    century / 4n +
    (7834n * adjustedMonth) / 256n +
    day;
  const hour = BigInt(hourText),
    minute = BigInt(minuteText),
    second = BigInt(secondText);
  if (hour > 23n || minute > 59n || second > 59n) return false;
  const micros =
    (julian - 2451545n) * 86400000000n +
    hour * 3600000000n +
    minute * 60000000n +
    second * 1000000n +
    BigInt(microText);
  return micros >= -211813488000000000n && micros < 9223371331200000000n;
}
export function parseGalleryLinkHeaderV1(raw: unknown): GalleryLinkResultV1<GalleryLinkHeaderV1> {
  const x = fields(raw, [
    'schemaVersion',
    'encoding',
    'source_event_id',
    'athlete_id',
    'kind',
    'idempotency_key',
    'request_digest',
    'album_id',
    'deleted_revision',
    'occurred_at',
    'affected_count',
  ]);
  if (
    !x ||
    x.schemaVersion !== 1 ||
    x.encoding !== galleryLinkEncodingV1 ||
    !uuid(x.source_event_id) ||
    !tenant(x.athlete_id) ||
    !kind(x.kind) ||
    !commandKey(x.idempotency_key) ||
    typeof x.request_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(x.request_digest) ||
    !instant(x.occurred_at) ||
    !integer(x.affected_count, 0, 2147483647)
  )
    return failure('invalid');
  if (
    !(x.album_id === null || uuid(x.album_id)) ||
    !(x.deleted_revision === null || integer(x.deleted_revision, 2, 2147483646))
  )
    return failure('invalid');
  if (
    x.kind === 'membership_postimage'
      ? x.album_id !== null || x.deleted_revision !== null || x.affected_count !== 1
      : x.album_id === null || x.deleted_revision === null
  )
    return failure('invalid');
  return success(
    Object.freeze({
      schemaVersion: 1,
      encoding: galleryLinkEncodingV1,
      source_event_id: x.source_event_id,
      athlete_id: x.athlete_id,
      kind: x.kind,
      idempotency_key: x.idempotency_key,
      request_digest: x.request_digest,
      album_id: x.album_id,
      deleted_revision: x.deleted_revision,
      occurred_at: x.occurred_at,
      affected_count: x.affected_count,
    }),
  );
}
function child(raw: unknown): GalleryLinkChildV1 | null {
  const x = fields(raw, [
    'athlete_id',
    'kind',
    'idempotency_key',
    'media_item_id',
    'expected_access_revision',
    'access_revision',
    'album_id',
    'course_id',
    'course_revision',
    'revision_id',
  ]);
  if (
    !x ||
    !tenant(x.athlete_id) ||
    !kind(x.kind) ||
    !commandKey(x.idempotency_key) ||
    !uuid(x.media_item_id) ||
    !integer(x.expected_access_revision, 1, 2147483645) ||
    !integer(x.access_revision, 2, 2147483646) ||
    x.access_revision !== x.expected_access_revision + 1 ||
    !(x.album_id === null || uuid(x.album_id)) ||
    !(x.course_id === null || uuid(x.course_id)) ||
    !(x.revision_id === null || uuid(x.revision_id)) ||
    !(x.course_revision === null || integer(x.course_revision, 1, 2147483646))
  )
    return null;
  if (
    x.course_id === null
      ? x.course_revision !== null || x.revision_id !== null
      : x.course_revision === null || x.revision_id === null
  )
    return null;
  if (x.kind === 'album_deleted' && x.album_id !== null) return null;
  return Object.freeze({
    athlete_id: x.athlete_id,
    kind: x.kind,
    idempotency_key: x.idempotency_key,
    media_item_id: x.media_item_id,
    expected_access_revision: x.expected_access_revision,
    access_revision: x.access_revision,
    album_id: x.album_id,
    course_id: x.course_id,
    course_revision: x.course_revision,
    revision_id: x.revision_id,
  });
}
export function parseGalleryLinkChunkV1(raw: unknown): GalleryLinkResultV1<GalleryLinkChunkV1> {
  try {
    const x = fields(raw, ['schemaVersion', 'encoding', 'source_event_id', 'children']);
    if (
      !x ||
      x.schemaVersion !== 1 ||
      x.encoding !== galleryLinkEncodingV1 ||
      !uuid(x.source_event_id) ||
      !Array.isArray(x.children) ||
      Object.getPrototypeOf(x.children) !== Array.prototype
    )
      return failure('invalid');
    const length = Object.getOwnPropertyDescriptor(x.children, 'length');
    if (
      !length ||
      !integer(length.value, 1, 100) ||
      Reflect.ownKeys(x.children).length !== length.value + 1
    )
      return failure('invalid');
    const children: GalleryLinkChildV1[] = [];
    let last = '';
    for (let i = 0; i < length.value; i++) {
      const d = Object.getOwnPropertyDescriptor(x.children, String(i));
      const row = d && 'value' in d && d.enumerable ? child(d.value) : null;
      if (!row) return failure('invalid');
      if (row.media_item_id <= last) return failure('order_or_duplicate');
      children.push(row);
      last = row.media_item_id;
    }
    return success(
      Object.freeze({
        schemaVersion: 1,
        encoding: galleryLinkEncodingV1,
        source_event_id: x.source_event_id,
        children: Object.freeze(children),
      }),
    );
  } catch {
    return failure('invalid');
  }
}
export type GalleryLinkClosureV1 = Readonly<{
  header: GalleryLinkHeaderV1;
  childCount: number;
  lastMediaItemId: string | null;
  authority: 'none';
  authenticated: false;
  admission: false;
}>;
export interface GalleryLinkAccumulatorV1 {
  generation(): number;
  append(
    rawChunk: unknown,
    token: number,
  ): GalleryLinkResultV1<Readonly<{ childCount: number; lastMediaItemId: string | null }>>;
  complete(
    expectedLastMediaItemId: unknown,
    token: number,
  ): GalleryLinkResultV1<GalleryLinkClosureV1>;
  cancel(): void;
  reset(nextHeader: unknown): GalleryLinkResultV1<number>;
}
/** Constant retained memory: header, generation, count and one native UUID key. No full roster cache. */
export function createGalleryLinkAccumulatorV1(rawHeader: unknown): GalleryLinkAccumulatorV1 {
  let parsed = parseGalleryLinkHeaderV1(rawHeader);
  let generation = 1;
  let count = 0;
  let last: string | null = null;
  let stopped: GalleryLinkFailureV1 | null = parsed.ok ? null : 'invalid';
  function reject(reason: GalleryLinkFailureV1) {
    stopped = reason;
    return failure(reason);
  }
  return Object.freeze({
    generation: () => generation,
    append(
      rawChunk: unknown,
      token: number,
    ): GalleryLinkResultV1<Readonly<{ childCount: number; lastMediaItemId: string | null }>> {
      if (token !== generation) return failure('stale_generation');
      if (stopped) return failure(stopped);
      if (!parsed.ok) return reject('invalid');
      const chunk = parseGalleryLinkChunkV1(rawChunk);
      if (!chunk.ok) return reject(chunk.reason);
      const h = parsed.value;
      if (
        chunk.value.source_event_id !== h.source_event_id ||
        chunk.value.children.some(
          (c) =>
            c.athlete_id !== h.athlete_id ||
            c.kind !== h.kind ||
            c.idempotency_key !== h.idempotency_key,
        )
      )
        return reject('foreign_group');
      if (count + chunk.value.children.length > h.affected_count) return reject('extra_children');
      for (const row of chunk.value.children) {
        if (last !== null && row.media_item_id <= last) return reject('order_or_duplicate');
        last = row.media_item_id;
      }
      count += chunk.value.children.length;
      return success(Object.freeze({ childCount: count, lastMediaItemId: last }));
    },
    complete(
      expectedLastMediaItemId: unknown,
      token: number,
    ): GalleryLinkResultV1<GalleryLinkClosureV1> {
      if (token !== generation) return failure('stale_generation');
      if (stopped) return failure(stopped);
      if (!parsed.ok) return reject('invalid');
      if (!(expectedLastMediaItemId === null || uuid(expectedLastMediaItemId)))
        return reject('invalid');
      if (count !== parsed.value.affected_count) return reject('missing_children');
      if (last !== expectedLastMediaItemId) return reject('last_key_mismatch');
      stopped = 'closed';
      return success(
        Object.freeze({
          header: parsed.value,
          childCount: count,
          lastMediaItemId: last,
          authority: 'none',
          authenticated: false,
          admission: false,
        }),
      );
    },
    cancel() {
      stopped = 'cancelled';
    },
    reset(nextHeader: unknown): GalleryLinkResultV1<number> {
      if (generation === Number.MAX_SAFE_INTEGER) return reject('invalid');
      generation++;
      parsed = parseGalleryLinkHeaderV1(nextHeader);
      count = 0;
      last = null;
      stopped = parsed.ok ? null : 'invalid';
      return parsed.ok ? success(generation) : failure('invalid');
    },
  });
}
