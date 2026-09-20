import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { ResourceNotFoundError } from '@workout/server-persistence/resources';

import { ProductRequestError } from '../src/product-boundary.js';
import {
  registerResourceUrlRoutes,
  type ResourceUrlIngestionRouteRecord,
  type ResourceUrlIngestionRouteRepository,
} from '../src/resource-url-routes.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ingestionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const createdAt = '2026-09-20T01:00:00.000Z';
const displayUrl = 'https://example.com/article';
const idempotencyKey = 'resource-url-command-0001';
const createBody = {
  sourceKind: 'url' as const,
  title: 'Training article',
  category: 'guide' as const,
  metadata: { language: 'en' },
  tags: ['training'],
  favorite: false,
  url: 'https://example.com/article?private=secret',
};

function row(
  state: ResourceUrlIngestionRouteRecord['state'] = 'queued',
): ResourceUrlIngestionRouteRecord {
  return {
    requestId: ingestionId,
    operation: 'create',
    resourceId,
    versionId,
    state,
    displayUrl,
    failureCode: state === 'failed' ? 'DNS_ADDRESS_REJECTED' : null,
    failurePhase: state === 'failed' ? 'fetch' : null,
    retryable: state === 'failed',
    failedAt: state === 'failed' ? createdAt : null,
    retryAt: state === 'failed' ? '2026-09-20T01:01:00.000Z' : null,
    attemptCount: state === 'queued' ? 0 : 2,
    createdAt,
    updatedAt: createdAt,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

function setup(owner = athleteId) {
  const repository: ResourceUrlIngestionRouteRepository = {
    reserveCreate: vi.fn().mockResolvedValue(row()),
    reserveAppend: vi.fn().mockResolvedValue({ ...row(), operation: 'append' }),
    get: vi.fn().mockResolvedValue(row()),
    cancel: vi.fn().mockResolvedValue(true),
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductRequestError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code }, requestId: request.id });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' }, requestId: request.id });
  });
  registerResourceUrlRoutes(app, repository, () => ({
    athleteId: owner,
    sessionId: 'session',
    method: 'cookie',
    csrfToken: 'csrf',
  }));
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('private URL ingestion API boundaries', () => {
  it('derives tenant ownership and passes header-only idempotency for create and append', async () => {
    const { app, repository } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/resources/url-ingestions',
      headers: { 'idempotency-key': idempotencyKey },
      payload: createBody,
    });
    expect(created.statusCode).toBe(200);
    expect(repository.reserveCreate).toHaveBeenCalledWith(athleteId, createBody, idempotencyKey);
    expect(created.json()).toEqual({
      schemaVersion: 1,
      ingestionId,
      operation: 'create',
      resourceId,
      versionId,
      lifecycle: {
        contentStatus: 'queued',
        displayUrl,
        attempt: 0,
        retryAt: null,
        indexStatus: 'not_indexed',
      },
      createdAt,
      updatedAt: createdAt,
    });
    expect(created.body).not.toContain('private=secret');

    const append = { expectedCurrentVersionId: versionId, url: createBody.url };
    const appended = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId.toUpperCase()}/url-ingestions`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: append,
    });
    expect(appended.statusCode).toBe(200);
    expect(repository.reserveAppend).toHaveBeenCalledWith(
      athleteId,
      resourceId,
      append,
      idempotencyKey,
    );
    expect(appended.json().operation).toBe('append');
  });

  it('rejects an invalid or body-supplied URL command before repository access', async () => {
    const { app, repository } = setup();
    const invalidUrl = 'http://user:password@internal.example/private#secret';
    const invalid = await app.inject({
      method: 'POST',
      url: '/resources/url-ingestions',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...createBody, url: invalidUrl },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: { code: 'INVALID_RESOURCE_URL_INGESTION' },
    });
    expect(invalid.body).not.toContain(invalidUrl);
    expect(repository.reserveCreate).not.toHaveBeenCalled();

    const bodyKey = await app.inject({
      method: 'POST',
      url: '/resources/url-ingestions',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...createBody, idempotencyKey: 'forged-body-key' },
    });
    expect(bodyKey.statusCode).toBe(422);
    expect(repository.reserveCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', null],
    ['fetching', null],
    ['parsing', null],
    ['finalized', null],
    ['bookmark_only', null],
    ['cancelled', null],
    [
      'failed',
      {
        stage: 'fetch',
        code: 'blocked_address',
        retryable: true,
        failedAt: createdAt,
      },
    ],
  ] as const)('maps the %s persistence state to a strict public record', async (state, failure) => {
    const { app, repository } = setup();
    const internal = {
      ...row(state),
      requestedUrl: createBody.url,
      rawStorageRef: 'private/v1/secret/raw',
      leaseToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    vi.mocked(repository.get).mockResolvedValue(internal);
    const response = await app.inject({
      url: `/resources/url-ingestions/${ingestionId.toUpperCase()}`,
    });
    expect(response.statusCode).toBe(200);
    expect(repository.get).toHaveBeenCalledWith(athleteId, ingestionId);
    expect(response.json().lifecycle).toEqual({
      contentStatus: state,
      displayUrl,
      attempt: state === 'queued' ? 0 : 2,
      retryAt: state === 'failed' ? '2026-09-20T01:01:00.000Z' : null,
      indexStatus: 'not_indexed',
      ...(failure === null ? {} : { failure }),
    });
    expect(response.body).not.toContain('requestedUrl');
    expect(response.body).not.toContain('rawStorageRef');
    expect(response.body).not.toContain('leaseToken');
    expect(response.body).not.toContain('private=secret');
  });

  it('maps parser failures to closed public codes and never exposes an internal code', async () => {
    const { app, repository } = setup();
    vi.mocked(repository.get).mockResolvedValue({
      ...row('failed'),
      failurePhase: 'parse',
      failureCode: 'PARSER_INVALID_UTF8',
      retryable: false,
    });
    const response = await app.inject({ url: `/resources/url-ingestions/${ingestionId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().lifecycle.failure).toEqual({
      stage: 'parse',
      code: 'malformed',
      retryable: false,
      failedAt: createdAt,
    });
    expect(response.body).not.toContain('PARSER_INVALID_UTF8');
  });

  it('hides cross-tenant ingestion existence and returns the cancelled public state', async () => {
    const { app, repository } = setup('authenticated-owner');
    vi.mocked(repository.get).mockRejectedValueOnce(new ResourceNotFoundError());
    const missing = await app.inject({ url: `/resources/url-ingestions/${ingestionId}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'RESOURCE_URL_INGESTION_NOT_FOUND' },
    });
    expect(repository.get).toHaveBeenCalledWith('authenticated-owner', ingestionId);

    vi.mocked(repository.cancel).mockResolvedValueOnce(false);
    const missingCancel = await app.inject({
      method: 'DELETE',
      url: `/resources/url-ingestions/${ingestionId}`,
    });
    expect(missingCancel.statusCode).toBe(404);
    expect(missingCancel.json()).toMatchObject({
      error: { code: 'RESOURCE_URL_INGESTION_NOT_FOUND' },
    });

    vi.mocked(repository.get).mockResolvedValueOnce(row('cancelled'));
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/resources/url-ingestions/${ingestionId}`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().lifecycle.contentStatus).toBe('cancelled');
    expect(repository.cancel).toHaveBeenCalledWith('authenticated-owner', ingestionId);
    expect(repository.get).toHaveBeenLastCalledWith('authenticated-owner', ingestionId);
  });

  it('returns stable conflict codes without exposing the submitted URL', async () => {
    const { app, repository } = setup();
    vi.mocked(repository.reserveCreate).mockRejectedValueOnce(
      new PersistenceConflict('IDEMPOTENCY_CONFLICT'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/resources/url-ingestions',
      headers: { 'idempotency-key': idempotencyKey },
      payload: createBody,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(response.body).not.toContain(createBody.url);
  });
});
