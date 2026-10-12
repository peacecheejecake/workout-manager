import { describe, expect, it } from 'vitest';
import {
  GalleryNavigationRowsError,
  mapGalleryAlbumRow,
  mapGalleryAlbumRowsPage,
  mapGalleryNavigationRow,
  mapGalleryNavigationRowsPage,
} from '../src/gallery-navigation-rows.js';

const owner = 'synthetic-owner';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = '2026-10-09T00:00:00.000002Z';
const album = () => ({
  athlete_id: owner,
  id,
  title: '합성 앨범',
  revision: 1,
  created_at: at,
  updated_at: at,
  deleted_at: null,
});
const media = () => ({
  athlete_id: owner,
  id,
  media_kind: 'image',
  visibility: 'private',
  include_for_coach: false,
  album: null,
  caption: null,
  activity_id: null,
  captured_at: null,
  captured_local_date: null,
  original_filename: 'synthetic.png',
  media_type: 'image/png',
  size_bytes: '1',
  content_hash: 'a'.repeat(64),
  access_revision: 1,
  created_at: at,
  updated_at: at,
  deleted_at: null,
  preview_media_type: null,
  preview_size_bytes: null,
  preview_content_hash: null,
  album_id: null,
  album_athlete_id: null,
  course_id: null,
  course_revision: null,
  course_revision_id: null,
  course_athlete_id: null,
});
const query = () => ({
  filters: {
    album: { mode: 'all' },
    mediaKind: null,
    activityId: null,
    courseLink: null,
    capturedDay: { mode: 'all' },
  },
  limit: 1,
  sort: 'created_desc_id_asc',
  cursor: null,
});
const albumQuery = () => ({ limit: 1, sort: 'created_desc_id_asc', cursor: null });
function rejected(read: () => unknown) {
  expect(read).toThrow(GalleryNavigationRowsError);
}

