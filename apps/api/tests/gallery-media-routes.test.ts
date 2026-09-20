import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import { createGalleryFinalObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { GalleryMediaRepository } from '@workout/server-persistence/gallery-media';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mediaItemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = { ...baseHeaders, 'idempotency-key': 'gallery-command-0001' };
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
const pngSha256 = createHash('sha256').update(pngBytes).digest('hex');
const reservation = {
  uploadId,
  mediaItemId,
  operation: 'create_item' as const,
  state: 'reserved' as const,
  createdAt,
  updatedAt: createdAt,
};
const item = {
  id: mediaItemId,
  mediaKind: 'image' as const,
  visibility: 'private' as const,
  includeForCoach: false as const,
  album: '대회',
  caption: '결승선',
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: {
    originalFileName: '결승선.png',
    mediaType: 'image/png' as const,
    byteSize: pngBytes.byteLength,
    sha256: pngSha256,
  },
  preview: null,
  accessRevision: 1,
  createdAt,
  updatedAt: createdAt,
};
const instances: ReturnType<typeof createApi>[] = [];

function storageFixture(): ObjectStorage {
  const objects = new Map<string, Uint8Array>();
  return {
    async writeTemporary(key, body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, bytes);
      return { key, sizeBytes: bytes.byteLength, modifiedAt: new Date(createdAt) };
    },
    async publishTemporary(temporaryKey, finalKey, expectation) {
      const bytes = objects.get(temporaryKey);
      if (bytes === undefined) throw new Error('missing temporary fixture object');
      objects.delete(temporaryKey);
      const outcome = objects.has(finalKey) ? 'already_present' : 'published';
      objects.set(finalKey, bytes);
      return { key: finalKey, outcome, ...expectation };
    },
    async open(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        key,
        sizeBytes: bytes.byteLength,
        modifiedAt: new Date(createdAt),
        body: Readable.from([bytes]),
      };
    },
    async stat(key) {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { key, sizeBytes: bytes.byteLength, modifiedAt: new Date(createdAt) };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function setup() {
  const storage = storageFixture();
  const media: GalleryMediaRepository = {
    list: vi.fn().mockResolvedValue({ items: [item], total: 1 }),
    read: vi.fn().mockResolvedValue({ status: 'available', item }),
    getUpload: vi.fn().mockResolvedValue(reservation),
    reserveCreate: vi.fn().mockResolvedValue(reservation),
    reservePreview: vi
      .fn()
      .mockResolvedValue({ ...reservation, operation: 'attach_preview' as const }),
    prepareObject: vi.fn().mockResolvedValue({ ...reservation, state: 'prepared' as const }),
    markStaged: vi.fn().mockResolvedValue({ ...reservation, state: 'staged' as const }),
    finalize: vi.fn().mockResolvedValue({ status: 'available', item }),
    fail: vi.fn().mockResolvedValue({ failed: true }),
    update: vi.fn().mockResolvedValue({ status: 'available', item }),
    softDelete: vi.fn().mockResolvedValue({
      status: 'deleted',
      mediaItemId,
      deletedAt: createdAt,
      accessRevision: 2,
    }),
    resolveObject: vi.fn().mockResolvedValue(null),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId,
        sessionId: 'current',
        csrfToken,
        method: 'cookie' as const,
      }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    galleryMedia: { media, storage },
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, media, storage };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('gallery media API boundaries', () => {
  it('derives ownership from authentication and never echoes a storage reference', async () => {
    const { app, media } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/gallery/media?mediaKind=image&limit=50&offset=0',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(media.list).toHaveBeenCalledWith(athleteId, {
      mediaKind: 'image',
      limit: 50,
      offset: 0,
    });
    expect(response.body).not.toContain('private/v1/tenants');
    expect(response.body).not.toContain('storageRef');
  });

  it('reserves an upload with the header idempotency key', async () => {
    const { app, media } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/gallery/media/uploads',
      headers: commandHeaders,
      payload: { mediaKind: 'image' },
    });
    expect(response.statusCode).toBe(200);
    expect(media.reserveCreate).toHaveBeenCalledWith(
      athleteId,
      expect.objectContaining({ mediaKind: 'image', album: null, caption: null }),
      'gallery-command-0001',
    );
    expect(response.json()).toMatchObject({ uploadId, mediaItemId, state: 'reserved' });
  });

  it('stores a validated image under the gallery key scheme and stages the upload', async () => {
    const { app, media, storage } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/gallery/media/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'image/png',
        'x-gallery-file-name': encodeURIComponent('결승선.png'),
      },
      payload: pngBytes,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'staged' });
    const expectedKey = createGalleryFinalObjectKey({
      tenantId: athleteId,
      mediaItemId,
      uploadId,
      sha256: pngSha256,
      extension: 'png',
    });
    expect(media.prepareObject).toHaveBeenCalledWith(athleteId, uploadId, {
      storageRef: expectedKey,
      file: {
        originalFileName: '결승선.png',
        mediaType: 'image/png',
        byteSize: pngBytes.byteLength,
        sha256: pngSha256,
      },
    });
    expect(await storage.stat(expectedKey)).not.toBeNull();
  });

  it('rejects a declared type outside the allowlist before touching storage', async () => {
    const { app, media } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/gallery/media/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'image/gif',
        'x-gallery-file-name': encodeURIComponent('a.gif'),
      },
      payload: Buffer.from('GIF89a'),
    });
    expect(response.statusCode).toBe(415);
    expect(media.prepareObject).not.toHaveBeenCalled();
  });

  it('fails the upload when the body contradicts the declared content type', async () => {
    const { app, media } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/gallery/media/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'image/png',
        'x-gallery-file-name': encodeURIComponent('a.png'),
      },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_MEDIA_SIGNATURE' } });
    expect(media.fail).toHaveBeenCalledWith(athleteId, uploadId, 'INVALID_MEDIA_SIGNATURE');
  });

  it('refuses an oversized declared length without reading the body', async () => {
    const { app, media } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/gallery/media/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'image/png',
        'x-gallery-file-name': encodeURIComponent('a.png'),
        'content-length': String(64 * 1024 * 1024 + 1),
      },
      payload: pngBytes,
    });
    expect(response.statusCode).toBe(413);
    expect(media.prepareObject).not.toHaveBeenCalled();
  });

  it('serves stored bytes without a signed URL and refuses a foreign storage reference', async () => {
    const { app, media, storage } = setup();
    const key = createGalleryFinalObjectKey({
      tenantId: athleteId,
      mediaItemId,
      uploadId,
      sha256: pngSha256,
      extension: 'png',
    });
    await storage.writeTemporary(
      `private/v1/tenants/${athleteId}/gallery/${mediaItemId}/temporary/${uploadId}` as never,
      (async function* () {
        yield new Uint8Array(pngBytes);
      })(),
    );
    await storage.publishTemporary(
      `private/v1/tenants/${athleteId}/gallery/${mediaItemId}/temporary/${uploadId}` as never,
      key,
      { sizeBytes: pngBytes.byteLength, sha256: pngSha256 },
    );
    vi.mocked(media.resolveObject).mockResolvedValue({
      storageRef: key,
      mediaItemId,
      mediaType: 'image/png',
      byteSize: pngBytes.byteLength,
      sha256: pngSha256,
      originalFileName: '결승선.png',
    });
    const ok = await app.inject({
      method: 'GET',
      url: `/bff/v1/gallery/media/${mediaItemId}/content`,
      headers: baseHeaders,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.rawPayload.equals(pngBytes)).toBe(true);

    vi.mocked(media.resolveObject).mockResolvedValue({
      storageRef: key.replace(athleteId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      mediaItemId,
      mediaType: 'image/png',
      byteSize: pngBytes.byteLength,
      sha256: pngSha256,
      originalFileName: '결승선.png',
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/bff/v1/gallery/media/${mediaItemId}/content`,
      headers: baseHeaders,
    });
    expect(foreign.statusCode).toBe(500);
    expect(foreign.body).not.toContain('private/v1/tenants');
  });

  it('requires an expected revision and idempotency key to delete', async () => {
    const { app, media } = setup();
    const missing = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/gallery/media/${mediaItemId}`,
      headers: baseHeaders,
      payload: { expectedAccessRevision: 1 },
    });
    expect(missing.statusCode).toBe(400);
    const response = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/gallery/media/${mediaItemId}`,
      headers: commandHeaders,
      payload: { expectedAccessRevision: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'deleted', mediaItemId, accessRevision: 2 });
    expect(media.softDelete).toHaveBeenCalledWith(athleteId, mediaItemId, {
      expectedAccessRevision: 1,
      idempotencyKey: 'gallery-command-0001',
    });
  });

  it('rejects requests without session binding and cross-origin writes', async () => {
    const { app } = setup();
    const unbound = await app.inject({
      method: 'GET',
      url: '/bff/v1/gallery/media?limit=50&offset=0',
    });
    expect(unbound.statusCode).toBe(409);
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/bff/v1/gallery/media/uploads',
      headers: { ...commandHeaders, origin: 'https://attacker.example' },
      payload: { mediaKind: 'image' },
    });
    expect(crossOrigin.statusCode).toBe(403);
  });
});
