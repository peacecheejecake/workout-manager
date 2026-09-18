import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrainingCandidateError } from '@workout/server-persistence/coaching-candidates';
import { createApi } from '../src/app.js';

const candidateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const headers = {
  'x-workout-session-id': 'current',
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'idempotency-key': 'partial-request-1',
};
const partialUrl = `/bff/v1/coaching-candidates/${candidateId}/partials`;
const statusUrl = `/bff/v1/coaching-candidates/${candidateId}/status`;
const selection = {
  schemaVersion: 1,
  sessionIds: ['session'],
  periodIds: [],
  includeTitle: false,
};
const instances: ReturnType<typeof createApi>[] = [];

function partialBundle() {
  const at = '2026-09-18T00:00:00Z';
  const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const planVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const childCandidateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const proposalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const decisionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const strategy = {
    summary: 'Synthetic partial',
    preservedIntent: 'Preserve original plan intent',
    rationale: 'Fixture-only selection',
    unconfirmedInformation: [],
    revisitWhen: 'Before approval',
  };
  const basis = {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: 'owner',
    evidenceSnapshotId: '11111111-1111-4111-8111-111111111111',
    threadId: '22222222-2222-4222-8222-222222222222',
    conversationRevision: 1,
    planVersionId,
    dependencies: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: 'owner',
      capturedAt: at,
      trainingPlan: { kind: 'exists', versionId: planVersionId },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
      aiConsent: { kind: 'exists', revision: 1, granted: true },
    },
    policy: { id: 'synthetic-policy', version: '1' },
    retrieval: { kind: 'none' },
  };
  const session = {
    id: 'session',
    blockId: 'block',
    date: '2026-09-19',
    localStartTime: null,
    title: 'Synthetic run',
    sport: 'running',
    durationSeconds: 3600,
    distanceMeters: 0,
    targetRpe: null,
    purpose: '',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [],
  };
  const changedSession = { ...session, durationSeconds: 3900 };
  const plan = {
    title: 'Synthetic plan',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2026-09-18',
      endDateExclusive: '2026-09-20',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [session],
  };
  const proposed = { ...plan, sessions: [changedSession] };
  const metric = (unit: 's' | 'm') => ({
    before: { unit, knownMin: 0, knownMax: 0, unknownSessionIds: [] },
    after: { unit, knownMin: 0, knownMax: 0, unknownSessionIds: [] },
    delta: { unit, min: 0, max: 0 },
  });
  return {
    decision: {
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      id: decisionId,
      runId,
      basis,
      strategy,
      createdAt: at,
    },
    proposal: {
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      id: proposalId,
      runId,
      decisionId,
      candidateIds: [childCandidateId],
      createdAt: at,
    },
    candidate: {
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      id: childCandidateId,
      proposalId,
      decisionId,
      runId,
      parentCandidateId: candidateId,
      createdAt: at,
      digest: 'a'.repeat(64),
      basis,
      before: { id: planVersionId, version: 1, createdAt: at, draft: plan },
      proposed,
      asOfLocalDate: '2026-09-18',
      strategy,
      diff: {
        definitionVersion: 'training-candidate-diff-v1',
        title: null,
        periodChanges: [],
        sessionChanges: [
          { id: 'session', kind: 'modified', before: session, after: changedSession },
        ],
        duration: {
          before: { unit: 's', knownMin: 3600, knownMax: 3600, unknownSessionIds: [] },
          after: { unit: 's', knownMin: 3900, knownMax: 3900, unknownSessionIds: [] },
          delta: { unit: 's', min: 300, max: 300 },
        },
        distance: metric('m'),
      },
      validation: {
        definitionVersion: 'training-candidate-validation-v1',
        status: 'checked',
        errors: [],
        warnings: [],
        unknowns: [],
      },
    },
  };
}

