import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { galleryMediaNavigationQueryV2Schema } from '@workout/contracts/gallery-navigation-v2';
import {
  GalleryNavigationServiceError,
  registerGalleryNavigationRoutes,
  type GalleryNavigationServices,
} from '../src/gallery-navigation-routes.js';
import { ProductRequestError } from '../src/product-boundary.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const savedCourseLink = { courseId: other, courseRevision: 4, revisionId: id };
const instant = '2026-10-09T00:00:00.000001Z';
const album = {
  schemaVersion: 1,
  id,
  title: '한글 앨범',
  revision: 1,
  createdAt: instant,
  updatedAt: instant,
};
const media = {
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
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 1,
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
const query = galleryMediaNavigationQueryV2Schema.parse({
  filters: {
    album: { mode: 'all' },
    mediaKind: null,
    activityId: null,
    courseLink: null,
    capturedDay: { mode: 'all' },
  },
  limit: 10,
  sort: 'created_desc_id_asc',
  cursor: null,
});
const albumQuery = { limit: 10, sort: 'created_desc_id_asc', cursor: null };
const headers = { authorization: 'Bearer synthetic', 'idempotency-key': 'gallery-key-01' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(absent = false) {
  const services = {
    navigate: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 3, query, items: [], hasMore: false, nextCursor: null }),
    listAlbums: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      query: albumQuery,
      items: [album],
      hasMore: false,
      nextCursor: null,
    }),
    createAlbum: vi.fn().mockResolvedValue(album),
    renameAlbum: vi.fn().mockResolvedValue({ ...album, revision: 2 }),
    deleteAlbum: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 2,
      detachedMediaCount: 0,
    }),
    updateMembership: vi.fn().mockResolvedValue(media),
  } satisfies GalleryNavigationServices;
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  registerGalleryNavigationRoutes(app, absent ? undefined : services, (request) => {
    if (request.headers.authorization !== headers.authorization)
      throw new ProductRequestError(401, 'UNAUTHENTICATED');
    return { method: 'bearer', athleteId: 'owned-athlete', sessionId: 'owned-session' };
  });
  return { app, services };
}
const encodedQuery = (value: unknown) =>
  new URLSearchParams({ query: JSON.stringify(value) }).toString();
const commands = [
  {
    method: 'POST' as const,
    url: '/gallery/albums',
    payload: { title: album.title },
    operation: 'createAlbum' as const,
  },
  {
    method: 'PATCH' as const,
    url: `/gallery/albums/${id}`,
    payload: { albumId: id, expectedRevision: 1, title: album.title },
    operation: 'renameAlbum' as const,
  },
  {
    method: 'DELETE' as const,
    url: `/gallery/albums/${id}`,
    payload: { albumId: id, expectedRevision: 1 },
    operation: 'deleteAlbum' as const,
  },
  {
    method: 'PUT' as const,
    url: `/gallery/media/${id}/membership`,
    payload: {
      mediaItemId: id,
      expectedAccessRevision: 1,
      albumMembership: null,
      courseLink: null,
    },
    operation: 'updateMembership' as const,
  },
];

