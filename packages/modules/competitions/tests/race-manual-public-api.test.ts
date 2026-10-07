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
