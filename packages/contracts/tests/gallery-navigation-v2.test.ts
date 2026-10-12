import { describe, expect, it } from 'vitest';
import {
  galleryAlbumV1Schema,
  galleryAlbumCreateCommandV1Schema,
  galleryAlbumRenameCommandV1Schema,
  galleryAlbumDeleteCommandV1Schema,
  galleryAlbumDeleteResultV1Schema,
  galleryCourseLinkV2Schema,
  galleryMediaMembershipCommandV2Schema,
  galleryMediaNavigationV2Schema,
  galleryMediaNavigationQueryV2Schema,
  galleryMediaNavigationPageV2Schema,
  galleryNavigationCursorV2Schema,
  galleryNavigationIdempotencyKeySchema,
} from '../src/gallery-navigation-v2.js';
import { galleryMediaItemSchema } from '../src/gallery.js';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const at = '2026-01-01T00:00:00.000001Z';
const link = { courseId: id, courseRevision: 2, revisionId: other };
function media(key = id, createdAt = at, day: string | null = '2026-01-01') {
  return {
    schemaVersion: 2,
    item: {
      id: key,
      mediaKind: 'image',
      visibility: 'private',
      includeForCoach: false,
      album: '원래 앨범',
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: day,
      file: {
        originalFileName: 'photo.png',
        mediaType: 'image/png',
        byteSize: 10,
        sha256: 'a'.repeat(64),
      },
      preview: null,
      accessRevision: 1,
      createdAt,
      updatedAt: createdAt,
    },
    albumMembership: null,
    courseLink: null,
    capturedDay: day === null ? { state: 'unknown' } : { state: 'known', localDate: day },
  };
}
function query(limit = 2) {
  return {
    filters: {
      album: { mode: 'all' },
      mediaKind: null,
      activityId: null,
      courseLink: null,
      capturedDay: { mode: 'all' },
    },
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  };
}
function page() {
  return {
    schemaVersion: 2,
    query: query(),
    items: [media(id), media(other)],
    hasMore: false,
    nextCursor: null,
  };
}
function cursor() {
  const { cursor: ignored, ...binding } = query();
  void ignored;
  return { cursorVersion: 1, binding, after: { createdAt: at, id: other } };
}

