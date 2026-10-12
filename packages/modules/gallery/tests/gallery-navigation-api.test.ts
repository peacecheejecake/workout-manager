import { describe, expect, it, vi } from 'vitest';
import {
  apiPathSchema,
  transportRequestDtoSchema,
  transportReplySchema,
  type AuthenticatedTransport,
} from '@workout/contracts/core';
import {
  galleryAlbumListQueryV1Schema,
  galleryMediaNavigationQueryV2Schema,
} from '@workout/contracts/gallery-navigation-v2';
import {
  createGalleryNavigationApi,
  GalleryNavigationRequestError,
} from '../src/gallery-navigation-api';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const revisionId = '10000000-0000-4000-8000-000000000003';
const savedCourseLink = { courseId: other, courseRevision: 4, revisionId };
const instant = '2026-10-09T00:00:00.000001Z';
const key = 'gallery-action-001';
const album = {
  schemaVersion: 1,
  id,
  title: '대회',
  revision: 2,
  createdAt: instant,
  updatedAt: instant,
};
const query = galleryMediaNavigationQueryV2Schema.parse({
  filters: {
    album: { mode: 'unassigned' },
    mediaKind: null,
    activityId: null,
    courseLink: null,
    capturedDay: { mode: 'unknown' },
  },
  limit: 2,
  sort: 'created_desc_id_asc',
  cursor: null,
});
const albumQuery = galleryAlbumListQueryV1Schema.parse({
  limit: 2,
  sort: 'created_desc_id_asc',
  cursor: null,
});
function media() {
  return {
    schemaVersion: 3,
    item: {
      id,
      mediaKind: 'image',
      visibility: 'private',
      includeForCoach: false,
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
      file: {
        originalFileName: 'finish.png',
        mediaType: 'image/png',
        byteSize: 10,
        sha256: 'a'.repeat(64),
      },
      preview: null,
      accessRevision: 2,
      createdAt: instant,
      updatedAt: instant,
    },
    albumMembership: null,
    courseLink: null,
    capturedDay: { state: 'unknown' },
    courseAvailability: null,
  };
}
function setup(body: unknown, status = 200) {
  const reply = transportReplySchema.parse({ status, body, traceId: null });
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
  return { api: createGalleryNavigationApi({ request }), request, reply };
}
function mediaWithoutAvailability() {
  const { courseAvailability, ...descriptor } = media();
  void courseAvailability;
  return descriptor;
}

