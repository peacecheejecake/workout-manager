import { expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createResultCapabilityApi, ResultCapabilityError } from '../src/result-capability-api';
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])('reads exact independent support flags %s/%s', async (legacyResults, proofResultsV2) => {
  const value = { schemaVersion: 1, legacyResults, proofResultsV2 };
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply(value));
  const signal = new AbortController().signal;
  expect(await createResultCapabilityApi({ request }).read(signal)).toEqual(value);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: '/bff/v1/race-results/capabilities',
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal,
  });
});
it.each([400, 401, 403, 404, 409, 503])('does not infer support from status %s', async (status) => {
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    reply({ secret: 'private' }, status),
  );
  await expect(
    createResultCapabilityApi({ request }).read(new AbortController().signal),
  ).rejects.toEqual(new ResultCapabilityError('UNAVAILABLE'));
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  null,
  { schemaVersion: 2, legacyResults: true, proofResultsV2: true },
  { schemaVersion: 1, legacyResults: 'true', proofResultsV2: true },
  { schemaVersion: 1, legacyResults: true },
  { schemaVersion: 1, legacyResults: true, proofResultsV2: true, extra: 'private' },
  { schemaVersion: 1, legacyResults: true, proofResultsV2: true, extra: 'x'.repeat(300) },
])('rejects invalid or oversized capability DTO %#', async (body) => {
  const request: AuthenticatedTransport['request'] = async () => reply(body);
  await expect(
    createResultCapabilityApi({ request }).read(new AbortController().signal),
  ).rejects.toEqual(new ResultCapabilityError('INVALID_RESPONSE'));
});
it('sanitizes thrown transport errors without exposing their text', async () => {
  const request: AuthenticatedTransport['request'] = async () => {
    throw new Error('private credential');
  };
  await expect(
    createResultCapabilityApi({ request }).read(new AbortController().signal),
  ).rejects.toEqual(new ResultCapabilityError('UNAVAILABLE'));
});
it('aborts before sending and after a late transport response', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    reply({ schemaVersion: 1, legacyResults: true, proofResultsV2: true }),
  );
  await expect(
    createResultCapabilityApi({ request }).read(controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
  const late = new AbortController();
  const lateRequest: AuthenticatedTransport['request'] = async () => {
    late.abort();
    return reply({ schemaVersion: 1, legacyResults: true, proofResultsV2: true });
  };
  await expect(
    createResultCapabilityApi({ request: lateRequest }).read(late.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
