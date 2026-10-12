import { describe, expect, it } from 'vitest';
import {
  createDefaultGalleryNavigationQuery,
  readGalleryNavigationSearch,
  writeGalleryNavigationSearch,
  GalleryNavigationSearchError,
} from '../src/gallery-navigation-search';
import { galleryNavigationV2Limits } from '@workout/contracts/gallery-navigation-v2';

const id = '10000000-0000-4000-8000-000000000001';
const revisionId = '10000000-0000-4000-8000-000000000002';
const course = { courseId: id, courseRevision: 4, revisionId };
function search(raw: unknown) {
  return new URLSearchParams({ query: JSON.stringify(raw) }).toString();
}
function savedQuery() {
  const query = createDefaultGalleryNavigationQuery();
  query.filters.album = { mode: 'unassigned' };
  query.filters.courseLink = course;
  query.filters.capturedDay = {
    mode: 'stored_local_range',
    from: '2026-10-09',
    toInclusive: '2026-10-10',
  };
  query.cursor = {
    cursorVersion: 1,
    binding: {
      filters: structuredClone(query.filters),
      limit: query.limit,
      sort: query.sort,
    },
    after: { createdAt: '2026-10-09T23:59:59.123456Z', id },
  };
  return query;
}

describe('Gallery navigation URL query', () => {
  it('distinguishes a missing query and an explicitly encoded default', () => {
    const query = createDefaultGalleryNavigationQuery();
    expect(readGalleryNavigationSearch('')).toEqual({
      state: 'missing',
      query,
    });
    expect(readGalleryNavigationSearch(writeGalleryNavigationSearch(query))).toEqual({
      state: 'valid',
      query,
    });
  });
  it('returns a fresh default so one workspace cannot change another recovery result', () => {
    const first = readGalleryNavigationSearch('');
    first.query.filters.album = { mode: 'unassigned' };
    expect(readGalleryNavigationSearch('').query.filters.album).toEqual({
      mode: 'all',
    });
  });
  it('preserves stored local dates, microseconds and the saved course tuple without resolving its head', () => {
    const query = savedQuery();
    expect(readGalleryNavigationSearch('?' + writeGalleryNavigationSearch(query))).toEqual({
      state: 'valid',
      query,
    });
  });
  it('keeps unknown capture day distinct from all days and null filters', () => {
    const query = createDefaultGalleryNavigationQuery();
    query.filters.capturedDay = { mode: 'unknown' };
    expect(readGalleryNavigationSearch(writeGalleryNavigationSearch(query))).toEqual({
      state: 'valid',
      query,
    });
  });
  it('keeps exact album and activity IDs', () => {
    const query = createDefaultGalleryNavigationQuery();
    query.filters.album = { mode: 'album', albumId: id };
    query.filters.activityId = id;
    query.filters.mediaKind = 'video';
    query.limit = 100;
    expect(readGalleryNavigationSearch(writeGalleryNavigationSearch(query))).toEqual({
      state: 'valid',
      query,
    });
  });
  it.each(['query=', 'query=null', 'query=%7B', 'query=%FF'])(
    'recovers invalid JSON/schema without returning the raw URL: %s',
    (value) => {
      expect(readGalleryNavigationSearch(value)).toEqual({
        state: 'invalid',
        reason: 'INVALID_QUERY',
        query: createDefaultGalleryNavigationQuery(),
      });
    },
  );
  it('rejects duplicate query parameters instead of choosing a workspace silently', () => {
    const value = writeGalleryNavigationSearch(savedQuery());
    expect(readGalleryNavigationSearch(value + '&' + value).state).toBe('invalid');
  });
  it('rejects a cursor from a different filter, preserving neither stale page nor partial filters', () => {
    const query = savedQuery();
    query.filters.courseLink = null;
    expect(readGalleryNavigationSearch(search(query))).toEqual({
      state: 'invalid',
      reason: 'INVALID_QUERY',
      query: createDefaultGalleryNavigationQuery(),
    });
  });
  it('rejects reversed dates and timestamp precision above microseconds', () => {
    const query = savedQuery();
    query.filters.capturedDay = {
      mode: 'stored_local_range',
      from: '2026-10-10',
      toInclusive: '2026-10-09',
    };
    expect(readGalleryNavigationSearch(search(query)).state).toBe('invalid');
    const cursor = savedQuery();
    if (!cursor.cursor) throw Error('fixture cursor missing');
    cursor.cursor.after.createdAt = '2026-10-09T23:59:59.1234567Z';
    expect(readGalleryNavigationSearch(search(cursor)).state).toBe('invalid');
  });
  it('never copies tenant identity, private media URLs, tokens or free text into an emitted query', () => {
    const query = createDefaultGalleryNavigationQuery();
    expect(() =>
      writeGalleryNavigationSearch({
        ...query,
        athleteId: id,
        token: 'private-token',
      }),
    ).toThrow(GalleryNavigationSearchError);
    const read = readGalleryNavigationSearch(
      'token=private-token&caption=private-note&' + writeGalleryNavigationSearch(query),
    );
    expect(read.state).toBe('valid');
    expect(writeGalleryNavigationSearch(read.query)).toBe(writeGalleryNavigationSearch(query));
    expect(JSON.stringify(read)).not.toMatch(/private-token|private-note/);
  });
  it('rejects oversized search and JSON before accepting a query', () => {
    expect(
      readGalleryNavigationSearch('x'.repeat(galleryNavigationV2Limits.encodedBytes * 3 + 10)),
    ).toEqual({
      state: 'invalid',
      reason: 'SEARCH_TOO_LARGE',
      query: createDefaultGalleryNavigationQuery(),
    });
    const value = new URLSearchParams({
      query: ' '.repeat(galleryNavigationV2Limits.encodedBytes + 1),
    }).toString();
    expect(readGalleryNavigationSearch(value).state).toBe('invalid');
  });
  it('rejects non-string URL input and does not invoke untrusted query getters', () => {
    expect(
      readGalleryNavigationSearch({
        toString: () => {
          throw Error('must not stringify');
        },
      }),
    ).toEqual({
      state: 'invalid',
      reason: 'INVALID_SEARCH',
      query: createDefaultGalleryNavigationQuery(),
    });
    let called = false;
    const query = {
      get filters() {
        called = true;
        throw Error('private');
      },
    };
    expect(() => writeGalleryNavigationSearch(query)).toThrow('INVALID_GALLERY_NAVIGATION_QUERY');
    expect(called).toBe(false);
  });
});