describe('gallery navigation transport boundary', () => {
  it.each(['available', 'unavailable'] as const)(
    'preserves the saved course tuple and %s read fact through both endpoints',
    async (state) => {
      const linked = { ...media(), courseLink: savedCourseLink, courseAvailability: { state } };
      const page = { schemaVersion: 3, query, items: [linked], hasMore: false, nextCursor: null };
      expect(await setup(page).api.navigate(query)).toEqual(page);
      const command = {
        mediaItemId: id,
        expectedAccessRevision: 1,
        albumMembership: null,
        courseLink: savedCourseLink,
      };
      expect(await setup(linked).api.updateMembership(command, key)).toEqual(linked);
    },
  );
  it.each([
    null,
    { ...media(), schemaVersion: 2 },
    mediaWithoutAvailability(),
    { ...media(), courseAvailability: { state: 'available' } },
    { ...media(), courseLink: savedCourseLink },
    { ...media(), courseLink: savedCourseLink, courseAvailability: { state: 'unknown' } },
    {
      ...media(),
      courseLink: savedCourseLink,
      courseAvailability: { state: 'unavailable', reason: 'deleted' },
    },
    {
      ...media(),
      courseLink: savedCourseLink,
      courseAvailability: { state: 'available', ownerId: other },
    },
  ])('rejects incomplete or private course facts in both endpoints (%#)', async (invalid) => {
    const page = { schemaVersion: 3, query, items: [invalid], hasMore: false, nextCursor: null };
    await expect(setup(page).api.navigate(query)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
      message: 'INVALID_REPLY',
    });
    await expect(
      setup(invalid).api.updateMembership(
        {
          mediaItemId: id,
          expectedAccessRevision: 1,
          albumMembership: null,
          courseLink: null,
        },
        key,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY', message: 'INVALID_REPLY' });
  });
  it('rejects a legacy empty page without fabricating V3 availability', async () => {
    const { api } = setup({ schemaVersion: 2, query, items: [], hasMore: false, nextCursor: null });
    await expect(api.navigate(query)).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  });
  it('serializes only validated canonical query JSON and forwards the signal without body or key', async () => {
    const page = { schemaVersion: 3, query, items: [], hasMore: false, nextCursor: null };
    const { api, request } = setup(page);
    const controller = new AbortController();
    expect(await api.navigate(query, controller.signal)).toEqual(page);
    expect(request).toHaveBeenCalledOnce();
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.body).toBeNull();
    expect(sent?.idempotencyKey).toBeNull();
    expect(sent?.signal).toBe(controller.signal);
    const url = new URL(sent?.path ?? '', 'https://fixture.invalid');
    expect(url.pathname).toBe('/bff/v1/gallery/media/navigation');
    expect([...url.searchParams.keys()]).toEqual(['query']);
    expect(JSON.parse(url.searchParams.get('query') ?? '')).toEqual(query);
  });

  it('keeps microsecond continuation binding when navigating media and albums', async () => {
    const cursor = {
      cursorVersion: 1,
      binding: { filters: query.filters, limit: query.limit, sort: query.sort },
      after: { createdAt: instant, id },
    };
    const next = galleryMediaNavigationQueryV2Schema.parse({ ...query, cursor });
    const mediaCall = setup({
      schemaVersion: 3,
      query: next,
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    await mediaCall.api.navigate(next);
    const sent = mediaCall.request.mock.calls[0]?.[0];
    expect(
      JSON.parse(
        new URL(sent?.path ?? '', 'https://fixture.invalid').searchParams.get('query') ?? '',
      ).cursor.after.createdAt,
    ).toBe(instant);
    const listQuery = galleryAlbumListQueryV1Schema.parse({
      ...albumQuery,
      cursor: {
        cursorVersion: 1,
        binding: { limit: 2, sort: albumQuery.sort },
        after: { createdAt: instant, id },
      },
    });
    const listPage = {
      schemaVersion: 1,
      query: listQuery,
      items: [],
      hasMore: false,
      nextCursor: null,
    };
    const albums = setup(listPage);
    expect(await albums.api.listAlbums(listQuery)).toEqual(listPage);
    const albumSent = albums.request.mock.calls[0]?.[0];
    expect(new URL(albumSent?.path ?? '', 'https://fixture.invalid').pathname).toBe(
      '/bff/v1/gallery/albums',
    );
    expect(
      JSON.parse(
        new URL(albumSent?.path ?? '', 'https://fixture.invalid').searchParams.get('query') ?? '',
      ),
    ).toEqual(listQuery);
  });

  it('sends album create, rename and delete commands with independent header keys', async () => {
    const created = setup(album, 201);
    await expect(created.api.createAlbum({ title: ' 大会 ' }, key)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
    });
    // Response title correlation prevents an unrelated successful DTO from being accepted.
    expect(created.request).toHaveBeenCalledExactlyOnceWith({
      path: '/bff/v1/gallery/albums',
      method: 'POST',
      body: { title: '大会' },
      idempotencyKey: key,
    });
    const createdAlbum = { ...album, revision: 1 };
    const createMatch = setup(createdAlbum, 201);
    expect(await createMatch.api.createAlbum({ title: ' 대회 ' }, key)).toEqual(createdAlbum);
    const renamed = setup(album);
    const rename = { albumId: id, expectedRevision: 1, title: '대회' };
    expect(await renamed.api.renameAlbum(rename, key)).toEqual(album);
    expect(renamed.request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/gallery/albums/${id}`,
      method: 'PATCH',
      body: rename,
      idempotencyKey: key,
    });
    const result = {
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 3,
      detachedMediaCount: 0,
    };
    const deleted = setup(result);
    const command = { albumId: id, expectedRevision: 2 };
    expect(await deleted.api.deleteAlbum(command, key)).toEqual(result);
    expect(deleted.request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/gallery/albums/${id}`,
      method: 'DELETE',
      body: command,
      idempotencyKey: key,
    });
  });

  it('sends membership CAS with exact revision tuple and preserves explicit null detach', async () => {
    const command = {
      mediaItemId: id,
      expectedAccessRevision: 1,
      albumMembership: { albumId: other },
      courseLink: { courseId: other, courseRevision: 4, revisionId },
    };
    const bound = {
      ...media(),
      albumMembership: command.albumMembership,
      courseLink: command.courseLink,
      courseAvailability: { state: 'available' },
    };
    const attached = setup(bound);
    expect(await attached.api.updateMembership(command, key)).toEqual(bound);
    expect(attached.request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/gallery/media/${id}/membership`,
      method: 'PUT',
      body: command,
      idempotencyKey: key,
    });
    const detached = setup(media());
    const detach = { ...command, albumMembership: null, courseLink: null };
    expect(await detached.api.updateMembership(detach, key)).toEqual(media());
    expect(detached.request.mock.calls[0]?.[0].body).toEqual(detach);
  });

  it('rejects invalid, oversized, cursor-mismatched or ownership-bearing queries before transport', async () => {
    const { api, request } = setup(null);
    for (const raw of [
      { ...query, athleteId: id },
      { ...query, limit: 101 },
      {
        ...query,
        filters: {
          ...query.filters,
          capturedDay: {
            mode: 'stored_local_range',
            from: '2026-10-10',
            toInclusive: '2026-10-09',
          },
        },
      },
      {
        ...query,
        cursor: {
          cursorVersion: 1,
          binding: { filters: query.filters, limit: 1, sort: query.sort },
          after: { createdAt: instant, id },
        },
      },
    ]) {
      expect(() => api.navigate(raw)).toThrow(GalleryNavigationRequestError);
    }
    expect(() => api.listAlbums({ ...albumQuery, limit: 0 })).toThrow(
      GalleryNavigationRequestError,
    );
    expect(() => api.createAlbum({ title: 'x'.repeat(1048577) }, key)).toThrow(
      GalleryNavigationRequestError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('does not evaluate input accessors or accept header keys hidden in command bodies', () => {
    const { api, request } = setup(null);
    const getter = vi.fn(() => '대회');
    const input = Object.defineProperty({}, 'title', { get: getter, enumerable: true });
    expect(() => api.createAlbum(input, key)).toThrow(GalleryNavigationRequestError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => api.createAlbum({ title: '대회', idempotencyKey: key }, key)).toThrow(
      GalleryNavigationRequestError,
    );
    expect(() =>
      api.renameAlbum({ albumId: '../other', expectedRevision: 1, title: '대회' }, key),
    ).toThrow(GalleryNavigationRequestError);
    expect(() => api.deleteAlbum({ albumId: id, expectedRevision: 0 }, key)).toThrow(
      GalleryNavigationRequestError,
    );
    expect(() =>
      api.updateMembership(
        { mediaItemId: id, expectedAccessRevision: 1, albumMembership: null, courseLink: null },
        'bad key',
      ),
    ).toThrow(GalleryNavigationRequestError);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a valid reply belonging to a different query or resource', async () => {
    const wrongPage = setup({
      schemaVersion: 3,
      query: { ...query, limit: 3 },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    await expect(wrongPage.api.navigate(query)).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    const wrongAlbumPage = setup({
      schemaVersion: 1,
      query: { ...albumQuery, limit: 3 },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    await expect(wrongAlbumPage.api.listAlbums(albumQuery)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
    });
    const wrongAlbum = setup({ ...album, id: other });
    await expect(
      wrongAlbum.api.renameAlbum({ albumId: id, expectedRevision: 1, title: '대회' }, key),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    const wrongMembership = setup({
      ...media(),
      courseLink: { courseId: other, courseRevision: 3, revisionId },
      courseAvailability: { state: 'available' },
    });
    await expect(
      wrongMembership.api.updateMembership(
        { mediaItemId: id, expectedAccessRevision: 1, albumMembership: null, courseLink: null },
        key,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  });

  it('rejects invalid successful DTOs without exposing raw details', async () => {
    const { api } = setup({
      schemaVersion: 3,
      query,
      items: [],
      hasMore: true,
      nextCursor: null,
      privateDetail: 'private-sentinel',
    });
    await expect(api.navigate(query)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
      message: 'INVALID_REPLY',
    });
  });

  it('rejects a reply envelope accessor before reading it', async () => {
    const { api, reply } = setup(null);
    const getter = vi.fn(() => ({ privateDetail: 'private-sentinel' }));
    Object.defineProperty(reply, 'body', { get: getter, enumerable: true });
    await expect(api.navigate(query)).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps failure status but discards arbitrary server error codes and messages', async () => {
    const { api } = setup(
      { error: { code: 'private-sentinel', message: 'private-sentinel' } },
      409,
    );
    await expect(api.deleteAlbum({ albumId: id, expectedRevision: 1 }, key)).rejects.toMatchObject({
      status: 409,
      code: 'REQUEST_FAILED',
      message: 'REQUEST_FAILED',
    });
  });

  it('sanitizes transport failure and rejects cancellation before or after transport', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>(async () => {
      throw new Error('private-sentinel');
    });
    const api = createGalleryNavigationApi({ request });
    await expect(api.navigate(query)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: 'TRANSPORT_FAILED',
    });
    request.mockClear();
    const before = new AbortController();
    before.abort();
    await expect(api.navigate(query, before.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(request).not.toHaveBeenCalled();
    const during = new AbortController();
    request.mockImplementation(async () => {
      during.abort();
      return transportReplySchema.parse({
        status: 200,
        body: { schemaVersion: 3, query, items: [], hasMore: false, nextCursor: null },
        traceId: null,
      });
    });
    await expect(api.navigate(query, during.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

it.each([3, 4, 6])(
  'rejects CAS reply revision %s instead of the command expected revision plus one',
  async (revision) => {
    const renamed = setup({ ...album, revision });
    await expect(
      renamed.api.renameAlbum({ albumId: id, expectedRevision: 4, title: '대회' }, key),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    const deleted = setup({
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision,
      detachedMediaCount: 0,
    });
    await expect(
      deleted.api.deleteAlbum({ albumId: id, expectedRevision: 4 }, key),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    const membership = setup({ ...media(), item: { ...media().item, accessRevision: revision } });
    await expect(
      membership.api.updateMembership(
        { mediaItemId: id, expectedAccessRevision: 4, albumMembership: null, courseLink: null },
        key,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  },
);

it.each([0, 2])(
  'rejects create album revision %s rather than accepting a fabricated success',
  async (revision) => {
    const created = setup({ ...album, revision });
    await expect(created.api.createAlbum({ title: '대회' }, key)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
    });
  },
);

it('cannot accept an exhausted CAS revision as a successful mutation', async () => {
  const maximum = 2147483646;
  const { api } = setup({ ...album, revision: maximum });
  await expect(
    api.renameAlbum({ albumId: id, expectedRevision: maximum, title: '대회' }, key),
  ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
});

it('encodes the maximum-length defined query fields and full cursor binding within the real transport path schema', async () => {
  const filters = {
    album: { mode: 'album', albumId: id },
    mediaKind: 'video',
    activityId: other,
    courseLink: { courseId: other, courseRevision: 2147483646, revisionId },
    capturedDay: { mode: 'stored_local_range', from: '0001-01-01', toInclusive: '9999-12-31' },
  };
  const longInstant = '9999-12-31T23:59:59.999999+23:59';
  const maximumQuery = galleryMediaNavigationQueryV2Schema.parse({
    filters,
    limit: 100,
    sort: 'created_desc_id_asc',
    cursor: {
      cursorVersion: 1,
      binding: { filters, limit: 100, sort: 'created_desc_id_asc' },
      after: { createdAt: longInstant, id },
    },
  });
  const navigation = setup({
    schemaVersion: 3,
    query: maximumQuery,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  await navigation.api.navigate(maximumQuery);
  const sent = navigation.request.mock.calls[0]?.[0];
  expect(sent).toBeDefined();
  expect(apiPathSchema.safeParse(sent?.path).success).toBe(true);
  expect(transportRequestDtoSchema.safeParse(sent).success).toBe(true);
  const roundtrip = new URL(sent?.path ?? '', 'https://fixture.invalid').searchParams.get('query');
  expect(JSON.parse(roundtrip ?? '')).toEqual(maximumQuery);
  const maximumAlbumQuery = galleryAlbumListQueryV1Schema.parse({
    limit: 100,
    sort: 'created_desc_id_asc',
    cursor: {
      cursorVersion: 1,
      binding: { limit: 100, sort: 'created_desc_id_asc' },
      after: { createdAt: longInstant, id },
    },
  });
  const listing = setup({
    schemaVersion: 1,
    query: maximumAlbumQuery,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  await listing.api.listAlbums(maximumAlbumQuery);
  expect(transportRequestDtoSchema.safeParse(listing.request.mock.calls[0]?.[0]).success).toBe(
    true,
  );
});
