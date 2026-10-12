import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import { readGalleryNavigationPageIn } from '../src/gallery-navigation-queries.js';
import { setGalleryMediaNavigationIn } from '../src/gallery-album-commands.js';

const owner = 'synthetic-owner';
const media = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const album = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const course = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const revisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const key = 'synthetic-key-001';
function projection(overrides: Record<string, unknown> = {}) {
  return {
    athlete_id: owner,
    id: media,
    media_kind: 'image',
    visibility: 'private',
    include_for_coach: false,
    album: '기존 문자열',
    caption: null,
    activity_id: null,
    captured_at: null,
    captured_local_date: '2026-01-01',
    original_filename: 'synthetic.png',
    media_type: 'image/png',
    size_bytes: 1,
    content_hash: 'c'.repeat(64),
    access_revision: 2,
    created_at: '2026-10-09T00:00:00.000001Z',
    updated_at: '2026-10-09T00:00:00.000002Z',
    deleted_at: null,
    preview_media_type: null,
    preview_size_bytes: null,
    preview_content_hash: null,
    album_id: album,
    album_athlete_id: owner,
    course_id: course,
    course_revision: 3,
    course_revision_id: revisionId,
    course_athlete_id: owner,
    course_available: false,
    ...overrides,
  };
}
const link = { courseId: course, courseRevision: 3, revisionId };
const command = {
  mediaItemId: media,
  expectedAccessRevision: 1,
  albumMembership: { albumId: album },
  courseLink: link,
};
function fixture(rows: unknown[], rowCount = rows.length) {
  const query = vi
    .fn<Transaction['query']>()
    .mockResolvedValue({ rows: rows as Record<string, unknown>[], rowCount });
  return { tx: { athleteId: owner, query } satisfies Transaction, query };
}
function query(filters: Record<string, unknown> = {}, limit = 2) {
  return {
    filters: {
      album: { mode: 'all' },
      mediaKind: null,
      activityId: null,
      courseLink: null,
      capturedDay: { mode: 'all' },
      ...filters,
    },
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  };
}

// Transport stubs only; real PostgreSQL behaviour is in gallery-albums.integration.test.ts.
describe('Gallery media navigation membership adapter', () => {
  it('binds the validated command to one fixed RPC and maps the stored projection', async () => {
    const { tx, query: q } = fixture([{ result: projection() }], 1);
    const result = await setGalleryMediaNavigationIn(tx, command, key);
    expect(q).toHaveBeenCalledExactlyOnceWith(
      'SELECT public.set_gallery_media_navigation_v1($1::jsonb,$2::text) AS result',
      [JSON.stringify(command), key],
    );
    expect(result).toMatchObject({
      schemaVersion: 3,
      albumMembership: { albumId: album },
      courseLink: link,
      courseAvailability: { state: 'unavailable' },
      capturedDay: { state: 'known', localDate: '2026-01-01' },
    });
    expect(result.item.album).toBe('기존 문자열');
  });
  it('rejects replies for another media, revision, membership or course tuple', async () => {
    for (const overrides of [
      { id: album },
      { access_revision: 3 },
      { album_id: null, album_athlete_id: null },
      { course_revision: 2 },
      { athlete_id: 'someone-else' },
    ]) {
      const { tx } = fixture([{ result: projection(overrides) }], 1);
      await expect(setGalleryMediaNavigationIn(tx, command, key)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_REPLY',
      });
    }
  });
  it('rejects malformed commands before SQL and maps finite database codes', async () => {
    const { tx, query: q } = fixture([]);
    for (const raw of [
      { ...command, albumMembership: { albumId: album, extra: 1 } },
      { ...command, courseLink: { courseId: course } },
      { ...command, expectedAccessRevision: 0 },
    ])
      await expect(setGalleryMediaNavigationIn(tx, raw, key)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_COMMAND',
      });
    expect(q).not.toHaveBeenCalled();
    for (const code of ['COURSE_NOT_FOUND', 'MEDIA_NOT_FOUND', 'RESTORE_PROCESSING_CLOSED']) {
      q.mockRejectedValueOnce(Object.assign(new Error(code), { code: 'P0001' }));
      await expect(setGalleryMediaNavigationIn(tx, command, key)).rejects.toMatchObject({ code });
    }
    q.mockRejectedValueOnce(Object.assign(new Error('raw detail'), { code: 'XX000' }));
    await expect(setGalleryMediaNavigationIn(tx, command, key)).rejects.toMatchObject({
      code: 'GALLERY_ALBUM_COMMAND_FAILED',
    });
  });
});

describe('Gallery navigation page query', () => {
  it('binds filters, stored local dates and the cursor as parameters with a limit+1 lookahead', async () => {
    const { tx, query: q } = fixture([]);
    const page = await readGalleryNavigationPageIn(
      tx,
      query({
        album: { mode: 'album', albumId: album },
        mediaKind: 'video',
        courseLink: link,
        capturedDay: { mode: 'stored_local_range', from: '2026-01-01', toInclusive: '2026-01-31' },
      }),
    );
    expect(page).toMatchObject({ schemaVersion: 3, items: [], hasMore: false, nextCursor: null });
    const [sql, values] = q.mock.calls[0] ?? [];
    expect(sql).not.toContain('2026-01');
    expect(values).toEqual([
      owner,
      'album',
      album,
      'video',
      null,
      course,
      3,
      revisionId,
      'stored_local_range',
      '2026-01-01',
      '2026-01-31',
      null,
      null,
      3,
    ]);
  });
  it('rejects a non-array reply, a foreign row or a filter mismatch instead of an empty page', async () => {
    for (const rows of [
      [{ row: projection({ athlete_id: 'other' }) }],
      [{ row: projection() }, { row: projection() }],
    ]) {
      const { tx } = fixture(rows);
      await expect(
        readGalleryNavigationPageIn(tx, query({ capturedDay: { mode: 'unknown' } })),
      ).rejects.toMatchObject({ code: 'INVALID_GALLERY_PROJECTION' });
    }
    const odd = {
      athleteId: owner,
      query: vi.fn().mockResolvedValue({ rows: { 0: {} }, rowCount: 1 }),
    } as unknown as Transaction;
    await expect(readGalleryNavigationPageIn(odd, query())).rejects.toMatchObject({
      code: 'INVALID_GALLERY_PROJECTION',
    });
  });
  it('rejects malformed query and context before SQL', async () => {
    const { tx, query: q } = fixture([]);
    await expect(readGalleryNavigationPageIn(tx, { ...query(), limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_GALLERY_NAVIGATION_QUERY',
    });
    await expect(
      readGalleryNavigationPageIn({ athleteId: ' x', query: q }, query()),
    ).rejects.toMatchObject({ code: 'INVALID_GALLERY_NAVIGATION_CONTEXT' });
    expect(q).not.toHaveBeenCalled();
  });
});