describe('gallery navigation encapsulated boundary', () => {
  it.each(['available', 'unavailable'] as const)(
    'preserves the saved course revision and %s read fact in navigation and membership replies',
    async (state) => {
      const { app, services } = setup();
      const linked = {
        ...media,
        courseLink: savedCourseLink,
        courseAvailability: { state },
      };
      services.navigate.mockResolvedValue({
        schemaVersion: 3,
        query,
        items: [linked],
        hasMore: false,
        nextCursor: null,
      });
      const page = await app.inject({
        url: `/gallery/media/navigation?${encodedQuery(query)}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().items).toEqual([linked]);
      const command = {
        mediaItemId: id,
        expectedAccessRevision: 1,
        albumMembership: null,
        courseLink: savedCourseLink,
      };
      services.updateMembership.mockResolvedValue(linked);
      const mutation = await app.inject({ ...commands[3], payload: command, headers });
      expect(mutation.statusCode).toBe(200);
      expect(mutation.json()).toEqual(linked);
      expect(services.updateMembership).toHaveBeenCalledExactlyOnceWith(
        'owned-athlete',
        command,
        'gallery-key-01',
      );
    },
  );
  it.each([
    null,
    { ...media, schemaVersion: 2 },
    { ...media, courseAvailability: undefined },
    { ...media, courseAvailability: { state: 'available' } },
    { ...media, courseLink: savedCourseLink },
    { ...media, courseLink: savedCourseLink, courseAvailability: { state: 'unknown' } },
    {
      ...media,
      courseLink: savedCourseLink,
      courseAvailability: { state: 'unavailable', reason: 'deleted' },
    },
    {
      ...media,
      courseLink: savedCourseLink,
      courseAvailability: { state: 'available', ownerId: other },
    },
  ])('rejects invalid V3 course facts without returning private fields (%#)', async (invalid) => {
    const { app, services } = setup();
    services.navigate.mockResolvedValue({
      schemaVersion: 3,
      query,
      items: [invalid],
      hasMore: false,
      nextCursor: null,
    });
    services.updateMembership.mockResolvedValue(invalid);
    for (const request of [
      { url: `/gallery/media/navigation?${encodedQuery(query)}`, headers },
      { ...commands[3], headers },
    ]) {
      const result = await app.inject(request);
      expect(result.statusCode).toBe(502);
      expect(result.json()).toEqual({ error: { code: 'INVALID_REPLY' } });
    }
  });
  it('rejects a legacy navigation page instead of inventing a V3 read fact', async () => {
    const { app, services } = setup();
    services.navigate.mockResolvedValue({
      schemaVersion: 2,
      query,
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    const result = await app.inject({
      url: `/gallery/media/navigation?${encodedQuery(query)}`,
      headers,
    });
    expect(result.statusCode).toBe(502);
    expect(result.json()).toEqual({ error: { code: 'INVALID_REPLY' } });
  });
  it('validates canonical media query and forwards only authenticated ownership', async () => {
    const { app, services } = setup();
    const result = await app.inject({
      method: 'GET',
      url: `/gallery/media/navigation?${encodedQuery(query)}`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(services.navigate).toHaveBeenCalledExactlyOnceWith('owned-athlete', query);
    expect(result.json().query).toEqual(query);
  });
  it('reads a bounded album page with immutable microsecond timestamps', async () => {
    const { app, services } = setup();
    const result = await app.inject({
      method: 'GET',
      url: `/gallery/albums?${encodedQuery(albumQuery)}`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().items[0].createdAt).toBe(instant);
    expect(services.listAlbums).toHaveBeenCalledExactlyOnceWith('owned-athlete', albumQuery);
  });
  it.each(commands)('dispatches $method with header key and exact command', async (command) => {
    const { app, services } = setup();
    const result = await app.inject({ ...command, headers });
    expect(result.statusCode).toBe(200);
    expect(services[command.operation]).toHaveBeenCalledExactlyOnceWith(
      'owned-athlete',
      command.payload,
      'gallery-key-01',
    );
    if (command.method === 'PUT') {
      expect(result.json().albumMembership).toBeNull();
      expect(result.json().courseLink).toBeNull();
      expect(result.json().item.accessRevision).toBe(2);
    }
  });
  it.each(commands)('denies unauthenticated $method before service invocation', async (command) => {
    const { app, services } = setup();
    const result = await app.inject({
      ...command,
      headers: { 'idempotency-key': 'gallery-key-01' },
    });
    expect(result.statusCode).toBe(401);
    expect(services[command.operation]).not.toHaveBeenCalled();
  });
  it.each(commands)(
    'requires bounded idempotency key and empty query for $method',
    async (command) => {
      const { app, services } = setup();
      for (const request of [
        { ...command, headers: { authorization: headers.authorization } },
        { ...command, headers: { ...headers, 'idempotency-key': 'x'.repeat(129) } },
        { ...command, url: `${command.url}?athleteId=foreign`, headers },
        { ...command, payload: { ...command.payload, athleteId: 'foreign' }, headers },
      ])
        expect((await app.inject(request)).statusCode).toBe(400);
      expect(services[command.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(commands.slice(1))(
    'rejects $method path/body identity substitution and invalid UUID',
    async (command) => {
      const { app, services } = setup();
      for (const target of [other, 'not-a-uuid'])
        expect(
          (await app.inject({ ...command, url: command.url.replace(id, target), headers }))
            .statusCode,
        ).toBe(400);
      expect(services[command.operation]).not.toHaveBeenCalled();
    },
  );
  it('rejects missing/unknown/duplicate/noncanonical and oversized encoded query before reading', async () => {
    const { app, services } = setup();
    const malformed = [
      '',
      'query=%7B',
      'query=null',
      `query=${encodeURIComponent(JSON.stringify(query, null, 2))}`,
      `${encodedQuery(query)}&extra=1`,
      `${encodedQuery(query)}&${encodedQuery(query)}`,
      encodedQuery({ ...query, limit: 101 }),
      `query=${encodeURIComponent('{"limit":1,"limit":10}')}`,
    ];
    for (const suffix of malformed)
      expect(
        (await app.inject({ url: `/gallery/media/navigation?${suffix}`, headers })).statusCode,
      ).toBe(400);
    // The encoded query exceeds the contract budget before JSON/schema reads.
    expect(
      (
        await app.inject({
          url: `/gallery/media/navigation?${encodedQuery({ ...query, extra: 'x'.repeat(1048577) })}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(services.navigate).not.toHaveBeenCalled();
  });
  it('rejects oversized mutation body at Fastify before service execution', async () => {
    const { app, services } = setup();
    const result = await app.inject({
      method: 'POST',
      url: '/gallery/albums',
      payload: { title: 'x'.repeat(1048577) },
      headers,
    });
    expect(result.statusCode).toBe(413);
    expect(services.createAlbum).not.toHaveBeenCalled();
  });
  it('denies absent services without fabricated success', async () => {
    const { app } = setup(true);
    const result = await app.inject({ ...commands[0], headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: { code: 'GALLERY_NAVIGATION_UNAVAILABLE' } });
  });
  it.each(commands)(
    'validates $method reply identity/revision and complete strict fields',
    async (command) => {
      const { app, services } = setup();
      services[command.operation].mockResolvedValue({
        ...album,
        id: other,
        revision: 1,
        privateSecret: 'must not escape',
      });
      const result = await app.inject({ ...command, headers });
      expect(result.statusCode).toBe(502);
      expect(result.json()).toEqual({ error: { code: 'INVALID_REPLY' } });
    },
  );
  it('rejects schema-valid but unrelated query and mutation replies', async () => {
    const { app, services } = setup();
    services.navigate.mockResolvedValue({
      schemaVersion: 3,
      query: { ...query, limit: 9 },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(
      (await app.inject({ url: `/gallery/media/navigation?${encodedQuery(query)}`, headers }))
        .statusCode,
    ).toBe(502);
    services.renameAlbum.mockResolvedValue({ ...album, id: other, revision: 2 });
    expect((await app.inject({ ...commands[1], headers })).statusCode).toBe(502);
    services.deleteAlbum.mockResolvedValue({
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 1,
      detachedMediaCount: 0,
    });
    expect((await app.inject({ ...commands[2], headers })).statusCode).toBe(502);
    services.updateMembership.mockResolvedValue({ ...media, albumMembership: { albumId: other } });
    expect((await app.inject({ ...commands[3], headers })).statusCode).toBe(502);
    services.createAlbum.mockResolvedValue({ ...album, revision: 2 });
    expect((await app.inject({ ...commands[0], headers })).statusCode).toBe(502);
  });
  it.each([
    ['ALBUM_NOT_FOUND', 404],
    ['MEDIA_NOT_FOUND', 404],
    ['ALBUM_CONFLICT', 409],
    ['MEDIA_ACCESS_CONFLICT', 409],
    ['GALLERY_NAVIGATION_UNAVAILABLE', 503],
  ] as const)(
    'translates known service failure %s without message leakage',
    async (code, status) => {
      const { app, services } = setup();
      services.createAlbum.mockRejectedValue(new GalleryNavigationServiceError(code));
      const result = await app.inject({ ...commands[0], headers });
      expect(result.statusCode).toBe(status);
      expect(result.json()).toEqual({ error: { code } });
    },
  );
  it('does not expose arbitrary service exceptions', async () => {
    const { app, services } = setup();
    services.createAlbum.mockRejectedValue(new Error('private service detail'));
    const result = await app.inject({ ...commands[0], headers });
    expect(result.statusCode).toBe(500);
    expect(result.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
  });
});

// Fastify service fixtures are boundary checks, not actual SQL/privacy restore acceptance.
describe('Gallery delete HTTP scalar count boundary', () => {
  it.each([1001, 2147483647])('returns exact committed service receipt count %i', async (count) => {
    const { app, services } = setup();
    const receipt = {
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 2,
      detachedMediaCount: count,
    };
    services.deleteAlbum.mockResolvedValue(receipt);
    const result = await app.inject({
      method: 'DELETE',
      url: `/gallery/albums/${id}`,
      headers,
      payload: { albumId: id, expectedRevision: 1 },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(receipt);
    expect(services.deleteAlbum).toHaveBeenCalledExactlyOnceWith(
      'owned-athlete',
      { albumId: id, expectedRevision: 1 },
      headers['idempotency-key'],
    );
  });
  it('rejects overflowing count and mismatched receipt identity/revision with sanitized INVALID_REPLY', async () => {
    const { app, services } = setup();
    const receipt = {
      schemaVersion: 1,
      status: 'deleted',
      albumId: id,
      revision: 2,
      detachedMediaCount: 1001,
    };
    for (const invalid of [
      { ...receipt, detachedMediaCount: 2147483648 },
      { ...receipt, detachedMediaCount: 0.5 },
      { ...receipt, albumId: other },
      { ...receipt, revision: 3 },
      { ...receipt, items: [] },
    ]) {
      services.deleteAlbum.mockResolvedValue(invalid);
      const result = await app.inject({
        method: 'DELETE',
        url: `/gallery/albums/${id}`,
        headers,
        payload: { albumId: id, expectedRevision: 1 },
      });
      expect(result.statusCode).toBe(502);
      expect(result.json()).toEqual({ error: { code: 'INVALID_REPLY' } });
    }
    expect(services.deleteAlbum).toHaveBeenCalledTimes(5);
  });
});
