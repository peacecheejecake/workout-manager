import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import { GalleryAlbumQueryError, readGalleryAlbumPageIn } from '../src/gallery-album-queries.js';
import { GalleryNavigationRowsError } from '../src/gallery-navigation-rows.js';

const owner = 'synthetic-owner';
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = '2026-10-09T00:00:00.000002Z';
const older = '2026-10-09T00:00:00.000001Z';
function row(id = first, createdAt = at) {
  return {
    athlete_id: owner,
    id,
    title: '합성 앨범',
    revision: 1,
    created_at: createdAt,
    updated_at: at,
    deleted_at: null,
  };
}
function input(limit = 1) {
  return { limit, sort: 'created_desc_id_asc', cursor: null };
}
function cursor(limit = 1) {
  return {
    cursorVersion: 1,
    binding: { limit, sort: 'created_desc_id_asc' },
    after: { createdAt: at, id: first },
  };
}
function fixture(rows: Record<string, unknown>[] = [], athleteId = owner) {
  const query = vi.fn<Transaction['query']>().mockResolvedValue({ rows, rowCount: rows.length });
  return { tx: { athleteId, query } satisfies Transaction, query };
}
// Transport stubs verify bindings and reuse the real DTO mapper. These are not
// PostgreSQL/RLS, migration, restore or query-plan evidence.
describe('Gallery album query port', () => {
  it('binds only the transaction owner and fetches a bounded first page in one SELECT', async () => {
    const { tx, query } = fixture([row(), row(second)]);
    const page = await readGalleryAlbumPageIn(tx, input());
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([owner, null, null, 2]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toMatch(/a\.athlete_id=\$1 AND a\.deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY a\.created_at DESC,a\.id ASC LIMIT \$4::integer/);
    expect(sql).not.toMatch(/OFFSET|JOIN|storage_ref|content_hash|SELECT \*/i);
    expect(page.items.map((item) => item.id)).toEqual([first]);
    expect(page.nextCursor?.after).toEqual({ createdAt: at, id: first });
    expect(page.query).toEqual(input());
  });
  it('binds the exact microsecond cursor and ascending UUID tie predicate', async () => {
    const { tx, query } = fixture([row(second)]);
    const page = await readGalleryAlbumPageIn(tx, { ...input(), cursor: cursor() });
    expect(query.mock.calls[0]?.[1]).toEqual([owner, at, first, 2]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toMatch(/a\.created_at<\$2::timestamptz/);
    expect(sql).toMatch(/a\.created_at=\$2::timestamptz AND a\.id>\$3::uuid/);
    expect(sql.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(2);
    expect(sql.match(/SS\.US/g)).toHaveLength(2);
    expect(page.items[0]?.createdAt).toBe(at);
    expect(page.hasMore).toBe(false);
  });
  it('keeps an empty cursor page empty and retains the validated query', async () => {
    const { tx, query } = fixture();
    const request = { ...input(), cursor: cursor() };
    expect(await readGalleryAlbumPageIn(tx, request)).toEqual({
      schemaVersion: 1,
      query: request,
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('does not manufacture continuation from a full page without lookahead', async () => {
    const { tx } = fixture([row()]);
    const page = await readGalleryAlbumPageIn(tx, input());
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
  it('binds continuation to the last displayed item rather than the hidden lookahead', async () => {
    const { tx } = fixture([row(), row(second), row(third, older)]);
    const page = await readGalleryAlbumPageIn(tx, input(2));
    expect(page.items.map((item) => item.id)).toEqual([first, second]);
    expect(page.nextCursor).toEqual({
      cursorVersion: 1,
      binding: { limit: 2, sort: 'created_desc_id_asc' },
      after: { createdAt: at, id: second },
    });
  });
  it('honors the maximum page bound with a 101-row SQL limit', async () => {
    const { tx, query } = fixture();
    await readGalleryAlbumPageIn(tx, input(100));
    expect(query.mock.calls[0]?.[1]).toEqual([owner, null, null, 101]);
  });
  it('rejects malformed and foreign-owner query fields before any database call', async () => {
    const { tx, query } = fixture();
    for (const value of [
      null,
      { ...input(), athleteId: 'foreign' },
      { ...input(), limit: 101 },
      { ...input(), sort: 'id_desc' },
      { ...input(), cursor: { ...cursor(), binding: { limit: 2, sort: 'created_desc_id_asc' } } },
    ]) {
      await expect(readGalleryAlbumPageIn(tx, value)).rejects.toMatchObject({
        code: 'INVALID_GALLERY_ALBUM_QUERY',
        message: 'INVALID_GALLERY_ALBUM_QUERY',
      });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects accessor input without evaluating it or issuing a query', async () => {
    const { tx, query } = fixture();
    const getter = vi.fn(() => 1);
    const value = { ...input() };
    Object.defineProperty(value, 'limit', { enumerable: true, get: getter });
    await expect(readGalleryAlbumPageIn(tx, value)).rejects.toBeInstanceOf(GalleryAlbumQueryError);
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects a malformed trusted transaction context before query execution', async () => {
    const { tx, query } = fixture([], ' ');
    await expect(readGalleryAlbumPageIn(tx, input())).rejects.toMatchObject({
      code: 'INVALID_GALLERY_ALBUM_CONTEXT',
    });
    expect(query).not.toHaveBeenCalled();
  });
  it('validates every returned row including lookahead without sorting or dropping bad data', async () => {
    for (const rows of [
      [row(), { ...row(second), athlete_id: 'foreign' }],
      [row(), row()],
      [row(second), row()],
      [row(), { ...row(second), created_at: new Date(at) }],
      [row(), { ...row(second), storage_ref: 'private-key' }],
      [row(), row(second), row(third)],
    ]) {
      const { tx, query } = fixture(rows);
      await expect(readGalleryAlbumPageIn(tx, input())).rejects.toBeInstanceOf(
        GalleryNavigationRowsError,
      );
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects rows at or before the public cursor boundary', async () => {
    const { tx } = fixture([row()]);
    await expect(
      readGalleryAlbumPageIn(tx, { ...input(), cursor: cursor() }),
    ).rejects.toBeInstanceOf(GalleryNavigationRowsError);
  });
  it('propagates database failure without issuing a fallback or fabricating an empty page', async () => {
    const { tx, query } = fixture();
    const unavailable = new Error('synthetic database failure');
    query.mockRejectedValue(unavailable);
    await expect(readGalleryAlbumPageIn(tx, input())).rejects.toBe(unavailable);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
