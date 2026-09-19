import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceNotFoundError,
  ResourceValidationError,
} from '@workout/server-persistence/resources';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { createApi } from '../src/app.js';

const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const createdAt = '2026-09-19T00:00:00.000Z';
const text = 'First paragraph.\n\nSecond paragraph.';
const lifecycle = { contentStatus: 'parsed' as const, indexStatus: 'not_indexed' as const };
const paragraphs = [
  {
    locator: {
      kind: 'paragraph' as const,
      resourceVersionId: versionId,
      index: 0,
      startOffset: 0,
      endOffset: 16,
      offsetUnit: 'utf16_code_unit' as const,
    },
    text: 'First paragraph.',
  },
  {
    locator: {
      kind: 'paragraph' as const,
      resourceVersionId: versionId,
      index: 1,
      startOffset: 18,
      endOffset: 35,
      offsetUnit: 'utf16_code_unit' as const,
    },
    text: 'Second paragraph.',
  },
];
const resource = {
  schemaVersion: 1 as const,
  id: resourceId,
  sourceKind: 'text' as const,
  title: 'Synthetic guide',
  category: 'guide' as const,
  metadata: { author: 'Test author', year: 2026, language: 'en' },
  tags: ['synthetic'],
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
};
const version = {
  schemaVersion: 1 as const,
  id: versionId,
  resourceId,
  version: 1,
  previousVersionId: null,
  contentHash: 'a'.repeat(64),
  source: { kind: 'text' as const, text },
  paragraphs,
  lifecycle,
  createdAt,
};
const available = {
  status: 'available' as const,
  resource,
  version,
  reader: {
    resourceId,
    resourceVersionId: versionId,
    title: resource.title,
    sourceKind: 'text' as const,
    lifecycle,
    originalText: text,
    paragraphs,
  },
};
const create = {
  sourceKind: 'text' as const,
  title: resource.title,
  category: resource.category,
  metadata: resource.metadata,
  tags: resource.tags,
  favorite: false,
  text,
};
const append = { expectedCurrentVersionId: versionId, text: 'Replacement content.' };
const remove = { expectedAccessRevision: 1, expectedCurrentVersionId: versionId };
const deleted = {
  status: 'deleted' as const,
  resourceId,
  deletedAt: '2026-09-19T01:00:00.000Z',
  accessRevision: 2,
};
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'resource-command-0001',
};
const collection = '/bff/v1/resources';
const detail = `${collection}/${resourceId}`;
const instances: ReturnType<typeof createApi>[] = [];