describe('gallery navigation V2', () => {
  it('preserves the entire original media and nullable capture facts', () => {
    const raw = media();
    const result = galleryMediaNavigationV2Schema.parse(raw);
    expect(result.item).toEqual(galleryMediaItemSchema.parse(raw.item));
    expect(result.item.album).toBe('원래 앨범');
    expect(galleryMediaNavigationV2Schema.parse(media(id, at, null)).capturedDay).toEqual({
      state: 'unknown',
    });
    expect(result.item.capturedAt).toBeNull();
  });
  it('requires original stored local day correspondence, never upload-day substitution', () => {
    expect(
      galleryMediaNavigationV2Schema.safeParse({ ...media(), capturedDay: { state: 'unknown' } })
        .success,
    ).toBe(false);
    expect(
      galleryMediaNavigationV2Schema.safeParse({
        ...media(id, at, null),
        capturedDay: { state: 'known', localDate: '2026-01-01' },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationV2Schema.safeParse({
        ...media(),
        capturedDay: { state: 'known', localDate: '2026-01-02' },
      }).success,
    ).toBe(false);
  });
  it('validates album versions/CAS without athlete, header key or source claims', () => {
    const album = {
      schemaVersion: 1,
      id,
      title: ' 앨범 ',
      revision: 2,
      createdAt: at,
      updatedAt: at,
    };
    expect(galleryAlbumV1Schema.parse(album).title).toBe('앨범');
    expect(galleryAlbumCreateCommandV1Schema.parse({ title: '앨범' })).toEqual({ title: '앨범' });
    expect(
      galleryAlbumRenameCommandV1Schema.safeParse({
        albumId: id,
        expectedRevision: 0,
        title: '새 앨범',
      }).success,
    ).toBe(false);
    expect(galleryAlbumDeleteCommandV1Schema.parse({ albumId: id, expectedRevision: 2 })).toEqual({
      albumId: id,
      expectedRevision: 2,
    });
    expect(
      galleryAlbumDeleteResultV1Schema.parse({
        schemaVersion: 1,
        status: 'deleted',
        albumId: id,
        revision: 3,
        detachedMediaCount: 0,
      }).detachedMediaCount,
    ).toBe(0);
    for (const extra of [{ athleteId: id }, { idempotencyKey: 'header-only' }, { approved: true }])
      expect(galleryAlbumCreateCommandV1Schema.safeParse({ title: '앨범', ...extra }).success).toBe(
        false,
      );
    expect(galleryNavigationIdempotencyKeySchema.safeParse('header-key').success).toBe(true);
  });
  it('rejects malformed/control/surrogate/oversized titles and backwards time safely', () => {
    for (const title of ['', 'a'.repeat(101), 'x\u0000', '\ud800'])
      expect(galleryAlbumCreateCommandV1Schema.safeParse({ title }).success).toBe(false);
    expect(
      galleryAlbumV1Schema.safeParse({
        schemaVersion: 1,
        id,
        title: '앨범',
        revision: 1,
        createdAt: at,
        updatedAt: 'bad',
      }).success,
    ).toBe(false);
    expect(
      galleryAlbumV1Schema.safeParse({
        schemaVersion: 1,
        id,
        title: '앨범',
        revision: 1,
        createdAt: at,
        updatedAt: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  it('keeps exact course revision tuples and explicit detach separate from deletion', () => {
    expect(galleryCourseLinkV2Schema.parse(link)).toEqual(link);
    expect(galleryCourseLinkV2Schema.safeParse({ courseId: id, versionId: other }).success).toBe(
      false,
    );
    expect(
      galleryMediaMembershipCommandV2Schema.parse({
        mediaItemId: id,
        expectedAccessRevision: 1,
        albumMembership: null,
        courseLink: link,
      }).courseLink,
    ).toEqual(link);
    expect(galleryCourseLinkV2Schema.safeParse({ ...link, currentHead: true }).success).toBe(false);
  });
  it('keeps cursor navigation query-bound and rejects version/sort/unknown fields', () => {
    const c = cursor();
    expect(galleryNavigationCursorV2Schema.parse(c)).toEqual(c);
    expect(galleryMediaNavigationQueryV2Schema.safeParse({ ...query(), cursor: c }).success).toBe(
      true,
    );
    expect(galleryMediaNavigationQueryV2Schema.safeParse({ ...query(3), cursor: c }).success).toBe(
      false,
    );
    for (const extra of [{ tenantId: id }, { seal: 'claimed-proof' }, { permission: true }])
      expect(galleryNavigationCursorV2Schema.safeParse({ ...c, ...extra }).success).toBe(false);
    expect(galleryNavigationCursorV2Schema.safeParse({ ...c, cursorVersion: 2 }).success).toBe(
      false,
    );
    expect(
      galleryMediaNavigationQueryV2Schema.safeParse({ ...query(), sort: 'raw_sql' }).success,
    ).toBe(false);
  });
  it('validates dates/strict limit and exact query filters', () => {
    for (const limit of [0, 101, 1.5, '2', null])
      expect(galleryMediaNavigationQueryV2Schema.safeParse({ ...query(), limit }).success).toBe(
        false,
      );
    for (const day of [
      { mode: 'stored_local_range', from: '2026-02-30', toInclusive: '2026-03-01' },
      { mode: 'stored_local_range', from: '2026-02-02', toInclusive: '2026-02-01' },
      { mode: 'unknown', from: '2026-01-01' },
    ])
      expect(
        galleryMediaNavigationQueryV2Schema.safeParse({
          ...query(),
          filters: { ...query().filters, capturedDay: day },
        }).success,
      ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        query: { ...query(), filters: { ...query().filters, capturedDay: { mode: 'unknown' } } },
      }).success,
    ).toBe(false);
  });
  it('enforces canonical roster ordering, duplicate identity and page limits', () => {
    expect(galleryMediaNavigationPageV2Schema.parse(page()).items).toHaveLength(2);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), items: [media(other), media(id)] })
        .success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), items: [media(), media()] })
        .success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), query: query(1) }).success,
    ).toBe(false);
  });
  it('preserves microsecond ordering and equivalent offset key boundaries', () => {
    const fine = { ...page(), items: [media(id, '2026-01-01T00:00:00.000002Z'), media(other, at)] };
    expect(galleryMediaNavigationPageV2Schema.safeParse(fine).success).toBe(true);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...fine, items: [...fine.items].reverse() })
        .success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        query: { ...query(), cursor: cursor() },
      }).success,
    ).toBe(false);
  });
  it('requires next cursor to describe full page tail and exact filter binding', () => {
    const c = cursor();
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), hasMore: true, nextCursor: c })
        .success,
    ).toBe(true);
    expect(galleryMediaNavigationPageV2Schema.safeParse({ ...page(), nextCursor: c }).success).toBe(
      false,
    );
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        hasMore: true,
        nextCursor: { ...c, after: { ...c.after, id } },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        hasMore: true,
        nextCursor: { ...c, binding: { ...c.binding, limit: 1 } },
      }).success,
    ).toBe(false);
  });
  it('rejects getters without executing, throwing proxy, sparse and subclass arrays', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'title', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('private');
      },
    });
    expect(galleryAlbumCreateCommandV1Schema.safeParse(getter).success).toBe(false);
    expect(calls).toBe(0);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('private');
        },
      },
    );
    expect(galleryAlbumCreateCommandV1Schema.safeParse(proxy).success).toBe(false);
    class Items extends Array<ReturnType<typeof media>> {}
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), items: new Items(media()) })
        .success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), items: new Array(2) }).success,
    ).toBe(false);
  });
  it('bounds aggregate keys/depth/escaped strings before JSON serialization', () => {
    expect(
      galleryAlbumCreateCommandV1Schema.safeParse({ title: '\\'.repeat(600000) }).success,
    ).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(galleryAlbumCreateCommandV1Schema.safeParse(deep).success).toBe(false);
    expect(
      galleryAlbumCreateCommandV1Schema.safeParse(
        Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [String(i), null])),
      ).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        items: Array.from({ length: 101 }, () => media()),
      }).success,
    ).toBe(false);
  });
  it('parsed outputs detach from caller mutation; legacy rejects V2 wrapper', () => {
    const raw = media();
    const parsed = galleryMediaNavigationV2Schema.parse(raw);
    raw.item.album = '변경';
    raw.item.file.byteSize = 99;
    expect(parsed.item.album).toBe('원래 앨범');
    expect(parsed.item.file.byteSize).toBe(10);
    expect(galleryMediaItemSchema.safeParse(parsed).success).toBe(false);
    expect(
      galleryMediaNavigationV2Schema.safeParse({
        ...media(),
        item: { ...media().item, includeForCoach: true },
      }).success,
    ).toBe(false);
  });
  it('rejects response album/activity/course/kind divergence without changing saved tuples', () => {
    for (const filters of [
      { ...query().filters, album: { mode: 'album', albumId: id } },
      { ...query().filters, activityId: id },
      { ...query().filters, courseLink: link },
      { ...query().filters, mediaKind: 'video' },
    ])
      expect(
        galleryMediaNavigationPageV2Schema.safeParse({ ...page(), query: { ...query(), filters } })
          .success,
      ).toBe(false);
    const linked = { ...media(), albumMembership: { albumId: id }, courseLink: link };
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        items: [linked],
        query: {
          ...query(),
          filters: { ...query().filters, album: { mode: 'album', albumId: id }, courseLink: link },
        },
      }).success,
    ).toBe(true);
  });
  it('never performs Proxy value reads while parsing descriptors into a private snapshot', () => {
    let reads = 0;
    const raw = new Proxy(
      { title: '앨범' },
      {
        get() {
          reads++;
          throw new Error('private');
        },
      },
    );
    expect(galleryAlbumCreateCommandV1Schema.parse(raw)).toEqual({ title: '앨범' });
    expect(reads).toBe(0);
  });
  it('keeps equivalent offset instants and full empty-page pagination honest', () => {
    const offset = '2026-01-01T09:00:00.000001+09:00';
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        items: [media(id, at), media(other, offset)],
      }).success,
    ).toBe(true);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({ ...page(), items: [], hasMore: false })
        .success,
    ).toBe(true);
    expect(
      galleryMediaNavigationPageV2Schema.safeParse({
        ...page(),
        items: [],
        hasMore: true,
        nextCursor: cursor(),
      }).success,
    ).toBe(false);
  });
  it('accepts a complete bounded hundred-item page with distinct stable identities', () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      media(`10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`),
    );
    expect(
      galleryMediaNavigationPageV2Schema.parse({ ...page(), query: query(100), items }).items,
    ).toHaveLength(100);
  });
});

