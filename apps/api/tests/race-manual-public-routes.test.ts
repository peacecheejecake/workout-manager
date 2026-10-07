import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaceManualPublicRoutesRepository } from '../src/race-manual-public-routes.js';
import { AppConsentRequiredError } from '@workout/server-persistence/app-admission';
import { RaceManualPublicError } from '@workout/server-persistence/race-manual-public';
import { RacePlanImpactPreviewError } from '@workout/server-persistence/race-plan-impact-preview';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
// Actual product registration and createApi auth/CSRF; repository remains mocked.
import { createApi } from '../src/app.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const race = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const athlete = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = 'a'.repeat(64);
const reference = {
  schemaVersion: 1,
  candidateId: id,
  applicationDigest: hash,
  chain: {
    evidenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    decisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    proposalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    readonlyCandidateDigest: hash,
  },
  createdAt: '2026-10-08T00:00:00.123456Z',
};
const preview = {
  schemaVersion: 1,
  status: 'unavailable',
  reference,
  reason: 'review_body_purged',
  preview: null,
};
const committed = {
  schemaVersion: 1,
  status: 'committed',
  candidateId: id,
  approvalId: '11111111-1111-4111-8111-111111111111',
  proposalId: reference.chain.proposalId,
  approvedAt: '2026-10-08T00:00:00.123456Z',
  race: { eventId: race, revision: 2 },
  versions: [],
  occurrenceIds: [],
  notices: [],
};
const prepare = {
  schemaVersion: 1,
  intent: {
    expectedEvent: { id: race, revision: 1 },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
  },
};
const approve = { schemaVersion: 1, confirmed: true, applicationDigest: hash };
const headers = {
  cookie: 'synthetic-session',
  origin: 'https://workout.example',
  'x-csrf-token': 'c'.repeat(43),
  'x-workout-session-id': 'current',
  'idempotency-key': 'review_fixture_0001',
};
const reviewUrl = `/bff/v1/races/${race}/date-change-reviews`;
const readUrl = `/bff/v1/race-date-change-reviews/${id}`;
const approveUrl = `${readUrl}/approve`;
const apps: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true, enabled = true) {
  const repo: RaceManualPublicRoutesRepository = {
    review: vi
      .fn<RaceManualPublicRoutesRepository['review']>()
      .mockResolvedValue({ status: 'reviewed', reference, bodyState: 'present' }),
    approve: vi.fn<RaceManualPublicRoutesRepository['approve']>().mockResolvedValue(committed),
    readPreview: vi
      .fn<RaceManualPublicRoutesRepository['readPreview']>()
      .mockResolvedValue(preview),
  };
  const app = createApi({
    ...(enabled ? { raceManualPublic: repo } : {}),
    auth: {
      authenticate: async () =>
        authenticated
          ? {
              athleteId: athlete,
              sessionId: 'current',
              method: 'cookie',
              csrfToken: headers['x-csrf-token'],
            }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, repo };
}
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const requests = [
  { method: 'POST' as const, url: reviewUrl, payload: prepare },
  { method: 'GET' as const, url: readUrl },
  { method: 'POST' as const, url: approveUrl, payload: approve },
];
describe('manual public plugin with actual parent hooks and mocked repositories', () => {
  it('requires parent authentication for every route', async () => {
    const { app, repo } = setup(false);
    for (const req of requests)
      expect((await app.inject({ ...req, headers })).statusCode).toBe(401);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
  it('requires fresh private cookie session on all three routes', async () => {
    const { app, repo } = setup();
    for (const req of requests)
      expect(
        (await app.inject({ ...req, headers: { ...headers, 'x-workout-session-id': 'stale' } }))
          .statusCode,
      ).toBe(409);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
  it.each([{ origin: 'https://foreign.example' }, { 'x-csrf-token': '' }])(
    'uses parent cookie write CSRF/origin gates %j',
    async (override) => {
      const { app, repo } = setup();
      for (const req of [requests[0], requests[2]]) {
        if (!req) throw Error('Request required');
        expect(
          (await app.inject({ ...req, headers: { ...headers, ...override } })).statusCode,
        ).toBe(403);
      }
      expect(repo.review).not.toHaveBeenCalled();
      expect(repo.approve).not.toHaveBeenCalled();
    },
  );
  it('composes only trusted path/header identity and authenticated tenant', async () => {
    const { app, repo } = setup();
    const a = await app.inject({ ...requests[0], method: 'POST', url: reviewUrl, headers });
    expect(a.statusCode).toBe(201);
    expect(repo.review).toHaveBeenCalledWith(athlete, {
      ...prepare,
      intent: { ...prepare.intent, resolutions: { nutrition: [], routines: [] } },
      idempotencyKey: headers['idempotency-key'],
    });
    const b = await app.inject({ ...requests[2], method: 'POST', url: approveUrl, headers });
    expect(b.statusCode).toBe(200);
    expect(repo.approve).toHaveBeenCalledWith(athlete, {
      ...approve,
      candidateId: id,
      idempotencyKey: headers['idempotency-key'],
    });
  });
  it.each(['athleteId', 'expectedBasis', 'sourceContext', 'recipes', 'idempotencyKey'])(
    'rejects review client field %s even equal header key',
    async (field) => {
      const { app, repo } = setup();
      const res = await app.inject({
        method: 'POST',
        url: reviewUrl,
        headers,
        payload: { ...prepare, [field]: headers['idempotency-key'] },
      });
      expect(res.statusCode).toBe(400);
      expect(repo.review).not.toHaveBeenCalled();
    },
  );
  it.each(['candidateId', 'idempotencyKey', 'basis', 'chain', 'expectation'])(
    'rejects approval body field %s',
    async (field) => {
      const { app, repo } = setup();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: approveUrl,
            headers,
            payload: {
              ...approve,
              [field]: field === 'candidateId' ? id : headers['idempotency-key'],
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(repo.approve).not.toHaveBeenCalled();
    },
  );
  it('requires explicit confirmation and valid finite header key', async () => {
    const { app, repo } = setup();
    for (const payload of [
      { schemaVersion: 1, applicationDigest: hash },
      { ...approve, confirmed: false },
    ])
      expect(
        (await app.inject({ method: 'POST', url: approveUrl, headers, payload })).statusCode,
      ).toBe(400);
    for (const key of ['', 'x', 'x'.repeat(129), 'white space'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: reviewUrl,
            headers: { ...headers, 'idempotency-key': key },
            payload: prepare,
          })
        ).statusCode,
      ).toBe(400);
    expect(repo.review).not.toHaveBeenCalled();
    expect(repo.approve).not.toHaveBeenCalled();
  });
  it('denies expected event/path mismatch and write/read unknown query duplicates', async () => {
    const { app, repo } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reviewUrl,
          headers,
          payload: {
            ...prepare,
            intent: { ...prepare.intent, expectedEvent: { id, revision: 1 } },
          },
        })
      ).statusCode,
    ).toBe(400);
    for (const req of requests)
      expect(
        (await app.inject({ ...req, url: req.url + '?unexpected=1&unexpected=2', headers }))
          .statusCode,
      ).toBe(400);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
  it('returns frozen before and hypothetical after without a current permission claim', async () => {
    const { app, repo } = setup();
    const before = {
      title: 'Race',
      localDate: '2026-10-08',
      localStartTime: null,
      timezone: 'UTC',
      distance: { kind: 'standard', class: '5k' },
      priority: null,
      participation: 'registered',
      targetSeconds: 0,
    };
    const present = {
      schemaVersion: 1,
      status: 'present',
      reference,
      storedCandidateState: 'ready_for_explicit_approval',
      beforeBasis: 'frozen_review',
      afterBasis: 'hypothetical_on_approval',
      freshness: 'not_checked_on_read',
      scope: 'whole_affected',
      race: {
        eventId: race,
        expectedRevision: 1,
        before,
        after: { ...before, localDate: '2026-10-09' },
      },
      training: { state: 'absent' },
      nutrition: { state: 'absent' },
      recovery: { state: 'absent' },
      routines: { state: 'absent' },
      retainedUnplanned: [],
      affected: [],
      notices: [],
    };
    vi.mocked(repo.readPreview).mockResolvedValue(present);
    const res = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(present);
    expect(repo.review).not.toHaveBeenCalled();
    expect(repo.approve).not.toHaveBeenCalled();
  });
  it('reads purge as minimal reference without granting fresh processing permission', async () => {
    const { app, repo } = setup();
    const res = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(preview);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(repo.readPreview).toHaveBeenCalledWith(athlete, id);
    expect(repo.approve).not.toHaveBeenCalled();
  });
  it('missing or foreign retained preview is the same 404', async () => {
    const { app, repo } = setup();
    vi.mocked(repo.readPreview).mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: readUrl, headers })).statusCode).toBe(404);
  });
  it('returns original successful replay response without route-side versions or side effects', async () => {
    const { app, repo } = setup();
    for (let i = 0; i < 2; i++)
      expect(
        (await app.inject({ method: 'POST', url: approveUrl, headers, payload: approve })).json(),
      ).toEqual(committed);
    expect(repo.approve).toHaveBeenCalledTimes(2);
    expect(repo.review).not.toHaveBeenCalled();
  });
  it('retains exact finite blocked stages and never returns approval success', async () => {
    const { app, repo } = setup();
    vi.mocked(repo.review).mockResolvedValue({ status: 'blocked', stage: 'application' });
    const res = await app.inject({ method: 'POST', url: reviewUrl, headers, payload: prepare });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ status: 'blocked', stage: 'application' });
    vi.mocked(repo.approve).mockResolvedValue({
      schemaVersion: 1,
      status: 'blocked',
      candidateId: id,
      blockers: [{ reason: 'stale_basis', target: null }],
    });
    expect(
      (await app.inject({ method: 'POST', url: approveUrl, headers, payload: approve })).statusCode,
    ).toBe(409);
  });
  it.each([new AppConsentRequiredError(), new PersistenceConflict('IDEMPOTENCY_CONFLICT')])(
    'preserves shared product conflict taxonomy',
    async (error) => {
      const { app, repo } = setup();
      vi.mocked(repo.approve).mockRejectedValue(error);
      expect(
        (await app.inject({ method: 'POST', url: approveUrl, headers, payload: approve }))
          .statusCode,
      ).toBe(409);
    },
  );
  it.each([
    ['PUBLIC_REFERENCE_UNAVAILABLE', 404],
    ['PUBLIC_APPLICATION_UNAVAILABLE', 409],
    ['PUBLIC_PREVIEW_LIMIT', 413],
    ['PUBLIC_RESPONSE_LIMIT', 413],
    ['PUBLIC_PORT_UNAVAILABLE', 500],
  ])('maps only finite service error %s', async (code, status) => {
    const { app, repo } = setup();
    vi.mocked(repo.readPreview).mockRejectedValue(
      Object.assign(new Error('PRIVATE_DATABASE_MESSAGE'), { code }),
    );
    const res = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(res.statusCode).toBe(status);
    expect(res.body).not.toContain('PRIVATE_DATABASE_MESSAGE');
  });
  it('sanitizes unknown SQL errors and invalid outgoing extra/private fields', async () => {
    const { app, repo } = setup();
    vi.mocked(repo.readPreview).mockRejectedValue(
      Object.assign(new Error('credentials=PRIVATE'), { code: 'P0001' }),
    );
    const a = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(a.statusCode).toBe(500);
    expect(a.body).not.toContain('PRIVATE');
    vi.mocked(repo.readPreview).mockResolvedValue({ ...preview, basis: { private: 'raw' } });
    expect((await app.inject({ method: 'GET', url: readUrl, headers })).statusCode).toBe(500);
    vi.mocked(repo.review).mockResolvedValue({ status: 'blocked', stage: 'unknown' });
    expect(
      (await app.inject({ method: 'POST', url: reviewUrl, headers, payload: prepare })).statusCode,
    ).toBe(500);
  });
  it('rejects wrong outgoing candidate identity rather than exposing another record', async () => {
    const { app, repo } = setup();
    vi.mocked(repo.readPreview).mockResolvedValue({
      ...preview,
      reference: { ...reference, candidateId: race },
    });
    expect((await app.inject({ method: 'GET', url: readUrl, headers })).statusCode).toBe(500);
    vi.mocked(repo.approve).mockResolvedValue({ ...committed, candidateId: race });
    expect(
      (await app.inject({ method: 'POST', url: approveUrl, headers, payload: approve })).statusCode,
    ).toBe(500);
  });
  it('bounds HTTP body before repository transport and defaults absent plugin to 404', async () => {
    const { app, repo } = setup();
    const response = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...prepare, extra: 'x'.repeat(4194304) }),
    });
    expect(response.statusCode).toBe(413);
    expect(repo.review).not.toHaveBeenCalled();
    const disabled = setup(true, false);
    expect((await disabled.app.inject({ method: 'GET', url: readUrl, headers })).statusCode).toBe(
      404,
    );
    expect(disabled.repo.readPreview).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  'explicit protocol capability reports injection %s without calling writes',
  async (enabled) => {
    const { app, repo } = setup(true, enabled);
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/race-date-change-reviews/capabilities',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      dateChangeReviews: enabled,
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  },
);
it('capability requires authentication and rejects unknown query', async () => {
  const absent = setup(false);
  expect(
    (
      await absent.app.inject({
        method: 'GET',
        url: '/bff/v1/race-date-change-reviews/capabilities',
        headers,
      })
    ).statusCode,
  ).toBe(401);
  const present = setup();
  expect(
    (
      await present.app.inject({
        method: 'GET',
        url: '/bff/v1/race-date-change-reviews/capabilities?candidateId=' + id,
        headers,
      })
    ).statusCode,
  ).toBe(400);
  for (const fn of Object.values(present.repo)) expect(fn).not.toHaveBeenCalled();
});

