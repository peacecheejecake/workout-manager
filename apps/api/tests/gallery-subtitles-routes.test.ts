import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConsentRequiredError } from '@workout/server-persistence/app-admission';
import { registerGallerySubtitlesRoutes } from '../src/gallery-subtitles-routes.js';
import {
  createGallerySubtitlesReadService,
  GallerySubtitlesServiceError,
} from '../src/gallery-subtitles-service.js';
import { ProductRequestError } from '../src/product-boundary.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const identity = { schemaVersion: 1 as const, mediaItemId: id, accessRevision: 2 };
const track = {
  id: other,
  revision: 1,
  language: 'ko',
  label: '직접 첨부',
  cues: [{ startMs: 0, endMs: 1000, text: '합성 자막' }],
};
const media = {
  status: 'available',
  item: {
    id,
    mediaKind: 'video',
    visibility: 'private',
    includeForCoach: false,
    album: null,
    caption: null,
    activityId: null,
    capturedAt: null,
    capturedLocalDate: null,
    file: {
      originalFileName: 'synthetic.mp4',
      mediaType: 'video/mp4',
      byteSize: 1,
      sha256: 'a'.repeat(64),
    },
    preview: null,
    accessRevision: 2,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  },
};
const snapshot = (subtitles: unknown) => ({ media, subtitles });
const headers = { authorization: 'Bearer synthetic' };
const url = `/gallery/media/${id}/subtitles?accessRevision=2`;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(absent = false, cookie = false) {
  const read = vi
    .fn<
      (
        athleteId: string,
        input: { mediaItemId: string; accessRevision: number },
      ) => Promise<unknown>
    >()
    .mockResolvedValue(snapshot({ ...identity, status: 'available', tracks: [track] }));
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  registerGallerySubtitlesRoutes(
    app,
    absent ? undefined : createGallerySubtitlesReadService({ read }),
    (request) => {
      if (request.headers.authorization !== headers.authorization)
        throw new ProductRequestError(401, 'UNAUTHENTICATED');
      return cookie
        ? {
            method: 'cookie',
            athleteId: 'owned-athlete',
            sessionId: 'session',
            csrfToken: 'x'.repeat(32),
          }
        : { method: 'bearer', athleteId: 'owned-athlete', sessionId: 'session' };
    },
  );
  return { app, read };
}
describe('Gallery subtitle GET boundary; injected adapter, not DB acceptance', () => {
  it.each(['available', 'none', 'missing', 'unavailable'] as const)(
    'preserves explicit %s without inventing a track',
    async (status) => {
      const { app, read } = setup();
      const result =
        status === 'available'
          ? { ...identity, status, tracks: [track] }
          : status === 'unavailable'
            ? { ...identity, status, reason: 'load_failed' }
            : { ...identity, status };
      read.mockResolvedValue(snapshot(result));
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(read).toHaveBeenCalledExactlyOnceWith('owned-athlete', {
        mediaItemId: id,
        accessRevision: 2,
      });
    },
  );
  it('requires authentication before invoking the service', async () => {
    const { app, read } = setup();
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
  it('permits read-only cookie GET without introducing write CSRF enforcement', async () => {
    const { app } = setup(false, true);
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    // Outer app session authentication/fencing is not simulated by this route-only fixture.
  });
  it.each([
    '',
    '?accessRevision=0',
    '?accessRevision=01',
    '?accessRevision=-1',
    '?accessRevision=1.0',
    '?accessRevision=1e1',
    '?accessRevision=9007199254740992',
    '?accessRevision=2&accessRevision=2',
    '?accessRevision=2&athleteId=foreign',
  ])('rejects noncanonical or substituted query %s', async (query) => {
    const { app, read } = setup();
    expect(
      (await app.inject({ url: `/gallery/media/${id}/subtitles${query}`, headers })).statusCode,
    ).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it('normalizes UUID casing and preserves the safe-integer revision limit', async () => {
    const { app, read } = setup();
    read.mockResolvedValue({
      media: { ...media, item: { ...media.item, accessRevision: Number.MAX_SAFE_INTEGER } },
      subtitles: { ...identity, accessRevision: Number.MAX_SAFE_INTEGER, status: 'none' },
    });
    expect(
      (
        await app.inject({
          url: `/gallery/media/${id.toUpperCase()}/subtitles?accessRevision=${Number.MAX_SAFE_INTEGER}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith('owned-athlete', {
      mediaItemId: id,
      accessRevision: Number.MAX_SAFE_INTEGER,
    });
  });
  it('rejects malformed media UUID before reading', async () => {
    const { app, read } = setup();
    expect(
      (await app.inject({ url: '/gallery/media/not-uuid/subtitles?accessRevision=2', headers }))
        .statusCode,
    ).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it('does not fabricate empty success when no authoritative reader is registered', async () => {
    const { app, read } = setup(true);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: { code: 'GALLERY_SUBTITLES_UNAVAILABLE' } });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'deleted', 'absent'] as const)(
    'keeps %s media indistinguishable at the HTTP boundary',
    async () => {
      const { app, read } = setup();
      read.mockResolvedValue({
        media: { status: 'unavailable', mediaItemId: id },
        subtitles: new Proxy(
          {},
          {
            ownKeys() {
              throw Error('must not inspect denied subtitle');
            },
          },
        ),
      });
      const result = await app.inject({ url, headers });
      expect(result.statusCode).toBe(404);
      expect(result.json()).toEqual({ error: { code: 'MEDIA_NOT_FOUND' } });
      // Adapter supplies the same RLS-filtered media state; service rejects before subtitle traversal.
    },
  );
  it.each([
    ['MEDIA_ACCESS_CONFLICT', 409],
    ['GALLERY_SUBTITLES_UNAVAILABLE', 503],
  ] as const)('preserves %s as rejection', async (code, status) => {
    const { app, read } = setup();
    read.mockRejectedValue(new GallerySubtitlesServiceError(code));
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(status);
    expect(result.json()).toEqual({ error: { code } });
  });
  it('preserves an explicit existing app admission error without granting read authority', async () => {
    const { app, read } = setup();
    read.mockRejectedValue(new AppConsentRequiredError());
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toEqual({ error: { code: 'APP_CONSENT_REQUIRED' } });
  });
  it.each([
    { ...identity, status: 'none', mediaItemId: other },
    { ...identity, status: 'none', accessRevision: 1 },
    { ...identity, status: 'none', storageRef: 'private' },
    {
      ...identity,
      status: 'available',
      tracks: [{ ...track, cues: [{ startMs: 2, endMs: 1, text: 'private' }] }],
    },
    { ...identity, status: 'available', tracks: [track, track] },
  ])('rejects uncorrelated or unsafe reply (%#)', async (result) => {
    const { app, read } = setup();
    read.mockResolvedValue(snapshot(result));
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: { code: 'INVALID_REPLY' } });
  });
  it('rejects nested getter and Proxy replies without reading private values', async () => {
    const { app, read } = setup();
    let invoked = 0;
    const getter = {
      ...track,
      get label() {
        invoked++;
        return 'private';
      },
    };
    const proxy = new Proxy(track, {
      ownKeys() {
        invoked++;
        throw Error('private');
      },
    });
    for (const invalid of [getter, proxy]) {
      read.mockResolvedValue(snapshot({ ...identity, status: 'available', tracks: [invalid] }));
      expect((await app.inject({ url, headers })).statusCode).toBe(502);
    }
    expect(invoked).toBe(0);
  });
  it('rejects combined response bytes beyond the existing 512KiB active budget', async () => {
    const { app, read } = setup();
    const cues = Array.from({ length: 1000 }, (_, i) => ({
      startMs: i,
      endMs: i + 1,
      text: '한'.repeat(200),
    }));
    read.mockResolvedValue(
      snapshot({ ...identity, status: 'available', tracks: [{ ...track, cues }] }),
    );
    expect((await app.inject({ url, headers })).statusCode).toBe(502);
  });
  it('accepts semantically identical uppercase active media UUID', async () => {
    const { app, read } = setup();
    read.mockResolvedValue({
      media: { ...media, item: { ...media.item, id: id.toUpperCase() } },
      subtitles: { ...identity, status: 'none' },
    });
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ...identity, status: 'none' });
  });
  it('keeps uppercase unavailable media UUID indistinguishable without reading subtitles', async () => {
    const { app, read } = setup();
    let inspected = 0;
    read.mockResolvedValue({
      media: { status: 'unavailable', mediaItemId: id.toUpperCase() },
      subtitles: new Proxy(
        {},
        {
          ownKeys() {
            inspected++;
            throw Error('private');
          },
        },
      ),
    });
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: { code: 'MEDIA_NOT_FOUND' } });
    expect(inspected).toBe(0);
  });
  it('rejects an owned image and stale active video before subtitle traversal', async () => {
    const { app, read } = setup();
    const privateSubtitles = new Proxy(
      {},
      {
        ownKeys() {
          throw Error('must not inspect denied subtitle');
        },
      },
    );
    read.mockResolvedValue({
      media: {
        ...media,
        item: {
          ...media.item,
          mediaKind: 'image',
          file: { ...media.item.file, originalFileName: 'synthetic.png', mediaType: 'image/png' },
        },
      },
      subtitles: privateSubtitles,
    });
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    read.mockResolvedValue({
      media: { ...media, item: { ...media.item, accessRevision: 3 } },
      subtitles: privateSubtitles,
    });
    const stale = await app.inject({ url, headers });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'MEDIA_ACCESS_CONFLICT' } });
  });
  it('rejects uncorrelated media head and invalid snapshot rather than accepting adapter authority', async () => {
    const { app, read } = setup();
    for (const invalid of [
      {
        media: { ...media, item: { ...media.item, id: other } },
        subtitles: { ...identity, status: 'none' },
      },
      { media, subtitles: { ...identity, status: 'none' }, privateSecret: true },
    ]) {
      read.mockResolvedValue(invalid);
      expect((await app.inject({ url, headers })).statusCode).toBe(502);
    }
  });
  it('sanitizes arbitrary adapter failures', async () => {
    const { app, read } = setup();
    read.mockRejectedValue(new Error('private subtitle content'));
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
  });
});

function jsonBudgetSubtitle(cueExtra: number) {
  return {
    ...identity,
    status: 'available',
    tracks: Array.from({ length: 5 }, (_, t) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(t + 1).padStart(12, '0')}`,
      revision: 1,
      language: 'ko',
      label: '합성',
      cues: Array.from({ length: 998 + (t === 4 ? cueExtra : 0) }, (_, c) => ({
        startMs: c * 10,
        endMs: c * 10 + 5,
        text: 'x',
      })),
    })),
  };
}

describe('API JSON node budget parity (injected adapter; no PostgreSQL)', () => {
  it.each([0, 1])(
    'accepts five tracks with 4990+%s cues within published budget',
    async (extra) => {
      const raw = jsonBudgetSubtitle(extra);
      const { gallerySubtitleReadResultV1Schema } =
        await import('@workout/contracts/gallery-subtitles-v1');
      expect(gallerySubtitleReadResultV1Schema.safeParse(raw).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(524_288);
      const { app, read } = setup();
      read.mockResolvedValue(snapshot(raw));
      const reply = await app.inject({ url, headers });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual(raw);
      expect(reply.headers['cache-control']).toBe('private, no-store');
    },
  );
  it('rejects the next cue beyond 20000 JSON nodes without increasing the budget', async () => {
    const raw = jsonBudgetSubtitle(2);
    const { gallerySubtitleReadResultV1Schema } =
      await import('@workout/contracts/gallery-subtitles-v1');
    expect(gallerySubtitleReadResultV1Schema.safeParse(raw).success).toBe(false);
    const { app, read } = setup();
    read.mockResolvedValue(snapshot(raw));
    const reply = await app.inject({ url, headers });
    expect(reply.statusCode).toBe(502);
  });
});

describe('API nested cue guard after JSON length metadata exclusion', () => {
  it('rejects a nested cue proxy before reflection traps', async () => {
    const trap = vi.fn();
    const cue = new Proxy(
      { startMs: 0, endMs: 5, text: 'synthetic' },
      {
        getPrototypeOf(target) {
          trap();
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trap();
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          trap();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const { app, read } = setup();
    read.mockResolvedValue(
      snapshot({ ...identity, status: 'available', tracks: [{ ...track, cues: [cue] }] }),
    );
    expect((await app.inject({ url, headers })).statusCode).toBe(502);
    expect(trap).not.toHaveBeenCalled();
  });
  it('rejects a nested cue accessor without invoking the getter', async () => {
    const get = vi.fn(() => 'synthetic');
    const cue = Object.defineProperty({ startMs: 0, endMs: 5 }, 'text', { get, enumerable: true });
    const { app, read } = setup();
    read.mockResolvedValue(
      snapshot({ ...identity, status: 'available', tracks: [{ ...track, cues: [cue] }] }),
    );
    expect((await app.inject({ url, headers })).statusCode).toBe(502);
    expect(get).not.toHaveBeenCalled();
  });
});