function setup(authenticated = true) {
  const repository = {
    create: vi.fn().mockResolvedValue(available),
    appendVersion: vi.fn().mockResolvedValue(available),
    list: vi.fn().mockResolvedValue({ items: [resource], total: 1 }),
    read: vi.fn().mockResolvedValue(available),
    softDelete: vi.fn().mockResolvedValue(deleted),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'authenticated-owner',
              sessionId: 'current',
              csrfToken: headers['x-csrf-token'],
              method: 'cookie' as const,
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    resources: repository,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, repository };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('private text resource API boundaries', () => {
  it('derives ownership and supplies header-only idempotency to all commands', async () => {
    const { app, repository } = setup();
    expect((await app.inject({ url: collection, headers })).statusCode).toBe(200);
    expect(repository.list).toHaveBeenCalledWith('authenticated-owner', {
      limit: 50,
      offset: 0,
    });
    expect(
      (
        await app.inject({
          url: `${collection}?category=guide&favorite=false&limit=10&offset=1`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.list).toHaveBeenLastCalledWith('authenticated-owner', {
      category: 'guide',
      favorite: false,
      limit: 10,
      offset: 1,
    });

    expect(
      (await app.inject({ method: 'POST', url: collection, headers, payload: create })).statusCode,
    ).toBe(200);
    expect(repository.create).toHaveBeenCalledWith('authenticated-owner', {
      ...create,
      idempotencyKey: headers['idempotency-key'],
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${detail}/versions`,
          headers,
          payload: append,
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.appendVersion).toHaveBeenCalledWith('authenticated-owner', resourceId, {
      ...append,
      idempotencyKey: headers['idempotency-key'],
    });

    expect(
      (await app.inject({ method: 'DELETE', url: detail, headers, payload: remove })).json(),
    ).toEqual(deleted);
    expect(repository.softDelete).toHaveBeenCalledWith('authenticated-owner', resourceId, {
      ...remove,
      idempotencyKey: headers['idempotency-key'],
    });
  });

  it('normalizes IDs and forwards an exact historical version query', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      url: `${collection}/${resourceId.toUpperCase()}?versionId=${versionId.toUpperCase()}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(available);
    expect(repository.read).toHaveBeenCalledWith('authenticated-owner', resourceId, {
      versionId,
    });
    const mismatched = await app.inject({
      url: `${detail}?versionId=${nextVersionId}`,
      headers,
    });
    expect(mismatched.statusCode).toBe(500);
    expect(mismatched.body).not.toContain(text);
  });

  it('rejects forged ownership, embedded keys and unknown path/query/body fields', async () => {
    const { app, repository } = setup();
    for (const url of [
      `${collection}?athleteId=foreign`,
      `${collection}?limit=1&limit=2`,
      `${collection}?query=unsafe%00query`,
      `${detail}?versionId=${versionId}&owner=foreign`,
      `${collection}/not-a-uuid`,
    ])
      expect((await app.inject({ url, headers })).statusCode).toBe(400);

    for (const request of [
      { method: 'POST' as const, url: collection, payload: { ...create, athleteId: 'foreign' } },
      {
        method: 'POST' as const,
        url: collection,
        payload: { ...create, idempotencyKey: 'body-key-forbidden' },
      },
      {
        method: 'POST' as const,
        url: `${detail}/versions`,
        payload: { ...append, resourceId },
      },
      {
        method: 'DELETE' as const,
        url: detail,
        payload: { ...remove, includeForCoach: true },
      },
    ])
      expect((await app.inject({ ...request, headers })).statusCode).toBe(400);

    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it('returns the same 404 boundary for missing, foreign and missing-version reads', async () => {
    const { app, repository } = setup();
    repository.read.mockResolvedValue({ status: 'unavailable' });
    for (const url of [detail, `${detail}?versionId=${nextVersionId}`]) {
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
      expect(response.body).not.toContain('foreign');
    }
  });

  it('requires authentication, current session and cookie CSRF before repository access', async () => {
    const anonymous = setup(false);
    expect((await anonymous.app.inject({ url: collection, headers })).statusCode).toBe(401);
    expect(
      (
        await anonymous.app.inject({
          method: 'POST',
          url: collection,
          headers,
          payload: create,
        })
      ).statusCode,
    ).toBe(401);
    for (const method of Object.values(anonymous.repository)) expect(method).not.toHaveBeenCalled();

    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers: { ...headers, 'x-workout-session-id': 'old' },
          payload: create,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: detail,
          headers: { ...headers, 'x-csrf-token': 'bad' },
          payload: remove,
        })
      ).statusCode,
    ).toBe(403);
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it('requires valid command headers, empty command queries and bounded request bodies', async () => {
    const { app, repository } = setup();
    const payloadBytes = 65_536 - 999 * 2;
    const escapeHeavyText = Array.from({ length: 1000 }, (_, index) => {
      const length = Math.floor(payloadBytes / 1000) + (index < payloadBytes % 1000 ? 1 : 0);
      return `A${'\\"\t'.repeat(length).slice(0, length - 1)}`;
    }).join('\n\n');
    expect(Buffer.byteLength(escapeHeavyText, 'utf8')).toBe(65_536);
    expect(
      Buffer.byteLength(JSON.stringify({ ...create, text: escapeHeavyText }), 'utf8'),
    ).toBeGreaterThan(96 * 1024);
    const { 'idempotency-key': ignored, ...withoutKey } = headers;
    expect(ignored).toBe('resource-command-0001');
    for (const commandHeaders of [withoutKey, { ...headers, 'idempotency-key': ' short ' }])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: collection,
            headers: commandHeaders,
            payload: create,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${detail}/versions?versionId=${versionId}`,
          headers,
          payload: append,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers,
          payload: { ...create, text: 'x'.repeat(64 * 1024) },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers,
          payload: { ...create, text: escapeHeavyText },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${detail}/versions`,
          headers,
          payload: { ...append, text: escapeHeavyText },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: collection,
          headers,
          payload: { ...create, text: 'x'.repeat(200 * 1024) },
        })
      ).statusCode,
    ).toBe(413);
    const unsafeStatuses = await Promise.all(
      [
        { ...create, title: `unsafe${String.fromCharCode(0)}title` },
        { ...create, tags: [`unsafe${String.fromCharCode(1)}tag`] },
      ].map(
        async (payload) =>
          (
            await app.inject({
              method: 'POST',
              url: collection,
              headers,
              payload,
            })
          ).statusCode,
      ),
    );
    expect(unsafeStatuses).toEqual([400, 400]);
    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(repository.appendVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new ResourceNotFoundError(), 404, 'RESOURCE_NOT_FOUND'],
    [new PersistenceConflict('REVISION_CONFLICT'), 409, 'REVISION_CONFLICT'],
    [new PersistenceConflict('IDEMPOTENCY_CONFLICT'), 409, 'IDEMPOTENCY_CONFLICT'],
    [new ResourceValidationError('PARAGRAPH_TOO_LARGE'), 422, 'PARAGRAPH_TOO_LARGE'],
    [new ResourceValidationError('TOO_MANY_PARAGRAPHS'), 422, 'TOO_MANY_PARAGRAPHS'],
  ] as const)('maps repository errors without leaking details: %s', async (error, status, code) => {
    const { app, repository } = setup();
    repository.appendVersion.mockRejectedValue(error);
    const response = await app.inject({
      method: 'POST',
      url: `${detail}/versions`,
      headers,
      payload: append,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it('fails closed when a repository response violates the public schema', async () => {
    const { app, repository } = setup();
    repository.list.mockResolvedValue({
      items: [{ ...resource, includeForCoach: true }],
      total: 1,
    });
    const response = await app.inject({ url: collection, headers });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(resource.title);
  });
});