const impactUrl = `/bff/v1/races/${race}/date-change-impact`;
const { 'idempotency-key': unusedImpactKey, ...impactHeaders } = headers;
void unusedImpactKey;
const raceBody = {
  title: '가을 대회',
  localDate: '2026-10-08',
  localStartTime: null,
  timezone: 'UTC',
  distance: { kind: 'standard', class: '5k' },
  priority: null,
  participation: 'registered',
  targetSeconds: 0,
};
function projectedImpact() {
  return {
    schemaVersion: 1,
    status: 'projected',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    expectedEvent: prepare.intent.expectedEvent,
    intent: { ...prepare.intent, resolutions: { nutrition: [], routines: [] } },
    beforeBasis: 'captured_snapshot',
    afterBasis: 'hypothetical',
    race: {
      eventId: race,
      expectedRevision: 1,
      before: raceBody,
      after: { ...raceBody, localDate: prepare.intent.newLocalDate },
    },
    training: { state: 'absent' },
    nutrition: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    retainedUnplanned: [],
    affected: [],
    resolutionRequirements: [],
    notices: [],
  };
}
it('projects transient impact for the authenticated owner with no storage or approval calls', async () => {
  const { app, repo } = setup();
  const impact = vi.fn().mockResolvedValue(projectedImpact());
  repo.impact = impact;
  const reply = await app.inject({
    method: 'POST',
    url: impactUrl.replace(race, race.toUpperCase()),
    headers: impactHeaders,
    payload: prepare,
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toEqual(projectedImpact());
  expect(reply.headers['cache-control']).toBe('private, no-store');
  expect(impact).toHaveBeenCalledExactlyOnceWith(athlete, {
    ...prepare,
    intent: { ...prepare.intent, resolutions: { nutrition: [], routines: [] } },
  });
  expect(repo.review).not.toHaveBeenCalled();
  expect(repo.approve).not.toHaveBeenCalled();
  expect(repo.readPreview).not.toHaveBeenCalled();
});
it('preserves blocked impact diagnostics without turning them into approval or stored review', async () => {
  const { app, repo } = setup();
  const blocked = {
    schemaVersion: 1,
    status: 'blocked',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    reason: 'unsupported_source',
    domains: ['nutrition'],
  };
  repo.impact = vi.fn().mockResolvedValue(blocked);
  const reply = await app.inject({
    method: 'POST',
    url: impactUrl,
    headers: impactHeaders,
    payload: prepare,
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toEqual(blocked);
  expect(repo.review).not.toHaveBeenCalled();
  expect(repo.approve).not.toHaveBeenCalled();
});
it('requires authentication and CSRF and rejects private/receipt fields, query and path mismatches before impact', async () => {
  const { app, repo } = setup();
  const impact = vi.fn().mockResolvedValue(projectedImpact());
  repo.impact = impact;
  for (const payload of [
    { ...prepare, idempotencyKey: 'forged_key' },
    { ...prepare, candidateId: id },
    { ...prepare, receipt: {} },
    { ...prepare, athleteId: athlete },
    { ...prepare, intent: { ...prepare.intent, expectedEvent: { id, revision: 1 } } },
  ])
    expect(
      (await app.inject({ method: 'POST', url: impactUrl, headers: impactHeaders, payload }))
        .statusCode,
    ).toBe(400);
  for (const url of [impactUrl + '?candidateId=' + id, impactUrl.replace(race, 'not-a-uuid')])
    expect(
      (await app.inject({ method: 'POST', url, headers: impactHeaders, payload: prepare }))
        .statusCode,
    ).toBe(400);
  expect(
    (await app.inject({ method: 'POST', url: impactUrl, headers, payload: prepare })).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: impactUrl,
        headers: { ...impactHeaders, 'x-csrf-token': 'bad' },
        payload: prepare,
      })
    ).statusCode,
  ).toBe(403);
  expect(impact).not.toHaveBeenCalled();
  const anonymous = setup(false);
  anonymous.repo.impact = vi.fn();
  expect(
    (
      await anonymous.app.inject({
        method: 'POST',
        url: impactUrl,
        headers: impactHeaders,
        payload: prepare,
      })
    ).statusCode,
  ).toBe(401);
  expect(anonymous.repo.impact).not.toHaveBeenCalled();
});
it('returns a finite unavailable error when the processing port is not injected', async () => {
  const { app, repo } = setup();
  const reply = await app.inject({
    method: 'POST',
    url: impactUrl,
    headers: impactHeaders,
    payload: prepare,
  });
  expect(reply.statusCode).toBe(503);
  expect(reply.json().error.code).toBe('PUBLIC_PORT_UNAVAILABLE');
  expect(repo.review).not.toHaveBeenCalled();
});
it.each([
  ['INVALID_INTENT', 400],
  ['EVENT_UNAVAILABLE', 404],
  ['SOURCE_UNAVAILABLE', 404],
  ['REVISION_CONFLICT', 409],
  ['APP_CONSENT_REQUIRED', 409],
  ['CONTEXT_LIMIT', 422],
  ['INVALID_CONTEXT', 503],
  ['CONTEXT_UNAVAILABLE', 503],
] as const)('sanitizes actual preview error %s', async (code, status) => {
  const { app, repo } = setup();
  repo.impact = vi.fn().mockRejectedValue(new RacePlanImpactPreviewError(code));
  const reply = await app.inject({
    method: 'POST',
    url: impactUrl,
    headers: impactHeaders,
    payload: prepare,
  });
  expect(reply.statusCode).toBe(status);
  expect(reply.json().error.code).toBe(status === 503 ? 'PUBLIC_PORT_UNAVAILABLE' : code);
  expect(reply.body).not.toContain('record_json');
});
it('does not trust arbitrary error codes or malformed/oversized impact authority claims', async () => {
  const { app, repo } = setup();
  const impact = vi.fn();
  repo.impact = impact;
  impact.mockRejectedValue(
    Object.assign(Error('secret_private_body'), { code: 'REVISION_CONFLICT' }),
  );
  const reply = await app.inject({
    method: 'POST',
    url: impactUrl,
    headers: impactHeaders,
    payload: prepare,
  });
  expect(reply.statusCode).toBe(500);
  expect(reply.json().error.code).toBe('INTERNAL_ERROR');
  expect(reply.body).not.toContain('secret_private_body');
  const projected = projectedImpact();
  for (const body of [
    { ...projected, approvalAllowed: true },
    { ...projected, candidateId: id },
    { ...projected, rawSource: 'secret_private_body' },
    {
      ...projected,
      expectedEvent: { id: race, revision: 2 },
      intent: { ...projected.intent, expectedEvent: { id: race, revision: 2 } },
      race: { ...projected.race, expectedRevision: 2 },
    },
    { ...projected, notices: Array.from({ length: 5001 }, () => ({})) },
    { ...projected, rawSource: 'x'.repeat(4194305) },
  ]) {
    impact.mockResolvedValue(body);
    const invalid = await app.inject({
      method: 'POST',
      url: impactUrl,
      headers: impactHeaders,
      payload: prepare,
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).not.toContain('secret_private_body');
  }
  impact.mockClear();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: impactUrl,
        headers: impactHeaders,
        payload: { ...prepare, raw: 'x'.repeat(4194305) },
      })
    ).statusCode,
  ).toBe(413);
  expect(impact).not.toHaveBeenCalled();
});

