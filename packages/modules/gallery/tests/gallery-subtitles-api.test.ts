import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  createGallerySubtitlesApi,
  createGallerySubtitlesReader,
  GallerySubtitlesRequestError,
} from '../src/gallery-subtitles-api';

const id = 'abcdef00-0000-4000-8000-000000000001';
const trackId = 'abcdef00-0000-4000-8000-000000000002';
const other = 'abcdef00-0000-4000-8000-000000000003';
const header = { 'idempotency-key': 'subtitle-command-1' };
const attachBody = {
  expectedAccessRevision: 4,
  language: 'ko',
  label: '한국어',
  file: { originalFileName: '원본.vtt', base64: Buffer.from('WEBVTT\n\n').toString('base64') },
};
const detachedBody = { expectedAccessRevision: 4, trackId, expectedTrackRevision: 3 };
const attached = {
  schemaVersion: 1,
  mediaItemId: id,
  accessRevision: 5,
  trackId,
  trackRevision: 1,
  status: 'attached',
  source: {
    byteSize: 8,
    sha256: 'a'.repeat(64),
    parserVersion: 'user-webvtt-plain-v1',
    origin: 'user_supplied',
  },
};
const detached = {
  schemaVersion: 1,
  mediaItemId: id,
  accessRevision: 5,
  trackId,
  trackRevision: 4,
  status: 'detached',
};
function setup(body: unknown, status = 200) {
  const reply = { status, body: null, traceId: null };
  Object.defineProperty(reply, 'body', { value: body, enumerable: true });
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
  return { api: createGallerySubtitlesApi({ request }), request };
}
function readResult(status: 'missing' | 'none' | 'unavailable' | 'available') {
  const identity = { schemaVersion: 1, mediaItemId: id, accessRevision: 4 };
  if (status === 'available')
    return {
      ...identity,
      status,
      tracks: [
        {
          id: trackId,
          revision: 3,
          language: 'ko',
          label: '한국어',
          cues: [{ startMs: 0, endMs: 1000, text: '안녕' }],
        },
      ],
    };
  return status === 'unavailable'
    ? { ...identity, status, reason: 'stale_response' }
    : { ...identity, status };
}