function setup(authenticated = true) {
  const repository = {
    create: vi.fn(),
    createFromFixture: vi.fn(),
    read: vi.fn(),
    list: vi.fn(),
    derivePartial: vi.fn().mockRejectedValue(new TrainingCandidateError('CANDIDATE_UNAVAILABLE')),
    status: vi.fn().mockResolvedValue({ schemaVersion: 1, candidateId, kind: 'stale' }),
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
              method: 'cookie',
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    coachingCandidates: repository,
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

describe('coaching candidate partial and status API boundary', () => {
  it('returns the server-produced partial bundle after strict body validation', async () => {
    const { app, repository } = setup();
    const result = partialBundle();
    repository.derivePartial.mockResolvedValueOnce(result);
    const response = await app.inject({
      method: 'POST',
      url: partialUrl,
      headers,
      payload: selection,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
  });

  it('derives owner and idempotency from authentication/header, never from the body', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: partialUrl,
      headers,
      payload: selection,
    });
    expect(response.statusCode).toBe(404);
    expect(repository.derivePartial).toHaveBeenCalledWith('owner', candidateId, {
      sessionIds: ['session'],
      periodIds: [],
      includeTitle: false,
      idempotencyKey: headers['idempotency-key'],
    });
  });

  it('maps a semantic selection conflict without exposing a candidate body', async () => {
    const { app, repository } = setup();
    repository.derivePartial.mockRejectedValueOnce(
      new TrainingCandidateError('INVALID_PARTIAL_SELECTION'),
    );
    const response = await app.inject({
      method: 'POST',
      url: partialUrl,
      headers,
      payload: selection,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_PARTIAL_SELECTION' } });
    repository.derivePartial.mockRejectedValueOnce(
      new TrainingCandidateError('CANDIDATE_LIMIT_REACHED'),
    );
    const full = await app.inject({
      method: 'POST',
      url: partialUrl,
      headers,
      payload: selection,
    });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: { code: 'CANDIDATE_LIMIT_REACHED' } });
  });

  it('rejects extra plan fields, duplicate/empty selection, malformed IDs and missing header', async () => {
    const { app, repository } = setup();
    for (const payload of [
      { ...selection, schemaVersion: 2 },
      { ...selection, sessionIds: [] },
      { ...selection, sessionIds: ['session', 'session'] },
      { ...selection, periodIds: ['block', 'block'] },
      { ...selection, sessionIds: [' bad '] },
      { ...selection, includeTitle: 'true' },
      { ...selection, idempotencyKey: 'body-controlled' },
      { ...selection, proposed: { sessions: [] } },
      { ...selection, athleteId: 'foreign' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: partialUrl, headers, payload })).statusCode,
      ).toBe(400);
    const { 'idempotency-key': _key, ...withoutKey } = headers;
    expect(_key).toBe(headers['idempotency-key']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: partialUrl,
          headers: withoutKey,
          payload: selection,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: partialUrl,
          headers: { ...headers, 'idempotency-key': ' bad ' },
          payload: selection,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: partialUrl, headers, payload: {} })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'POST', url: partialUrl, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `${statusUrl}?extra=1`, headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: '/bff/v1/coaching-candidates/wrong/status', headers })).statusCode,
    ).toBe(400);
    expect(repository.derivePartial).not.toHaveBeenCalled();
    expect(repository.status).not.toHaveBeenCalled();
  });

  it('returns only metadata for stale/withdrawn status and 404 for missing or foreign candidates', async () => {
    const { app, repository } = setup();
    const stale = await app.inject({ url: statusUrl, headers });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ schemaVersion: 1, candidateId, kind: 'stale' });
    expect(repository.status).toHaveBeenCalledWith('owner', candidateId);
    repository.status.mockResolvedValueOnce({ schemaVersion: 1, candidateId, kind: 'withdrawn' });
    expect((await app.inject({ url: statusUrl, headers })).json()).toEqual({
      schemaVersion: 1,
      candidateId,
      kind: 'withdrawn',
    });
    repository.status.mockResolvedValueOnce(null);
    const unavailable = await app.inject({ url: statusUrl, headers });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ error: { code: 'CANDIDATE_UNAVAILABLE' } });
  });

  it('requires current session and CSRF for partial writes', async () => {
    const anonymous = setup(false);
    expect((await anonymous.app.inject({ url: statusUrl, headers })).statusCode).toBe(401);
    expect(
      (await anonymous.app.inject({ method: 'POST', url: partialUrl, headers, payload: selection }))
        .statusCode,
    ).toBe(401);
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: partialUrl,
          headers: { ...headers, 'x-csrf-token': 'bad' },
          payload: selection,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: statusUrl,
          headers: { ...headers, 'x-workout-session-id': 'previous' },
        })
      ).statusCode,
    ).toBe(409);
    expect(repository.derivePartial).not.toHaveBeenCalled();
    expect(repository.status).not.toHaveBeenCalled();
  });
});