it.each([
  ['PUBLIC_RESPONSE_LIMIT', 413],
  ['PUBLIC_PORT_UNAVAILABLE', 503],
  ['PUBLIC_REFERENCE_UNAVAILABLE', 404],
  ['PUBLIC_APPLICATION_UNAVAILABLE', 409],
  ['PUBLIC_INVALID_RESPONSE', 500],
] as const)(
  'maps genuine public impact factory error %s without trusting arbitrary codes',
  async (code, status) => {
    const { app, repo } = setup();
    repo.impact = vi.fn().mockRejectedValue(new RaceManualPublicError(code));
    const reply = await app.inject({
      method: 'POST',
      url: impactUrl,
      headers: impactHeaders,
      payload: prepare,
    });
    expect(reply.statusCode).toBe(status);
    expect(reply.json().error.code).toBe(status === 500 ? 'INTERNAL_ERROR' : code);
  },
);

it('advertises impact support only when the separate processing method is injected', async () => {
  const { app, repo } = setup();
  repo.impact = vi.fn();
  const reply = await app.inject({
    method: 'GET',
    url: '/bff/v1/race-date-change-reviews/capabilities?maxSchemaVersion=2',
    headers,
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toEqual({
    schemaVersion: 2,
    dateChangeReviews: true,
    dateChangeImpact: true,
  });
  expect(repo.impact).not.toHaveBeenCalled();
});