describe('gallery SQL projection mapping', () => {
  it('preserves microseconds and absent capture facts without fabricating dates or relations', () => {
    const dto = mapGalleryNavigationRow(owner, media());
    expect(dto.item.createdAt).toBe(at);
    expect(dto.item.file.byteSize).toBe(1);
    expect(dto.item.includeForCoach).toBe(false);
    expect(dto.item.capturedAt).toBeNull();
    expect(dto.capturedDay).toEqual({ state: 'unknown' });
    expect(dto.albumMembership).toBeNull();
    expect(dto.courseLink).toBeNull();
    expect(dto.item.preview).toBeNull();
  });
  it('preserves stored local date and exact saved course tuple independently of capture instant', () => {
    const dto = mapGalleryNavigationRow(owner, {
      ...media(),
      captured_local_date: '2026-10-08',
      album: 'legacy label',
      album_id: other,
      album_athlete_id: owner,
      course_id: third,
      course_revision: 2,
      course_revision_id: id,
      course_athlete_id: owner,
    });
    expect(dto.capturedDay).toEqual({ state: 'known', localDate: '2026-10-08' });
    expect(dto.courseLink).toEqual({ courseId: third, courseRevision: 2, revisionId: id });
    expect(dto.item.album).toBe('legacy label');
    expect(dto.albumMembership).toEqual({ albumId: other });
  });
  it('requires complete preview, album and course joins rather than dropping partial facts', () => {
    for (const patch of [
      { preview_media_type: 'image/png' },
      { album_id: other },
      { course_id: other },
      { course_revision: 0 },
      { course_revision_id: other },
    ])
      rejected(() => mapGalleryNavigationRow(owner, { ...media(), ...patch }));
    const dto = mapGalleryNavigationRow(owner, {
      ...media(),
      preview_media_type: 'image/png',
      preview_size_bytes: '2',
      preview_content_hash: 'b'.repeat(64),
    });
    expect(dto.item.preview?.byteSize).toBe(2);
  });
  it('rejects foreign owner facts and non-live rows for media and albums', () => {
    rejected(() => mapGalleryAlbumRow('foreign', album()));
    rejected(() => mapGalleryNavigationRow('foreign', media()));
    rejected(() =>
      mapGalleryNavigationRow(owner, { ...media(), album_id: other, album_athlete_id: 'foreign' }),
    );
    rejected(() =>
      mapGalleryNavigationRow(owner, {
        ...media(),
        course_id: other,
        course_revision: 1,
        course_revision_id: third,
        course_athlete_id: 'foreign',
      }),
    );
    rejected(() => mapGalleryAlbumRow(owner, { ...album(), deleted_at: at }));
    rejected(() => mapGalleryNavigationRow(owner, { ...media(), deleted_at: at }));
  });
  it('rejects Date, offsets, missing SQL precision, invalid dates and excessive precision', () => {
    for (const created_at of [
      new Date(at),
      '2026-10-09T00:00:00.000Z',
      '2026-10-09T00:00:00.000002+00:00',
      '2026-02-30T00:00:00.000002Z',
      '2026-10-09T00:00:00.0000002Z',
    ]) {
      rejected(() => mapGalleryNavigationRow(owner, { ...media(), created_at }));
      rejected(() => mapGalleryAlbumRow(owner, { ...album(), created_at }));
    }
  });
  it('rejects unknown fields, missing facts and accessors without invoking getters', () => {
    let reads = 0;
    const raw = { ...media() };
    Object.defineProperty(raw, 'caption', {
      enumerable: true,
      get() {
        reads++;
        return 'private';
      },
    });
    rejected(() => mapGalleryNavigationRow(owner, raw));
    expect(reads).toBe(0);
    rejected(() => mapGalleryAlbumRow(owner, { ...album(), storage_ref: 'private' }));
    const { caption: omitted, ...missing } = media();
    expect(omitted).toBeNull();
    rejected(() => mapGalleryNavigationRow(owner, missing));
    rejected(() => mapGalleryNavigationRow(owner, Object.create(media())));
  });
  it('does not coerce zero, null, malformed byte strings or unsupported public metadata', () => {
    for (const size_bytes of [0, null, '0', '01', '1e2', '67108865', false])
      rejected(() => mapGalleryNavigationRow(owner, { ...media(), size_bytes }));
    rejected(() => mapGalleryNavigationRow(owner, { ...media(), include_for_coach: true }));
    rejected(() => mapGalleryAlbumRow(owner, { ...album(), revision: 0 }));
    rejected(() => mapGalleryNavigationRow(owner, { ...media(), access_revision: 2147483647 }));
    rejected(() => mapGalleryNavigationRow(owner, { ...media(), caption: ' padded ' }));
    rejected(() =>
      mapGalleryNavigationRow(owner, { ...media(), updated_at: '2026-10-09T00:00:00.000001Z' }),
    );
    rejected(() =>
      mapGalleryAlbumRow(owner, { ...album(), updated_at: '2026-10-09T00:00:00.000001Z' }),
    );
  });
  it('builds exact continuation from microsecond keys and accepts a terminal empty page', () => {
    const older = { ...media(), id: other, created_at: '2026-10-09T00:00:00.000001Z' };
    const page = mapGalleryNavigationRowsPage(owner, query(), [media(), older]);
    expect(page.items.map((v) => v.item.id)).toEqual([id]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor?.after).toEqual({ createdAt: at, id });
    expect(page.nextCursor?.binding.filters).toEqual(query().filters);
    const next = mapGalleryNavigationRowsPage(owner, { ...query(), cursor: page.nextCursor }, [
      older,
    ]);
    expect(next.items[0]?.item.createdAt).toBe(older.created_at);
    expect(next.nextCursor).toBeNull();
    expect(mapGalleryNavigationRowsPage(owner, query(), []).hasMore).toBe(false);
  });
  it('uses ID ascending ties and rejects unordered or duplicate lookahead rows', () => {
    expect(
      mapGalleryNavigationRowsPage(owner, query(), [media(), { ...media(), id: other }]).hasMore,
    ).toBe(true);
    rejected(() =>
      mapGalleryNavigationRowsPage(owner, query(), [{ ...media(), id: other }, media()]),
    );
    rejected(() => mapGalleryNavigationRowsPage(owner, query(), [media(), media()]));
    rejected(() =>
      mapGalleryNavigationRowsPage(owner, query(), [
        media(),
        { ...media(), id: other, created_at: '2026-10-09T00:00:00.000003Z' },
      ]),
    );
  });
  it('checks complete filter binding and validates filtered lookahead too', () => {
    const filtered = {
      ...query(),
      filters: { ...query().filters, capturedDay: { mode: 'unknown' } },
    };
    rejected(() =>
      mapGalleryNavigationRowsPage(owner, filtered, [
        media(),
        { ...media(), id: other, captured_local_date: '2026-10-08' },
      ]),
    );
    const page = mapGalleryNavigationRowsPage(owner, query(), [media(), { ...media(), id: other }]);
    rejected(() =>
      mapGalleryNavigationRowsPage(owner, { ...filtered, cursor: page.nextCursor }, []),
    );
    for (const filters of [
      { ...query().filters, album: { mode: 'album', albumId: other } },
      { ...query().filters, mediaKind: 'video' },
      { ...query().filters, activityId: other },
      { ...query().filters, courseLink: { courseId: other, courseRevision: 1, revisionId: third } },
    ])
      rejected(() => mapGalleryNavigationRowsPage(owner, { ...query(), filters }, [media()]));
  });
  it('rejects oversized, sparse and accessor rosters before consuming a row', () => {
    rejected(() => mapGalleryNavigationRowsPage(owner, query(), [media(), media(), media()]));
    rejected(() => mapGalleryNavigationRowsPage(owner, query(), new Array(1)));
    let reads = 0;
    const rows = [media()];
    Object.defineProperty(rows, '0', {
      enumerable: true,
      get() {
        reads++;
        return media();
      },
    });
    rejected(() => mapGalleryNavigationRowsPage(owner, query(), rows));
    expect(reads).toBe(0);
    rejected(() => mapGalleryNavigationRowsPage(null, query(), []));
  });
  it('validates the bounded 101-row lookahead at maximum page size without dropping sentinel facts', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...media(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    const page = mapGalleryNavigationRowsPage(owner, { ...query(), limit: 100 }, rows);
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor?.after.id).toBe(rows[99]?.id);
    rejected(() =>
      mapGalleryNavigationRowsPage(owner, { ...query(), limit: 100 }, [
        ...rows.slice(0, 100),
        { ...rows[100], content_hash: 'invalid' },
      ]),
    );
  });
  it('applies the public album page ordering and continuation rules including sentinel validation', () => {
    const page = mapGalleryAlbumRowsPage(owner, albumQuery(), [album(), { ...album(), id: other }]);
    expect(page.nextCursor?.after).toEqual({ createdAt: at, id });
    expect(
      mapGalleryAlbumRowsPage(owner, { ...albumQuery(), cursor: page.nextCursor }, [
        { ...album(), id: other },
      ]).hasMore,
    ).toBe(false);
    rejected(() =>
      mapGalleryAlbumRowsPage(owner, albumQuery(), [{ ...album(), id: other }, album()]),
    );
    rejected(() =>
      mapGalleryAlbumRowsPage(owner, albumQuery(), [
        album(),
        { ...album(), id: other, revision: 0 },
      ]),
    );
    rejected(() => mapGalleryAlbumRowsPage(owner, albumQuery(), [album(), album()]));
    expect(mapGalleryAlbumRowsPage(owner, albumQuery(), []).items).toEqual([]);
  });
});
