import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGalleryRenditionFinalObjectKey,
  createGalleryRenditionTemporaryObjectKey,
} from '@workout/server-media/keys';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import type { GalleryRenditionServices } from '../src/gallery-rendition-routes.js';
import { registerGalleryRenditionRoutes } from '../src/gallery-rendition-routes.js';
import { ProductRequestError } from '../src/product-boundary.js';

// Route boundary with an injected reader and a real private TMP object store; DB acceptance is
// in the SQL144 integration tests.
const athlete = '11111111-1111-4111-8111-111111111111';
const media = '22222222-2222-4222-8222-222222222222';
const job = '33333333-3333-4333-8333-333333333333';
const attempt = '44444444-4444-4444-8444-444444444444';
const headers = { authorization: 'Bearer synthetic' };
const bytes = Buffer.from('RIFF....WEBPsynthetic', 'latin1');
const digest = createHash('sha256').update(bytes).digest('hex');
const lineage = {
  schemaVersion: 1,
  mediaItemId: media,
  originalSha256: 'a'.repeat(64),
  parentAccessRevision: 1,
  recipeVersion: 1,
};
const list = {
  schemaVersion: 1,
  mediaItemId: media,
  renditions: [
    {
      ...lineage,
      kind: 'image_preview',
      state: 'ready',
      output: {
        mediaType: 'image/webp',
        sha256: digest,
        byteSize: bytes.length,
        widthPixels: 10,
        heightPixels: 20,
      },
    },
    { ...lineage, kind: 'image_thumbnail', state: 'unsupported', code: 'unsupported_format' },
  ],
};
const apps: FastifyInstance[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function* once(value: Uint8Array) {
  yield value;
}
async function setup(options: { absent?: boolean; store?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wm-rendition-route-'));
  roots.push(root);
  const storage = await createLocalFilesystemObjectStorage(root);
  const keyInput = {
    tenantId: athlete,
    mediaItemId: media,
    renditionKind: 'image_preview' as const,
    jobId: job,
    attemptId: attempt,
    recipeVersion: 1 as const,
  };
  const finalKey = createGalleryRenditionFinalObjectKey({
    ...keyInput,
    sha256: digest,
    extension: 'webp',
  });
  if (options.store !== false) {
    const temporary = createGalleryRenditionTemporaryObjectKey(keyInput);
    await storage.writeTemporary(temporary, once(bytes));
    await storage.publishTemporary(temporary, finalKey, {
      sizeBytes: bytes.length,
      sha256: digest,
    });
  }
  const reader = {
    list: vi.fn<GalleryRenditionServices['reader']['list']>().mockResolvedValue(list as never),
    resolveObject: vi.fn<GalleryRenditionServices['reader']['resolveObject']>().mockResolvedValue({
      storageRef: finalKey,
      sha256: digest,
      byteSize: bytes.length,
      mediaType: 'image/webp',
    }),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  registerGalleryRenditionRoutes(
    app,
    options.absent ? undefined : { reader, storage },
    (request) => {
      if (request.headers.authorization !== headers.authorization)
        throw new ProductRequestError(401, 'UNAUTHENTICATED');
      return { method: 'bearer', athleteId: athlete, sessionId: 'session' };
    },
  );
  return { app, reader, finalKey };
}

describe('gallery rendition routes', () => {
  it('returns presentation-only state for the authenticated owner', async () => {
    const { app, reader } = await setup();
    const response = await app.inject({
      url: `/gallery/media/${media.toUpperCase()}/renditions`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).not.toContain('private/v1');
    expect(reader.list).toHaveBeenCalledExactlyOnceWith(athlete, media);
  });

  it('requires authentication and rejects query substitution before reading', async () => {
    const { app, reader } = await setup();
    expect((await app.inject({ url: `/gallery/media/${media}/renditions` })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: `/gallery/media/${media}/renditions?athleteId=${randomUUID()}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/gallery/media/not-a-uuid/renditions`, headers })).statusCode,
    ).toBe(400);
    expect(reader.list).not.toHaveBeenCalled();
  });

  it('maps missing media, malformed replies and an absent service to finite errors', async () => {
    const missing = await setup();
    missing.reader.list.mockResolvedValue(null);
    const notFound = await missing.app.inject({
      url: `/gallery/media/${media}/renditions`,
      headers,
    });
    expect([notFound.statusCode, notFound.json()]).toEqual([
      404,
      { error: { code: 'MEDIA_NOT_FOUND' } },
    ]);
    const malformed = await setup();
    malformed.reader.list.mockResolvedValue({ ...list, mediaItemId: randomUUID() } as never);
    expect(
      (await malformed.app.inject({ url: `/gallery/media/${media}/renditions`, headers }))
        .statusCode,
    ).toBe(500);
    const absent = await setup({ absent: true });
    const unavailable = await absent.app.inject({
      url: `/gallery/media/${media}/renditions`,
      headers,
    });
    expect([unavailable.statusCode, unavailable.json()]).toEqual([
      503,
      { error: { code: 'GALLERY_RENDITIONS_UNAVAILABLE' } },
    ]);
  });

  it('streams only a ready receipt whose exact key, digest and size agree', async () => {
    const { app, reader } = await setup();
    const response = await app.inject({
      url: `/gallery/media/${media}/renditions/image_preview/content`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(reader.resolveObject).toHaveBeenCalledExactlyOnceWith(athlete, media, 'image_preview');
  });

  it('refuses foreign, mismatched, missing or not-ready objects', async () => {
    const notReady = await setup();
    notReady.reader.resolveObject.mockResolvedValue(null);
    expect(
      (
        await notReady.app.inject({
          url: `/gallery/media/${media}/renditions/image_preview/content`,
          headers,
        })
      ).json(),
    ).toEqual({ error: { code: 'RENDITION_NOT_READY' } });
    const wrongKind = await setup();
    expect(
      (
        await wrongKind.app.inject({
          url: `/gallery/media/${media}/renditions/image_thumbnail/content`,
          headers,
        })
      ).statusCode,
    ).toBe(500);
    const wrongDigest = await setup();
    wrongDigest.reader.resolveObject.mockResolvedValue({
      storageRef: wrongDigest.finalKey,
      sha256: 'b'.repeat(64),
      byteSize: bytes.length,
      mediaType: 'image/webp',
    });
    expect(
      (
        await wrongDigest.app.inject({
          url: `/gallery/media/${media}/renditions/image_preview/content`,
          headers,
        })
      ).statusCode,
    ).toBe(500);
    const foreign = await setup();
    expect(
      (
        await foreign.app.inject({
          url: `/gallery/media/${randomUUID()}/renditions/image_preview/content`,
          headers,
        })
      ).statusCode,
    ).toBe(500);
    const gone = await setup({ store: false });
    const missing = await gone.app.inject({
      url: `/gallery/media/${media}/renditions/image_preview/content`,
      headers,
    });
    expect([missing.statusCode, missing.json()]).toEqual([
      503,
      { error: { code: 'RENDITION_CONTENT_UNAVAILABLE' } },
    ]);
    const badKind = await setup();
    expect(
      (
        await badKind.app.inject({
          url: `/gallery/media/${media}/renditions/original/content`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(badKind.reader.resolveObject).not.toHaveBeenCalled();
  });
});
