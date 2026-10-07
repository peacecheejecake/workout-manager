import { expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  createRaceManualPublicApi,
  RaceManualPublicRequestError,
} from '../src/race-manual-public-api';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const race = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const hash = 'a'.repeat(64);
const key = 'stable_review_001';
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
const review = { status: 'reviewed', reference, bodyState: 'present' };
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
  approvedAt: reference.createdAt,
  race: { eventId: race, revision: 2 },
  versions: [],
  occurrenceIds: [],
  notices: [],
};
const body = {
  schemaVersion: 1,
  intent: {
    expectedEvent: { id: race, revision: 1 },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
  },
};
const approve = { schemaVersion: 1, applicationDigest: hash, confirmed: true };
const reply = (value: unknown, status = 200) =>
  transportReplySchema.parse({ status, body: value, traceId: null });
function setup(value: unknown, status = 200) {
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply(value, status));
  return { api: createRaceManualPublicApi({ request }), request };
}
it('uses exact path, header-only stable key, canonical UUID and never autoapproves', async () => {
  const { api, request } = setup(review, 201);
  const signal = new AbortController().signal;
  expect(await api.review(race.toUpperCase(), body, key, signal)).toEqual(review);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: `/bff/v1/races/${race}/date-change-reviews`,
    method: 'POST',
    body: { ...body, intent: { ...body.intent, resolutions: { nutrition: [], routines: [] } } },
    idempotencyKey: key,
    signal,
  });
});
it('returns purged reference and checks exact read identity', async () => {
  const { api, request } = setup(preview);
  expect(await api.readPreview(id.toUpperCase())).toEqual(preview);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: `/bff/v1/race-date-change-reviews/${id}`,
    method: 'GET',
    body: null,
    idempotencyKey: null,
  });
  request.mockResolvedValue(reply({ ...preview, reference: { ...reference, candidateId: race } }));
  await expect(api.readPreview(id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('validates committed candidate and required original proposal tuple', async () => {
  const { api, request } = setup(committed);
  expect(await api.approve(reference, approve, key)).toEqual(committed);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: `/bff/v1/race-date-change-reviews/${id}/approve`,
    method: 'POST',
    body: approve,
    idempotencyKey: key,
  });
  request.mockResolvedValue(reply({ ...committed, candidateId: race }));
  await expect(api.approve(reference, approve, key)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  request.mockResolvedValue(reply({ ...committed, proposalId: race }));
  await expect(api.approve(reference, approve, key)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
it('keeps approval blocked, rejects scalar references and private reviewed output', async () => {
  const blocked = {
    schemaVersion: 1,
    status: 'blocked',
    candidateId: id,
    blockers: [{ reason: 'stale_basis', target: null }],
  };
  const { api, request } = setup(blocked, 409);
  expect(await api.approve(reference, approve, key)).toEqual(blocked);
  await expect(api.approve(id, approve, key)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue(
    reply({ ...review, reference: { ...reference, privateContext: {} } }, 201),
  );
  await expect(api.review(race, body, key)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it.each(['semantic', 'chain', 'application'])(
  'preserves finite blocked review %s without approval',
  async (stage) => {
    const result = { status: 'blocked', stage };
    const { api, request } = setup(result, 409);
    expect(await api.review(race, body, key)).toEqual(result);
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it.each(['idempotencyKey', 'athleteId', 'basis', 'recipe', 'sourceContext'])(
  'rejects private/extra review field %s before I/O',
  async (field) => {
    const { api, request } = setup(review, 201);
    await expect(api.review(race, { ...body, [field]: key }, key)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(['candidateId', 'idempotencyKey', 'expectedBasis'])(
  'rejects forbidden approve body field %s',
  async (field) => {
    const { api, request } = setup(committed);
    await expect(api.approve(reference, { ...approve, [field]: id }, key)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(request).not.toHaveBeenCalled();
  },
);
it('rejects wrong event, confirmation, key and expected tuple', async () => {
  const { api, request } = setup(committed);
  await expect(api.review(id, body, key)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(api.approve(reference, { ...approve, confirmed: false }, key)).rejects.toMatchObject(
    {
      code: 'INVALID_INPUT',
    },
  );
  await expect(api.approve(reference, approve, 'bad key')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    api.approve({ ...reference, applicationDigest: 'b'.repeat(64) }, approve, key),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(request).not.toHaveBeenCalled();
});
it('never retries uncertain transport and preserves caller key for explicit retry', async () => {
  const { api, request } = setup(review, 201);
  request.mockRejectedValueOnce(new Error('secret credentials'));
  await expect(api.review(race, body, key)).rejects.toEqual(
    new RaceManualPublicRequestError(0, 'TRANSPORT_UNAVAILABLE'),
  );
  expect(request).toHaveBeenCalledTimes(1);
  await api.review(race, body, key);
  expect(request.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([key, key]);
});
it.each([401, 403, 404, 409, 413, 500])(
  'sanitizes unknown failure body at status %s',
  async (status) => {
    const { api } = setup({ secret: 'private SQL detail' }, status);
    await expect(api.readPreview(id)).rejects.toEqual(
      new RaceManualPublicRequestError(status, 'REQUEST_FAILED'),
    );
  },
);
it('preserves finite application error code and rejects extra error payload', async () => {
  const { api, request } = setup({ error: { code: 'APP_CONSENT_REQUIRED' } }, 409);
  await expect(api.review(race, body, key)).rejects.toMatchObject({
    status: 409,
    code: 'APP_CONSENT_REQUIRED',
  });
  request.mockResolvedValue(
    reply({ error: { code: 'PRIVATE_ARBITRARY_CODE', message: 'raw' } }, 500),
  );
  await expect(api.review(race, body, key)).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
});
it('rejects invalid DTO, wrong success status, huge reply', async () => {
  const { api, request } = setup({ ...review, basis: {} }, 201);
  await expect(api.review(race, body, key)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  request.mockResolvedValue(reply(review, 200));
  await expect(api.review(race, body, key)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  request.mockResolvedValue(reply({ ...preview, private: 'x'.repeat(4194305) }));
  await expect(api.readPreview(id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('rejects getters/cycles/depth/oversize ingress without touching transport', async () => {
  const { api, request } = setup(review, 201);
  const getter = Object.defineProperty({}, 'intent', {
    enumerable: true,
    get() {
      throw Error('Getter accessed');
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = null;
  for (let n = 0; n < 70; n++) deep = { next: deep };
  for (const value of [getter, cycle, deep, { ...body, extra: 'x'.repeat(4194305) }])
    await expect(api.review(race, value, key)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(request).not.toHaveBeenCalled();
});
it('honors cancellation before sending and after uncertain late response', async () => {
  const { api, request } = setup(review, 201);
  const controller = new AbortController();
  controller.abort();
  await expect(api.review(race, body, key, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(request).not.toHaveBeenCalled();
  const late = new AbortController();
  request.mockImplementation(async () => {
    late.abort();
    return reply(review, 201);
  });
  await expect(api.review(race, body, key, late.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([true, false])('reads explicit capability %s with no write key', async (supported) => {
  const { api, request } = setup({ schemaVersion: 1, dateChangeReviews: supported });
  expect(await api.capabilities()).toEqual({ schemaVersion: 1, dateChangeReviews: supported });
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: '/bff/v1/race-date-change-reviews/capabilities?maxSchemaVersion=2',
    method: 'GET',
    body: null,
    idempotencyKey: null,
  });
});
it.each([
  { schemaVersion: 1 },
  { schemaVersion: 1, dateChangeReviews: 'true' },
  { schemaVersion: 1, dateChangeReviews: true, approvalAllowed: true },
])('rejects invalid or authority-bearing capability %#', async (value) => {
  const { api } = setup(value);
  await expect(api.capabilities()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('does not infer capability from missing endpoint or send an aborted read', async () => {
  const { api, request } = setup({ error: { code: 'NOT_FOUND' } }, 404);
  await expect(api.capabilities()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  const abort = new AbortController();
  abort.abort();
  await expect(api.capabilities(abort.signal)).rejects.toBeDefined();
  expect(request).toHaveBeenCalledTimes(1);
});

function impactFixture() {
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
  return {
    schemaVersion: 1,
    status: 'projected',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    expectedEvent: body.intent.expectedEvent,
    intent: { ...body.intent, resolutions: { nutrition: [], routines: [] } },
    beforeBasis: 'captured_snapshot',
    afterBasis: 'hypothetical',
    race: {
      eventId: race,
      expectedRevision: 1,
      before,
      after: { ...before, localDate: body.intent.newLocalDate },
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
it('posts strict transient impact without generating a review key or candidate and keeps blocked diagnostics', async () => {
  const { api, request } = setup(impactFixture());
  expect(await api.impact(race.toUpperCase(), body)).toEqual(impactFixture());
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: `/bff/v1/races/${race}/date-change-impact`,
    method: 'POST',
    body: { ...body, intent: { ...body.intent, resolutions: { nutrition: [], routines: [] } } },
    idempotencyKey: null,
  });
  const blocked = {
    schemaVersion: 1,
    status: 'blocked',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    reason: 'unsupported_source',
    domains: ['nutrition'],
  };
  request.mockResolvedValue(reply(blocked));
  expect(await api.impact(race, body)).toEqual(blocked);
  request.mockResolvedValue(reply(blocked, 409));
  await expect(api.impact(race, body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('rejects private impact input and mismatched event/date/selection responses', async () => {
  const { api, request } = setup(impactFixture());
  for (const input of [
    { ...body, candidateId: id },
    { ...body, idempotencyKey: key },
    { ...body, intent: { ...body.intent, expectedEvent: { id, revision: 1 } } },
  ])
    await expect(api.impact(race, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(request).not.toHaveBeenCalled();
  const impact = impactFixture();
  for (const result of [
    { ...impact, approvalAllowed: true },
    { ...impact, rawSource: 'private' },
    {
      ...impact,
      expectedEvent: { id: race, revision: 2 },
      intent: { ...impact.intent, expectedEvent: { id: race, revision: 2 } },
      race: { ...impact.race, expectedRevision: 2 },
    },
    {
      ...impact,
      intent: { ...impact.intent, newLocalDate: '2026-10-10' },
      race: { ...impact.race, after: { ...impact.race.after, localDate: '2026-10-10' } },
    },
    { ...impact, raw: 'x'.repeat(4194305) },
  ]) {
    request.mockResolvedValue(reply(result));
    await expect(api.impact(race, body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
});
it.each([
  ['EVENT_UNAVAILABLE', 404],
  ['REVISION_CONFLICT', 409],
  ['CONTEXT_LIMIT', 422],
  ['PUBLIC_PORT_UNAVAILABLE', 503],
] as const)('preserves finite impact error %s', async (code, status) => {
  const { api } = setup({ error: { code } }, status);
  await expect(api.impact(race, body)).rejects.toMatchObject({ code, status });
});
it('cancels transient impact before and after transport without a write retry identity', async () => {
  const { api, request } = setup(impactFixture());
  const before = new AbortController();
  before.abort();
  await expect(api.impact(race, body, before.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  const after = new AbortController();
  request.mockImplementation(async () => {
    after.abort();
    return reply(impactFixture());
  });
  await expect(api.impact(race, body, after.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
