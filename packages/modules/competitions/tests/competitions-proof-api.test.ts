import { expect, it, vi } from 'vitest';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { createCompetitionsProofApi } from '../src/competitions-proof-api';
import { RaceRequestError } from '../src/race-api';
const id = 'abcdefab-1234-4123-8123-123456789abc';
const versionId = 'bbcdefab-1234-4123-8123-123456789abc';
function transport(
  body: unknown,
  status = 200,
  captured?: TransportRequest[],
): AuthenticatedTransport {
  return {
    request: async (request) => {
      captured?.push(request);
      return transportReplySchema.parse({ status, body, traceId: null });
    },
  };
}
it('lists only public DTOs with bounded pagination and explicit filters', async () => {
  const requests: TransportRequest[] = [];
  const api = createCompetitionsProofApi(transport({ items: [], total: 0 }, 200, requests));
  expect(await api.gallery.list({ mediaKind: 'image', limit: 4, offset: 2 })).toEqual({
    items: [],
    total: 0,
  });
  expect(await api.resources.list({ query: '대회', favorite: false })).toEqual({
    items: [],
    total: 0,
  });
  expect(requests[0]?.path).toBe('/bff/v1/gallery/media?limit=4&offset=2&mediaKind=image');
  expect(
    new URL(requests[1]?.path ?? '', 'https://example.test').searchParams.get('favorite'),
  ).toBe('false');
  expect(() => api.gallery.list({ limit: 101 })).toThrow();
});
it('reads exact immutable resource version and preserves contentless unavailable/deleted states', async () => {
  const requests: TransportRequest[] = [];
  const unavailable = createCompetitionsProofApi(
    transport({ status: 'unavailable' }, 200, requests),
  );
  expect(await unavailable.resources.read(id, { versionId })).toEqual({ status: 'unavailable' });
  expect(requests[0]?.path).toBe(`/bff/v1/resources/${id}?versionId=${versionId}`);
  const deleted = {
    status: 'deleted',
    resourceId: id,
    deletedAt: '2026-10-07T00:00:00.000Z',
    accessRevision: 2,
  };
  expect(
    await createCompetitionsProofApi(transport(deleted)).resources.read(id, { versionId }),
  ).toEqual(deleted);
  // @ts-expect-error exercise the untyped boundary: exact version is mandatory.
  await expect(unavailable.resources.read(id, {})).rejects.toThrow();
  await expect(
    createCompetitionsProofApi(transport({ ...deleted, resourceId: versionId })).resources.read(
      id,
      { versionId },
    ),
  ).rejects.toThrow();
});
it('gallery exact read matches identity and cannot inject attachment authority', async () => {
  expect(
    await createCompetitionsProofApi(
      transport({ status: 'unavailable', mediaItemId: id }),
    ).gallery.read(id.toUpperCase()),
  ).toEqual({ status: 'unavailable', mediaItemId: id });
  await expect(
    createCompetitionsProofApi(
      transport({ status: 'unavailable', mediaItemId: versionId }),
    ).gallery.read(id),
  ).rejects.toThrow();
  await expect(
    createCompetitionsProofApi(
      transport({ status: 'unavailable', mediaItemId: id, verified: true }),
    ).gallery.read(id),
  ).rejects.toThrow();
  await expect(
    createCompetitionsProofApi(
      transport({ error: { code: 'SOURCE_NOT_FOUND' } }, 404),
    ).gallery.read(id),
  ).rejects.toEqual(new RaceRequestError(404, 'SOURCE_NOT_FOUND'));
});
it('does not send already aborted requests or expose private HTTP messages', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn();
  await expect(
    createCompetitionsProofApi({ request }).resources.read(id, { versionId }, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
  await expect(
    createCompetitionsProofApi(transport({ message: 'private URL' }, 403)).gallery.read(id),
  ).rejects.toEqual(new RaceRequestError(403, 'REQUEST_FAILED'));
});
it('preserves image and historical PDF descriptors without converting them into verification', async () => {
  const createdAt = '2026-10-07T00:00:00.000Z';
  const image = {
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
    createdAt,
    updatedAt: createdAt,
  };
  expect(
    await createCompetitionsProofApi(transport({ status: 'available', item: image })).gallery.read(
      id,
    ),
  ).toEqual({ status: 'available', item: image });
  const lifecycle = { contentStatus: 'raw_stored', indexStatus: 'not_indexed' };
  const file = {
    originalFileName: 'result.pdf',
    extension: 'pdf',
    mediaType: 'application/pdf',
    byteSize: 2048,
    sha256: 'b'.repeat(64),
  };
  const resource = {
    schemaVersion: 1,
    id,
    sourceKind: 'file',
    title: '대회 결과',
    category: 'race_material',
    metadata: {},
    tags: [],
    visibility: 'private',
    favorite: false,
    includeForCoach: false,
    reviewedState: 'unreviewed',
    lifecycle,
    accessRevision: 3,
    currentVersionId: 'cbcdefab-1234-4123-8123-123456789abc',
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const version = {
    schemaVersion: 1,
    id: versionId,
    resourceId: id,
    version: 1,
    previousVersionId: null,
    contentHash: file.sha256,
    source: { kind: 'file', file },
    lifecycle,
    createdAt,
  };
  const body = {
    status: 'available',
    resource,
    version,
    reader: {
      resourceId: id,
      resourceVersionId: versionId,
      title: resource.title,
      sourceKind: 'file',
      lifecycle,
      file,
    },
  };
  expect(
    await createCompetitionsProofApi(transport(body)).resources.read(id, { versionId }),
  ).toEqual(body);
  await expect(
    createCompetitionsProofApi(transport(body)).resources.read(id, {
      versionId: resource.currentVersionId,
    }),
  ).rejects.toThrow();
});
