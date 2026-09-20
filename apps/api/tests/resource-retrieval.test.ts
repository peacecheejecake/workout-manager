import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceAccessError } from '@workout/server-persistence/resource-access';
import { createApi } from '../src/app.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const passageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const groundingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const citationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const digest = 'a'.repeat(64);

const result = {
  schemaVersion: 1 as const,
  scope: 'resource-retrieval-v1' as const,
  query: '회복',
  checkedAt: '2026-09-20T00:00:00Z',
  authorizationDigest: digest,
  cache: 'miss' as const,
  authorizedResourceCount: 1,
  excerpts: [
    {
      resourceId,
      versionId,
      passageId,
      accessRevision: 3,
      ordinal: 0,
      title: '회복 주간 지침',
      headingPath: [],
      startOffset: 0,
      endOffset: 12,
      text: '회복 주간에는 강도를 낮춘다.',
    },
  ],
};

const grounding = {
  status: 'available' as const,
  schemaVersion: 1 as const,
  scope: 'resource-grounding-v1' as const,
  groundingId,
  runId,
  query: '회복',
  capturedAt: '2026-09-20T00:00:00Z',
  pinnedResourceCount: 1,
  excerpts: [],
  withdrawnExcerptCount: 1,
  citations: [
    {
      status: 'unavailable' as const,
      citationId,
      claimIndex: 0,
      reason: 'not_authorized' as const,
    },
  ],
};

const headers = {
  'x-workout-session-id': 'current',
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
};
const instances: ReturnType<typeof createApi>[] = [];

function setup(authenticated = true) {
  const repository = {
    retrieve: vi.fn().mockResolvedValue(result),
    readGrounding: vi.fn().mockResolvedValue(grounding),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: 'owner',
              sessionId: 'current',
              csrfToken: 'c'.repeat(43),
              method: 'cookie' as const,
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    resourceRetrieval: repository,
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

describe('resource retrieval API boundary', () => {
  it('derives the tenant from authentication and never from the request body', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/retrieval/queries',
      headers,
      payload: { schemaVersion: 1, query: '회복', limit: 4 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(repository.retrieve).toHaveBeenCalledWith('owner', {
      schemaVersion: 1,
      query: '회복',
      limit: 4,
    });
    // An athlete identifier in the body is rejected outright, not honoured.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bff/v1/retrieval/queries',
          headers,
          payload: { schemaVersion: 1, query: '회복', athleteId: 'someone-else' },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.retrieve).toHaveBeenCalledTimes(1);
  });

  it('rejects unbounded or malformed queries before reaching retrieval', async () => {
    const { app, repository } = setup();
    for (const payload of [
      { schemaVersion: 1, query: '' },
      { schemaVersion: 1, query: 'x'.repeat(501) },
      { schemaVersion: 1, query: '회복', limit: 0 },
      { schemaVersion: 1, query: '회복', limit: 99 },
      { schemaVersion: 2, query: '회복' },
      { query: '회복' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/bff/v1/retrieval/queries',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(repository.retrieve).not.toHaveBeenCalled();
  });

  it('returns the stored grounding with withdrawn citations marked unavailable', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      url: `/bff/v1/coaching-runs/${runId}/grounding`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(grounding);
    // A withdrawn citation carries no quote and no resource identity.
    expect(JSON.stringify(response.json())).not.toContain(resourceId);
    expect(repository.readGrounding).toHaveBeenCalledWith('owner', runId);
    expect(
      (await app.inject({ url: '/bff/v1/coaching-runs/not-a-uuid/grounding', headers })).statusCode,
    ).toBe(400);
  });

  it('refuses unauthenticated retrieval and normalizes access errors', async () => {
    const anonymous = setup(false);
    expect(
      (
        await anonymous.app.inject({
          method: 'POST',
          url: '/bff/v1/retrieval/queries',
          headers,
          payload: { schemaVersion: 1, query: '회복' },
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.repository.retrieve).not.toHaveBeenCalled();

    const { app, repository } = setup();
    repository.retrieve.mockRejectedValueOnce(
      new ResourceAccessError('COACH_USE_MANIFEST_TOO_LARGE'),
    );
    const conflict = await app.inject({
      method: 'POST',
      url: '/bff/v1/retrieval/queries',
      headers,
      payload: { schemaVersion: 1, query: '회복' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'COACH_USE_MANIFEST_TOO_LARGE' },
    });
  });
});
