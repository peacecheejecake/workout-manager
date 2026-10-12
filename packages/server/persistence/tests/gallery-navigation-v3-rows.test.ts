import { describe, expect, it, vi } from 'vitest';
import {
  GalleryNavigationRowsError,
  mapGalleryNavigationRow,
} from '../src/gallery-navigation-rows.js';
import {
  mapGalleryNavigationV3Row,
  mapGalleryNavigationV3RowsPage,
} from '../src/gallery-navigation-v3-rows.js';

const owner = 'synthetic-owner';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = '2026-10-09T00:00:00.000002Z';
function row() {
  return {
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
    original_filename: '원본.png',
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
    course_available: null,
  };
}
function linked(available: boolean) {
  return {
    ...row(),
    course_id: third,
    course_revision: 2,
    course_revision_id: other,
    course_athlete_id: owner,
    course_available: available,
  };
}
function query(limit = 1) {
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
function rejected(read: () => unknown) {
  expect(read).toThrow(GalleryNavigationRowsError);
}

describe('gallery V3 flat SQL projections', () => {
  it('preserves null capture/association and precise UTC microseconds', () => {
    const dto = mapGalleryNavigationV3Row(owner, row());
    expect(dto.schemaVersion).toBe(3);
    expect(dto.courseLink).toBeNull();
    expect(dto.courseAvailability).toBeNull();
    expect(dto.item.createdAt).toBe(at);
    expect(dto.item.capturedAt).toBeNull();
    expect(dto.capturedDay).toEqual({ state: 'unknown' });
    expect(dto.item.file.byteSize).toBe(1);
  });
  it.each([true, false])(
    'retains the exact association for authoritative availability %s',
    (available) => {
      const dto = mapGalleryNavigationV3Row(owner, linked(available));
      expect(dto.courseLink).toEqual({ courseId: third, courseRevision: 2, revisionId: other });
      expect(dto.courseAvailability).toEqual({ state: available ? 'available' : 'unavailable' });
      expect(Object.keys(dto.courseAvailability ?? {})).toEqual(['state']);
    },
  );
  it('does not require live course owner facts to represent deleted or unreadable targets', () => {
    const dto = mapGalleryNavigationV3Row(owner, linked(false));
    expect(dto.courseLink?.revisionId).toBe(other);
    // Projection contains the stored association owner, not an absent live-join owner.
    rejected(() => mapGalleryNavigationV3Row(owner, { ...linked(false), course_athlete_id: null }));
  });
  it('requires boolean/null correlation without coercing zero, strings or unknown to a state', () => {
    for (const available of [0, 1, 'true', 'false', undefined, {}, NaN])
      rejected(() =>
        mapGalleryNavigationV3Row(owner, { ...linked(true), course_available: available }),
      );
    rejected(() => mapGalleryNavigationV3Row(owner, { ...linked(false), course_available: null }));
    rejected(() => mapGalleryNavigationV3Row(owner, { ...row(), course_available: false }));
    const { course_available: omitted, ...missing } = row();
    void omitted;
    rejected(() => mapGalleryNavigationV3Row(owner, missing));
  });
  it('rejects foreign media/association owners even for unavailable links', () => {
    for (const patch of [{ athlete_id: 'foreign' }, { course_athlete_id: 'foreign' }])
      rejected(() => mapGalleryNavigationV3Row(owner, { ...linked(false), ...patch }));
    rejected(() => mapGalleryNavigationV3Row('other-owner', linked(false)));
  });
  it('rejects partial tuples, unsafe revisions and additional private reason/metadata columns', () => {
    for (const patch of [
      { course_id: null },
      { course_revision_id: null },
      { course_revision: null },
      { course_revision: 0 },
      { course_revision: Number.MAX_SAFE_INTEGER + 1 },
      { course_unavailable_reason: 'private' },
      { course_owner_name: 'private' },
      { geometry: 'private' },
    ])
      rejected(() => mapGalleryNavigationV3Row(owner, { ...linked(false), ...patch }));
  });
  it('rejects accessors and prototype/symbol fields before getter invocation', () => {
    const getter = vi.fn(() => true);
    const available = Object.defineProperty({ ...linked(false) }, 'course_available', {
      get: getter,
      enumerable: true,
    });
    rejected(() => mapGalleryNavigationV3Row(owner, available));
    const nested = Object.defineProperty({ ...linked(false) }, 'course_revision', {
      get: getter,
      enumerable: true,
    });
    rejected(() => mapGalleryNavigationV3Row(owner, nested));
    rejected(() => mapGalleryNavigationV3Row(owner, Object.assign(Object.create({}), row())));
    rejected(() => mapGalleryNavigationV3Row(owner, { ...row(), [Symbol('hidden')]: true }));
    expect(getter).not.toHaveBeenCalled();
  });
  it('retains original date/album/byte facts and rejects Date or lost timestamp precision', () => {
    const dto = mapGalleryNavigationV3Row(owner, {
      ...linked(false),
      album: '기존 앨범',
      captured_local_date: '2026-10-08',
    });
    expect(dto.item.album).toBe('기존 앨범');
    expect(dto.capturedDay).toEqual({ state: 'known', localDate: '2026-10-08' });
    rejected(() => mapGalleryNavigationV3Row(owner, { ...row(), created_at: new Date(at) }));
    rejected(() =>
      mapGalleryNavigationV3Row(owner, { ...row(), created_at: '2026-10-09T00:00:00.000Z' }),
    );
    rejected(() => mapGalleryNavigationV3Row(owner, { ...row(), size_bytes: '0' }));
  });
  it('leaves the V2 projection strict instead of widening it with availability', () => {
    rejected(() => mapGalleryNavigationRow(owner, row()));
    const { course_available: omitted, ...base } = row();
    void omitted;
    expect(mapGalleryNavigationRow(owner, base).schemaVersion).toBe(2);
  });
  it('maps limit+1 with unavailable lookahead and exact original next-cursor tuple', () => {
    const result = mapGalleryNavigationV3RowsPage(owner, query(), [
      linked(false),
      { ...linked(true), id: other },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.courseAvailability).toEqual({ state: 'unavailable' });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor?.after).toEqual({ createdAt: at, id });
    expect(result.nextCursor?.binding.filters.courseLink).toBeNull();
    const next = mapGalleryNavigationV3RowsPage(owner, { ...query(), cursor: result.nextCursor }, [
      { ...linked(true), id: other },
    ]);
    expect(next.items[0]?.item.id).toBe(other);
    expect(next.hasMore).toBe(false);
  });
  it('filters against saved unavailable tuples, not current course access', () => {
    const exact = { courseId: third, courseRevision: 2, revisionId: other };
    const input = { ...query(), filters: { ...query().filters, courseLink: exact } };
    expect(
      mapGalleryNavigationV3RowsPage(owner, input, [linked(false)]).items[0]?.courseLink,
    ).toEqual(exact);
    rejected(() =>
      mapGalleryNavigationV3RowsPage(owner, input, [{ ...linked(false), course_revision: 3 }]),
    );
  });
  it('validates lookahead authority facts, duplicates and microsecond ordering instead of slicing them away', () => {
    rejected(() =>
      mapGalleryNavigationV3RowsPage(owner, query(), [
        row(),
        { ...linked(false), id: other, course_available: 'false' },
      ]),
    );
    rejected(() => mapGalleryNavigationV3RowsPage(owner, query(), [row(), row()]));
    rejected(() =>
      mapGalleryNavigationV3RowsPage(owner, query(), [{ ...row(), id: other }, row()]),
    );
    const result = mapGalleryNavigationV3RowsPage(owner, query(2), [
      { ...row(), id: other },
      { ...row(), created_at: '2026-10-09T00:00:00.000001Z', updated_at: at },
    ]);
    expect(result.items.map((entry) => entry.item.id)).toEqual([other, id]);
  });
  it('preserves empty pages and rejects excessive/sparse/accessor row arrays and malformed queries', () => {
    expect(mapGalleryNavigationV3RowsPage(owner, query(), []).items).toEqual([]);
    rejected(() => mapGalleryNavigationV3RowsPage('', query(), []));
    rejected(() =>
      mapGalleryNavigationV3RowsPage(owner, query(), [
        row(),
        { ...row(), id: other },
        { ...row(), id: third },
      ]),
    );
    rejected(() => mapGalleryNavigationV3RowsPage(owner, query(), new Array(1)));
    const getter = vi.fn(() => row());
    const rows = Object.defineProperty([], '0', { get: getter, enumerable: true });
    rejected(() => mapGalleryNavigationV3RowsPage(owner, query(), rows));
    rejected(() =>
      mapGalleryNavigationV3RowsPage(
        owner,
        { ...query(), filters: { ...query().filters, athleteId: owner } },
        [],
      ),
    );
    expect(getter).not.toHaveBeenCalled();
  });
});