describe('gallery subtitles authenticated transport', () => {
  it('normalizes UUID paths and canonical decimal query and forwards cancellation', async () => {
    const result = readResult('none');
    const { api, request } = setup(result);
    const controller = new AbortController();
    expect(
      await api.read({ mediaItemId: id.toUpperCase(), accessRevision: 4 }, controller.signal),
    ).toEqual(result);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/gallery/media/${id}/subtitles?accessRevision=4`,
      method: 'GET',
      body: null,
      idempotencyKey: null,
      signal: controller.signal,
    });
  });
  it.each(['missing', 'none', 'unavailable', 'available'] as const)(
    'preserves actual %s DTO rather than manufacturing none',
    async (status) => {
      const result = readResult(status);
      expect(await setup(result).api.read({ mediaItemId: id, accessRevision: 4 })).toEqual(result);
    },
  );
  it('keeps attach bytes/name/body intact and sends key outside body, including successful replay', async () => {
    const { api, request } = setup(attached);
    const controller = new AbortController();
    expect(await api.attach(id.toUpperCase(), attachBody, header, controller.signal)).toEqual(
      attached,
    );
    expect(await api.attach(id, attachBody, header)).toEqual(attached);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toEqual({
      path: `/bff/v1/gallery/media/${id}/subtitles`,
      method: 'POST',
      body: attachBody,
      idempotencyKey: header['idempotency-key'],
      signal: controller.signal,
    });
  });
  it('uses DELETE with exact path/body track identity and original expected revisions', async () => {
    const { api, request } = setup(detached);
    expect(await api.detach(id, trackId.toUpperCase(), detachedBody, header)).toEqual(detached);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      path: `/bff/v1/gallery/media/${id}/subtitles/${trackId}`,
      method: 'DELETE',
      body: detachedBody,
      idempotencyKey: header['idempotency-key'],
    });
    await expect(api.detach(id, other, detachedBody, header)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      mutationOutcome: 'not_sent',
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects unknown input fields, unsafe revisions, noncanonical base64 and body keys before dispatch', async () => {
    const { api, request } = setup(attached);
    for (const body of [
      { ...attachBody, expectedAccessRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...attachBody, idempotencyKey: 'not-body' },
      { ...attachBody, file: { ...attachBody.file, base64: 'YR==' } },
      { ...attachBody, file: { ...attachBody.file, base64: '' } },
      { ...attachBody, athleteId: other },
    ])
      await expect(api.attach(id, body, header)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        mutationOutcome: 'not_sent',
      });
    await expect(api.read({ mediaItemId: '../secret', accessRevision: 4 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(api.read({ mediaItemId: id, accessRevision: '04' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      api.attach(id, attachBody, { ...header, authorization: 'private' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).not.toHaveBeenCalled();
  });
  it('transfers the full approved 512KiB source without a smaller accidental transport limit', async () => {
    const body = {
      ...attachBody,
      file: { originalFileName: null, base64: Buffer.alloc(512 * 1024, 65).toString('base64') },
    };
    const { api, request } = setup({
      ...attached,
      source: { ...attached.source, byteSize: 512 * 1024 },
    });
    await api.attach(id, body, header);
    expect(request.mock.calls[0]?.[0].body).toEqual(body);
    await expect(
      api.attach(
        id,
        {
          ...body,
          file: { ...body.file, base64: Buffer.alloc(512 * 1024 + 1).toString('base64') },
        },
        header,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects foreign read identities and stale revisions', async () => {
    for (const body of [
      { ...readResult('none'), mediaItemId: other },
      { ...readResult('none'), accessRevision: 3 },
    ])
      await expect(
        setup(body).api.read({ mediaItemId: id, accessRevision: 4 }),
      ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  });
  it('rejects attach reply identity/status and every wrong CAS revision', async () => {
    for (const body of [
      { ...attached, mediaItemId: other },
      { ...attached, status: 'detached' },
      ...[3, 4, 6].map((accessRevision) => ({ ...attached, accessRevision })),
      ...[0, 2].map((trackRevision) => ({ ...attached, trackRevision })),
    ])
      await expect(setup(body).api.attach(id, attachBody, header)).rejects.toMatchObject({
        code: 'INVALID_REPLY',
        mutationOutcome: 'uncertain',
      });
  });
  it('rejects detach reply target and lower/same/higher wrong media and track revisions', async () => {
    for (const body of [
      { ...detached, trackId: other },
      { ...detached, mediaItemId: other },
      ...[3, 4, 6].map((accessRevision) => ({ ...detached, accessRevision })),
      ...[2, 3, 5].map((trackRevision) => ({ ...detached, trackRevision })),
    ])
      await expect(setup(body).api.detach(id, trackId, detachedBody, header)).rejects.toMatchObject(
        { code: 'INVALID_REPLY', mutationOutcome: 'uncertain' },
      );
  });
  it('requires exact HTTP200 for initial and replay rather than treating other success statuses as committed DTOs', async () => {
    await expect(setup(attached, 201).api.attach(id, attachBody, header)).rejects.toMatchObject({
      code: 'INVALID_REPLY',
      status: 201,
      mutationOutcome: 'uncertain',
    });
  });
  it('does not inspect HTTP error bodies and preserves 409 rejection separately from 503 uncertainty', async () => {
    const getter = vi.fn(() => {
      throw new Error('private');
    });
    const raw = Object.defineProperty({}, 'message', { enumerable: true, get: getter });
    await expect(setup(raw, 409).api.attach(id, attachBody, header)).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      status: 409,
      mutationOutcome: 'rejected',
    });
    await expect(
      setup(raw, 409).api.read({ mediaItemId: id, accessRevision: 4 }),
    ).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      status: 409,
      mutationOutcome: 'not_applicable',
    });
    await expect(setup(raw, 503).api.attach(id, attachBody, header)).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      status: 503,
      mutationOutcome: 'uncertain',
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects accessors and extra response fields without executing getters or leaking private errors', async () => {
    const getter = vi.fn(() => 'private');
    const reply = Object.defineProperty({ status: 200, body: null, traceId: null }, 'body', {
      enumerable: true,
      get: getter,
    });
    const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
    await expect(
      createGallerySubtitlesApi({ request }).read({ mediaItemId: id, accessRevision: 4 }),
    ).rejects.toBeInstanceOf(GallerySubtitlesRequestError);
    const body = Object.defineProperty({ ...attachBody }, 'label', {
      enumerable: true,
      get: getter,
    });
    await expect(setup(attached).api.attach(id, body, header)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      setup({ ...readResult('none'), privateField: 'private' }).api.read({
        mediaItemId: id,
        accessRevision: 4,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('enforces aggregate read response bytes, track bounds and ordering', async () => {
    const track = {
      id: trackId,
      revision: 1,
      language: 'ko',
      label: 'text',
      cues: [{ startMs: 1, endMs: 2, text: 'caption' }],
    };
    for (const tracks of [
      Array.from({ length: 9 }, () => track),
      [
        {
          ...track,
          cues: [
            { startMs: 2, endMs: 3, text: 'a' },
            { startMs: 1, endMs: 2, text: 'b' },
          ],
        },
      ],
      [
        {
          ...track,
          cues: Array.from({ length: 1000 }, (_, i) => ({
            startMs: i,
            endMs: i + 1,
            text: '한'.repeat(2000),
          })),
        },
      ],
    ])
      await expect(
        setup({ ...readResult('available'), tracks }).api.read({
          mediaItemId: id,
          accessRevision: 4,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  });
  it('distinguishes pre-dispatch abort from an uncertain mutation after dispatch without retry', async () => {
    const controller = new AbortController();
    controller.abort();
    const { api, request } = setup(attached);
    await expect(api.attach(id, attachBody, header, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
      mutationOutcome: 'not_sent',
    });
    expect(request).not.toHaveBeenCalled();
    const active = new AbortController();
    const late = vi.fn<AuthenticatedTransport['request']>(async () => {
      active.abort();
      return { status: 200, body: attached, traceId: null };
    });
    await expect(
      createGallerySubtitlesApi({ request: late }).attach(id, attachBody, header, active.signal),
    ).rejects.toMatchObject({ code: 'ABORTED', mutationOutcome: 'uncertain' });
    expect(late).toHaveBeenCalledOnce();
  });
  it('sanitizes transport rejection and does not automatically resend or replace a key', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>(async () => {
      throw new Error('private auth source');
    });
    const api = createGallerySubtitlesApi({ request });
    await expect(api.attach(id, attachBody, header)).rejects.toMatchObject({
      message: 'TRANSPORT_FAILED',
      mutationOutcome: 'uncertain',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].idempotencyKey).toBe(header['idempotency-key']);
  });
});

describe('viewer subtitles reader adapter', () => {
  function reader(body: unknown, status = 200) {
    const reply = { status, body: null, traceId: null };
    Object.defineProperty(reply, 'body', { value: body, enumerable: true });
    const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
    return { reader: createGallerySubtitlesReader({ request }), request };
  }
  const input = () => ({
    mediaItemId: id,
    accessRevision: 4,
    signal: new AbortController().signal,
  });
  it('reads the exact revision through the BFF and passes the validated descriptor', async () => {
    const { reader: subject, request } = reader(readResult('available'));
    await expect(subject.read(input())).resolves.toEqual(readResult('available'));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      path: `/bff/v1/gallery/media/${id}/subtitles?accessRevision=4`,
    });
  });
  it('maps only 503 to reader unavailable and 409 to stale, without reading error bodies', async () => {
    const body = { error: { code: 'private server detail' } };
    await expect(reader(body, 503).reader.read(input())).resolves.toEqual({
      schemaVersion: 1,
      mediaItemId: id,
      accessRevision: 4,
      status: 'unavailable',
      reason: 'reader_unavailable',
    });
    await expect(reader(body, 409).reader.read(input())).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'stale_response',
    });
    for (const status of [404, 500, 502]) {
      const failure = await reader(body, status)
        .reader.read(input())
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GallerySubtitlesRequestError);
      expect(String(failure)).not.toContain('private server detail');
    }
  });
  it('rejects an invalid or foreign reply instead of inventing none', async () => {
    const foreign = { ...readResult('none'), mediaItemId: other };
    await expect(reader(foreign).reader.read(input())).rejects.toMatchObject({
      code: 'INVALID_REPLY',
    });
  });
});