// Count is a scalar receipt fact, not a media collection or response budget.
describe('Gallery deletion receipt int32 count boundary', () => {
  const reply = (detachedMediaCount: unknown) => ({
    schemaVersion: 1,
    status: 'deleted',
    albumId: id,
    revision: 2,
    detachedMediaCount,
  });
  it.each([0, 1000, 1001, 2147483647])(
    'preserves exact detached count %i without a media roster',
    (count) => {
      expect(galleryAlbumDeleteResultV1Schema.parse(reply(count))).toEqual(reply(count));
    },
  );
  it.each([-1, 0.5, 2147483648, NaN, Infinity, null, '1001'])(
    'rejects non-int32 receipt count (%#)',
    (count) => {
      expect(galleryAlbumDeleteResultV1Schema.safeParse(reply(count)).success).toBe(false);
    },
  );
  it('keeps strict keys, revision and getter-free unknown validation for larger counts', () => {
    expect(
      galleryAlbumDeleteResultV1Schema.safeParse({ ...reply(1001), revision: 0 }).success,
    ).toBe(false);
    expect(galleryAlbumDeleteResultV1Schema.safeParse({ ...reply(1001), items: [] }).success).toBe(
      false,
    );
    let invoked = 0;
    const value = reply(1001);
    Object.defineProperty(value, 'detachedMediaCount', {
      enumerable: true,
      get() {
        invoked++;
        return 1001;
      },
    });
    expect(galleryAlbumDeleteResultV1Schema.safeParse(value).success).toBe(false);
    expect(invoked).toBe(0);
  });
});
