import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import {
  ResourceAccessError,
  type ResourceAccessRepository,
} from '@workout/server-persistence/resource-access';
import { ResourceNotFoundError } from '@workout/server-persistence/resources';

import { ProductRequestError } from '../src/product-boundary.js';
import { registerResourceAccessRoutes } from '../src/resource-access-routes.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const coachId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const shareId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const at = '2026-09-20T01:00:00.000Z';
const idempotencyKey = 'resource-access-command-01';

const accessState = {
  schemaVersion: 1 as const,
  resourceId,
  accessRevision: 3,
  currentVersionId: versionId,
  reviewedState: 'reviewed' as const,
  reviewedAt: at,
  includeForCoach: false,
  coachUseEnabledAt: null,
  aiConsentGranted: true,
  coachUseAuthorized: false,
  pendingCleanup: false,
  revokedShares: [],
  revokedShareHistoryTruncated: false,
  shares: [
    {
      schemaVersion: 1 as const,
      shareId,
      resourceId,
      granteeKind: 'coach' as const,
      granteePrincipalId: coachId,
      state: 'active' as const,
      grantedAccessRevision: 2,
      revokedAccessRevision: null,
      grantedAt: at,
      revokedAt: null,
    },
  ],
};

const apps: ReturnType<typeof Fastify>[] = [];

function setup(owner = athleteId, overrides: Partial<ResourceAccessRepository> = {}) {
  const repository: ResourceAccessRepository = {
    readAccess: vi.fn().mockResolvedValue(accessState),
    grantShare: vi.fn().mockResolvedValue(accessState),
    revokeShare: vi.fn().mockResolvedValue(accessState),
    setReviewed: vi.fn().mockResolvedValue(accessState),
    setCoachUse: vi.fn().mockResolvedValue(accessState),
    listSharedWithMe: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
    resolveSharedObject: vi.fn().mockResolvedValue(null),
    readSharedWithMe: vi.fn().mockResolvedValue({ status: 'unavailable' }),
    captureCoachUseManifest: vi.fn(),
    revalidateCoachUseManifest: vi.fn(),
    ...overrides,
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
  registerResourceAccessRoutes(app, repository, () => ({
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

describe('private resource access API boundaries', () => {
  it('derives ownership from authentication and takes idempotency only from the header', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/shares`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        granteeKind: 'coach',
        granteePrincipalId: coachId,
        expectedAccessRevision: 2,
        athleteId: 'attacker',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.grantShare).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/shares`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: { granteeKind: 'coach', granteePrincipalId: coachId, expectedAccessRevision: 2 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(repository.grantShare).toHaveBeenCalledWith(athleteId, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coachId,
      expectedAccessRevision: 2,
      idempotencyKey,
    });
  });

  it('rejects an access command without a header idempotency key', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/reviewed`,
      payload: { reviewed: true, expectedAccessRevision: 2, expectedCurrentVersionId: versionId },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.setReviewed).not.toHaveBeenCalled();
  });

  it('keeps review and coach use on separate endpoints', async () => {
    const { app, repository } = setup();
    await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/reviewed`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: { reviewed: true, expectedAccessRevision: 2, expectedCurrentVersionId: versionId },
    });
    expect(repository.setReviewed).toHaveBeenCalledTimes(1);
    expect(repository.setCoachUse).not.toHaveBeenCalled();

    await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/coach-use`,
      headers: { 'idempotency-key': `${idempotencyKey}-b` },
      payload: {
        includeForCoach: true,
        expectedAccessRevision: 3,
        expectedCurrentVersionId: versionId,
      },
    });
    expect(repository.setCoachUse).toHaveBeenCalledTimes(1);
    expect(repository.setReviewed).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown field that would smuggle a second transition', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/reviewed`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        reviewed: true,
        includeForCoach: true,
        expectedAccessRevision: 2,
        expectedCurrentVersionId: versionId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.setReviewed).not.toHaveBeenCalled();
  });

  it('maps precondition, conflict and missing resource failures to sanitized codes', async () => {
    const { app } = setup(athleteId, {
      setCoachUse: vi.fn().mockRejectedValue(new ResourceAccessError('COACH_USE_REVIEW_REQUIRED')),
      revokeShare: vi.fn().mockRejectedValue(new ResourceAccessError('SHARE_NOT_FOUND')),
      setReviewed: vi.fn().mockRejectedValue(new PersistenceConflict('REVISION_CONFLICT')),
      readAccess: vi.fn().mockRejectedValue(new ResourceNotFoundError()),
    });

    const coachUse = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/coach-use`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        includeForCoach: true,
        expectedAccessRevision: 2,
        expectedCurrentVersionId: versionId,
      },
    });
    expect(coachUse.statusCode).toBe(409);
    expect(coachUse.json()).toMatchObject({ error: { code: 'COACH_USE_REVIEW_REQUIRED' } });

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/resources/${resourceId}/shares/${shareId}`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: { expectedAccessRevision: 2 },
    });
    expect(revoked.statusCode).toBe(404);

    const reviewed = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/reviewed`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: { reviewed: true, expectedAccessRevision: 2, expectedCurrentVersionId: versionId },
    });
    expect(reviewed.statusCode).toBe(409);
    expect(reviewed.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });

    const read = await app.inject({ method: 'GET', url: `/resources/${resourceId}/access` });
    expect(read.statusCode).toBe(404);
  });

  it('never leaks an internal failure message to the client', async () => {
    const { app } = setup(athleteId, {
      readAccess: vi.fn().mockRejectedValue(new Error('select storage_ref from resource_version')),
    });
    const response = await app.inject({ method: 'GET', url: `/resources/${resourceId}/access` });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR' },
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain('storage_ref');
  });

  it('reads shared resources with the authenticated grantee, never a path identity', async () => {
    const { app, repository } = setup(coachId);
    await app.inject({ method: 'GET', url: '/resources/shared-with-me' });
    expect(repository.listSharedWithMe).toHaveBeenCalledWith(coachId, { limit: 50, offset: 0 });

    await app.inject({ method: 'GET', url: '/resources/shared-with-me?limit=10&offset=20' });
    expect(repository.listSharedWithMe).toHaveBeenLastCalledWith(coachId, {
      limit: 10,
      offset: 20,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/resources/shared-with-me/${athleteId}/${resourceId}`,
    });
    expect(repository.readSharedWithMe).toHaveBeenCalledWith(coachId, athleteId, resourceId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SHARED_RESOURCE_NOT_FOUND' } });
  });

  it('returns the access state without any storage reference', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: `/resources/${resourceId}/access` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(accessState);
    expect(response.body).not.toContain('storage');
  });
});
