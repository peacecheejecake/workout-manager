import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import type { ObjectStorage } from '@workout/server-media/object-storage';
import { createFinalObjectKey, createTemporaryObjectKey } from '@workout/server-media/keys';
import type { ResourceFileUploadRepository } from '@workout/server-persistence/resource-file-uploads';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const versionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = {
  ...baseHeaders,
  'idempotency-key': 'resource-file-command-0001',
};
const reservation = {
  uploadId,
  resourceId,
  versionId,
  state: 'reserved' as const,
  createdAt,
  updatedAt: createdAt,
};
const reservationResponse = {
  uploadId,
  resourceId,
  versionId,
  state: 'reserved' as const,
  createdAt,
  updatedAt: createdAt,
};
const instances: ReturnType<typeof createApi>[] = [];

function collect(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function storageFixture(): ObjectStorage {
  const objects = new Map<string, Uint8Array>();
  return {
    async writeTemporary(key, body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const bytes = collect(chunks);
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

function sharedAccessFixture() {
  return {
    readAccess: vi.fn(),
    grantShare: vi.fn(),
    revokeShare: vi.fn(),
    setReviewed: vi.fn(),
    setCoachUse: vi.fn(),
    listSharedWithMe: vi.fn(),
    readSharedWithMe: vi.fn(),
    resolveSharedObject: vi.fn().mockResolvedValue(null),
    captureCoachUseManifest: vi.fn(),
    revalidateCoachUseManifest: vi.fn(),
  };
}

function setup() {
  const bytes = Buffer.from('# 계획\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = {
    originalFileName: '훈련 계획.md',
    extension: 'md' as const,
    mediaType: 'text/markdown' as const,
    byteSize: bytes.byteLength,
    sha256,
  };
  const lifecycle = { contentStatus: 'raw_stored' as const, indexStatus: 'not_indexed' as const };
  const available = {
    status: 'available' as const,
    resource: {
      schemaVersion: 1 as const,
      id: resourceId,
      sourceKind: 'file' as const,
      title: '훈련 계획',
      category: 'guide' as const,
      metadata: {},
      tags: [],
      visibility: 'private' as const,
      favorite: false,
      includeForCoach: false as const,
      reviewedState: 'unreviewed' as const,
      lifecycle,
      accessRevision: 1,
      currentVersionId: versionId,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    },
    version: {
      schemaVersion: 1 as const,
      id: versionId,
      resourceId,
      version: 1,
      previousVersionId: null,
      contentHash: sha256,
      source: { kind: 'file' as const, file },
      lifecycle,
      createdAt,
    },
    reader: {
      resourceId,
      resourceVersionId: versionId,
      title: '훈련 계획',
      sourceKind: 'file' as const,
      lifecycle,
      file,
    },
  };
  const storage = storageFixture();
  const sharedAccess = sharedAccessFixture();
  const uploads: ResourceFileUploadRepository = {
    get: vi.fn().mockResolvedValue(reservation),
    reserveCreate: vi.fn().mockResolvedValue(reservation),
    reserveAppend: vi.fn().mockResolvedValue(reservation),
    prepareObject: vi.fn().mockResolvedValue({ ...reservation, state: 'prepared' }),
    markStaged: vi.fn().mockResolvedValue({ ...reservation, state: 'staged' }),
    finalize: vi.fn().mockResolvedValue(available),
    fail: vi.fn().mockResolvedValue({ failed: true }),
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
    resourceFiles: { uploads, storage },
    resourceAccess: sharedAccess,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, uploads, storage, sharedAccess, bytes, file, available };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('private file resource API boundaries', () => {
  it('reserves create and append uploads with authenticated ownership and header idempotency', async () => {
    const { app, uploads } = setup();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/bff/v1/resources/uploads',
      headers: commandHeaders,
      payload: {
        sourceKind: 'file',
        title: 'Training paper',
        category: 'paper',
        metadata: {},
        tags: [],
        favorite: false,
      },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toEqual(reservationResponse);
    expect(createResponse.body).not.toContain('storageRef');
    expect(uploads.reserveCreate).toHaveBeenCalledWith(
      athleteId,
      {
        sourceKind: 'file',
        title: 'Training paper',
        category: 'paper',
        metadata: {},
        tags: [],
        favorite: false,
      },
      commandHeaders['idempotency-key'],
    );

    const appendResponse = await app.inject({
      method: 'POST',
      url: `/bff/v1/resources/${resourceId.toUpperCase()}/uploads`,
      headers: commandHeaders,
      payload: { expectedCurrentVersionId: versionId.toUpperCase() },
    });
    expect(appendResponse.statusCode).toBe(200);
    expect(uploads.reserveAppend).toHaveBeenCalledWith(
      athleteId,
      resourceId,
      { expectedCurrentVersionId: versionId },
      commandHeaders['idempotency-key'],
    );
  });

  it('accepts and returns a replayed prepared reservation without internal storage refs', async () => {
    const { app, uploads } = setup();
    vi.mocked(uploads.reserveCreate).mockResolvedValue({ ...reservation, state: 'prepared' });
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/resources/uploads',
      headers: commandHeaders,
      payload: {
        sourceKind: 'file',
        title: 'Prepared paper',
        category: 'paper',
        metadata: {},
        tags: [],
        favorite: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ uploadId, resourceId, versionId, state: 'prepared' });
    expect(response.body).not.toContain('storageRef');
    expect(response.body).not.toContain('temporary');
  });

  it('streams validated raw bytes under the reserved tenant/resource and stages a safe descriptor', async () => {
    const { app, uploads, bytes, file } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/resources/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'x-resource-file-name': encodeURIComponent(file.originalFileName),
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ uploadId, resourceId, state: 'staged' });
    expect(response.body).not.toContain('storageRef');
    expect(uploads.get).toHaveBeenCalledWith(athleteId, uploadId);
    expect(uploads.prepareObject).toHaveBeenCalledWith(athleteId, uploadId, {
      storageRef: `private/v1/tenants/${athleteId}/resources/${resourceId}/objects/uploads/${uploadId}/sha256/${file.sha256}.md`,
      file,
    });
    expect(uploads.markStaged).toHaveBeenCalledWith(athleteId, uploadId);
  });

  it('returns a stable resumable error and safely retries after transient staging failure', async () => {
    const { app, uploads, storage, bytes, file } = setup();
    const finalKey = createFinalObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    const deleteObject = vi.spyOn(storage, 'delete');
    vi.mocked(uploads.markStaged).mockRejectedValueOnce(new Error('persistence unavailable'));
    const request = {
      method: 'PUT' as const,
      url: `/bff/v1/resources/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'x-resource-file-name': encodeURIComponent(file.originalFileName),
      },
      payload: bytes,
    };

    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: { code: 'UPLOAD_RESUME_REQUIRED' } });
    expect(await storage.stat(finalKey)).toMatchObject({ sizeBytes: bytes.byteLength });
    expect(deleteObject).not.toHaveBeenCalledWith(finalKey);

    expect(uploads.prepareObject).toHaveBeenCalledTimes(1);
    expect(uploads.markStaged).toHaveBeenCalledTimes(1);
    expect(uploads.fail).not.toHaveBeenCalled();
    vi.mocked(uploads.get).mockResolvedValue({ ...reservation, state: 'prepared' });

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ state: 'staged' });
    expect(uploads.prepareObject).toHaveBeenCalledTimes(2);
    expect(uploads.markStaged).toHaveBeenCalledTimes(2);
    expect(uploads.fail).not.toHaveBeenCalled();
    expect(await storage.stat(finalKey)).toMatchObject({ sizeBytes: bytes.byteLength });
  });

  it('requires a fresh reservation after a transient publish failure without terminalizing the intent', async () => {
    const { app, uploads, storage, bytes, file } = setup();
    const temporaryKey = createTemporaryObjectKey({ tenantId: athleteId, resourceId, uploadId });
    vi.spyOn(storage, 'publishTemporary').mockRejectedValueOnce(
      new Error('temporary object storage outage'),
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/resources/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'x-resource-file-name': encodeURIComponent(file.originalFileName),
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'UPLOAD_RETRY_REQUIRED' } });
    expect(uploads.prepareObject).toHaveBeenCalledTimes(1);
    expect(uploads.markStaged).not.toHaveBeenCalled();
    expect(uploads.fail).not.toHaveBeenCalled();
    expect(await storage.stat(temporaryKey)).toMatchObject({ sizeBytes: bytes.byteLength });
  });

  it('keeps identical live content isolated from durable cleanup of a failed upload', async () => {
    const { app, uploads, storage, bytes, file } = setup();
    const liveUploadId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const finalKey = createFinalObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId: liveUploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    const temporaryKey = createTemporaryObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId: liveUploadId,
    });
    await storage.writeTemporary(temporaryKey, Readable.from([bytes]));
    await storage.publishTemporary(temporaryKey, finalKey, {
      sizeBytes: bytes.byteLength,
      sha256: file.sha256,
    });
    const deleteObject = vi.spyOn(storage, 'delete');

    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/resources/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'content-length': String(bytes.byteLength + 1),
        'x-resource-file-name': encodeURIComponent(file.originalFileName),
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'CONTENT_LENGTH_MISMATCH' } });
    const failedKey = createFinalObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    expect(failedKey).not.toBe(finalKey);
    expect(uploads.prepareObject).toHaveBeenCalledWith(athleteId, uploadId, {
      storageRef: failedKey,
      file,
    });
    expect(uploads.markStaged).not.toHaveBeenCalled();
    expect(uploads.fail).toHaveBeenCalledWith(athleteId, uploadId, 'CONTENT_LENGTH_MISMATCH');
    expect(deleteObject).not.toHaveBeenCalledWith(finalKey);
    expect(await storage.stat(finalKey)).toMatchObject({ sizeBytes: bytes.byteLength });
    expect(await storage.stat(failedKey)).toMatchObject({ sizeBytes: bytes.byteLength });
  });

  it('fails a reserved intent after invalid content without exposing validation details', async () => {
    const { app, uploads, file } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/resources/uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'x-resource-file-name': encodeURIComponent(file.originalFileName),
      },
      payload: Buffer.from([0xff]),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_TEXT_ENCODING' } });
    expect(uploads.fail).toHaveBeenCalledWith(athleteId, uploadId, 'INVALID_TEXT_ENCODING');
    expect(uploads.prepareObject).not.toHaveBeenCalled();
    expect(uploads.markStaged).not.toHaveBeenCalled();
  });

  it('rejects malformed encoded names, mismatched types and cookie writes without CSRF', async () => {
    const { app, uploads, bytes } = setup();
    const requests = [
      {
        ...baseHeaders,
        'content-type': 'text/markdown',
        'x-resource-file-name': '%ZZ.md',
      },
      {
        ...baseHeaders,
        'content-type': 'application/pdf',
        'x-resource-file-name': 'notes.md',
      },
      {
        cookie: baseHeaders.cookie,
        origin: baseHeaders.origin,
        'x-workout-session-id': baseHeaders['x-workout-session-id'],
        'content-type': 'text/markdown',
        'x-resource-file-name': 'notes.md',
      },
    ];
    const responses = await Promise.all(
      requests.map((headers) =>
        app.inject({
          method: 'PUT',
          url: `/bff/v1/resources/uploads/${uploadId}/content`,
          headers,
          payload: bytes,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([400, 415, 403]);
    expect(uploads.markStaged).not.toHaveBeenCalled();
  });

  it('finalizes without accepting a body and preserves raw-stored/not-indexed lifecycle', async () => {
    const { app, uploads, available } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/resources/uploads/${uploadId}/finalize`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(available);
    expect(response.json().resource.lifecycle).toEqual({
      contentStatus: 'raw_stored',
      indexStatus: 'not_indexed',
    });
    expect(uploads.finalize).toHaveBeenCalledWith(athleteId, uploadId);

    const rejected = await app.inject({
      method: 'POST',
      url: `/bff/v1/resources/uploads/${uploadId}/finalize`,
      headers: baseHeaders,
      payload: {},
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('downloads only the server-resolved owned object and hides missing resources', async () => {
    const { app, uploads, storage, bytes, file } = setup();
    const finalKey = createFinalObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    const temporaryKey = createTemporaryObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId,
    });
    await storage.writeTemporary(temporaryKey, Readable.from([bytes]));
    await storage.publishTemporary(temporaryKey, finalKey, {
      sizeBytes: bytes.byteLength,
      sha256: file.sha256,
    });
    vi.mocked(uploads.resolveObject).mockResolvedValue({ storageRef: finalKey, file });

    const response = await app.inject({
      url: `/bff/v1/resources/${resourceId}/content?versionId=${versionId}`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(file.originalFileName)}`,
    );
    expect(uploads.resolveObject).toHaveBeenCalledWith(athleteId, resourceId, versionId);

    vi.mocked(uploads.resolveObject).mockResolvedValue(null);
    const missing = await app.inject({
      url: `/bff/v1/resources/${resourceId}/content`,
      headers: baseHeaders,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('streams a shared file to the grantee and stops as soon as the grant is gone', async () => {
    const { app, storage, sharedAccess, bytes, file } = setup();
    const ownerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const finalKey = createFinalObjectKey({
      tenantId: ownerId,
      resourceId,
      uploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    const temporaryKey = createTemporaryObjectKey({ tenantId: ownerId, resourceId, uploadId });
    await storage.writeTemporary(temporaryKey, Readable.from([bytes]));
    await storage.publishTemporary(temporaryKey, finalKey, {
      sizeBytes: bytes.byteLength,
      sha256: file.sha256,
    });
    sharedAccess.resolveSharedObject.mockResolvedValue({
      ownerPrincipalId: ownerId,
      resourceId,
      versionId,
      storageRef: finalKey,
      file,
    });

    const url = `/bff/v1/resources/shared-with-me/${ownerId}/${resourceId}/content`;
    const response = await app.inject({ url, headers: baseHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers['content-type']).toContain('text/markdown');
    // The grantee identity comes from authentication, never from the path.
    expect(sharedAccess.resolveSharedObject).toHaveBeenCalledWith(athleteId, ownerId, resourceId);
    expect(response.body).not.toContain('private/v1/tenants');

    // Revocation is re-checked on every request, with no cached authorization.
    sharedAccess.resolveSharedObject.mockResolvedValue(null);
    const revoked = await app.inject({ url, headers: baseHeaders });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toMatchObject({ error: { code: 'SHARED_RESOURCE_NOT_FOUND' } });
  });

  it('refuses a shared file object whose key does not belong to the resolved owner', async () => {
    const { app, storage, sharedAccess, bytes, file } = setup();
    const ownerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const foreignKey = createFinalObjectKey({
      tenantId: athleteId,
      resourceId,
      uploadId,
      sha256: file.sha256,
      extension: 'md',
    });
    const temporaryKey = createTemporaryObjectKey({ tenantId: athleteId, resourceId, uploadId });
    await storage.writeTemporary(temporaryKey, Readable.from([bytes]));
    await storage.publishTemporary(temporaryKey, foreignKey, {
      sizeBytes: bytes.byteLength,
      sha256: file.sha256,
    });
    sharedAccess.resolveSharedObject.mockResolvedValue({
      ownerPrincipalId: ownerId,
      resourceId,
      versionId,
      storageRef: foreignKey,
      file,
    });

    const response = await app.inject({
      url: `/bff/v1/resources/shared-with-me/${ownerId}/${resourceId}/content`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private/v1/tenants');
  });
});
