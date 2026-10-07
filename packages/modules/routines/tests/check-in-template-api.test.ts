import { expect, it, vi } from 'vitest';
import { type AuthenticatedTransport, transportReplySchema } from '@workout/contracts/core';
import { checkInTemplateVersionSchema } from '@workout/contracts/check-in-templates';
import {
  createCheckInTemplateApi,
  CheckInTemplateRequestError,
} from '../src/check-in-template-api.js';
const templateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const record = checkInTemplateVersionSchema.parse({
  templateId,
  versionId,
  version: 1,
  previousVersionId: null,
  previousVersion: null,
  createdAt: '2026-10-08T00:00:00.123456Z',
  content: {
    definitionVersion: 'checkin-v1',
    source: 'user',
    method: 'self_report',
    title: 'Report',
    instructions: null,
    fields: ['note', 'fatigue'],
  },
});
const command = () => ({
  idempotencyKey: crypto.randomUUID(),
  templateId,
  expectedVersion: 0,
  content: record.content,
});
function fixture(body: unknown = record, status = 200) {
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    transportReplySchema.parse({ status, body, traceId: null }),
  );
  return { request, api: createCheckInTemplateApi({ request }) };
}
it('sends only stable command fields and header idempotency, preserving null/order/server timestamp', async () => {
  const f = fixture(),
    input = command();
  expect(await f.api.save(input)).toEqual(record);
  expect(f.request).toHaveBeenCalledWith({
    path: '/bff/v1/check-in-templates',
    method: 'POST',
    body: { templateId, expectedVersion: 0, content: record.content },
    idempotencyKey: input.idempotencyKey,
  });
  expect(f.request.mock.calls[0]?.[0].body).not.toHaveProperty('versionId');
  expect(f.request.mock.calls[0]?.[0].body).not.toHaveProperty('createdAt');
});
it('uses normalized UUID paired paths and forwards cancellation', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  expect(await f.api.readHead(templateId.toUpperCase(), signal)).toEqual(record);
  expect(await f.api.readExact(templateId.toUpperCase(), versionId.toUpperCase(), signal)).toEqual(
    record,
  );
  expect(f.request.mock.calls[1]?.[0]).toEqual({
    path: `/bff/v1/check-in-templates/${templateId}/versions/${versionId}`,
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal,
  });
});
it('lists bounded deterministic pages with explicit limit/offset', async () => {
  const f = fixture({ items: [record] });
  expect(await f.api.list({ limit: 1, offset: 10000 })).toEqual({ items: [record] });
  expect(f.request.mock.calls[0]?.[0].path).toBe('/bff/v1/check-in-templates?limit=1&offset=10000');
  await f.api.list();
  expect(f.request.mock.calls[1]?.[0].path).toBe('/bff/v1/check-in-templates?limit=20&offset=0');
});
it.each([
  { limit: 0 },
  { limit: 101 },
  { offset: -1 },
  { offset: 10001 },
  { offset: 1.1 },
  { athleteId: crypto.randomUUID() },
])('rejects invalid page before transport %j', async (input) => {
  const f = fixture({ items: [] });
  await expect(f.api.list(input)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});
it.each(['not-a-uuid', '../private', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?x=1'])(
  'rejects unsafe path before transport %s',
  async (id) => {
    const f = fixture();
    await expect(f.api.readExact(id, versionId)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  },
);
it.each(['idempotencyKey', 'versionId', 'createdAt', 'athleteId'])(
  'rejects missing key or invented server field %s',
  async (field) => {
    const input =
      field === 'idempotencyKey'
        ? { templateId, expectedVersion: 0, content: record.content }
        : { ...command(), [field]: crypto.randomUUID() };
    const f = fixture();
    await expect(f.api.save(input)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  },
);
it.each(['templateId', 'versionId'])('rejects foreign exact response %s', async (field) => {
  const f = fixture({ ...record, [field]: crypto.randomUUID() });
  await expect(f.api.readExact(templateId, versionId)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
it('rejects foreign head and foreign save response', async () => {
  const f = fixture({ ...record, templateId: crypto.randomUUID() });
  await expect(f.api.readHead(templateId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(f.api.save(command())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it.each([
  { ...record, extra: true },
  { ...record, content: { ...record.content, reviewed: true } },
  { ...record, previousVersionId: crypto.randomUUID() },
])('strictly rejects malformed DTO', async (body) => {
  await expect(fixture(body).api.readHead(templateId)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
it('rejects list duplicate, unordered, oversized page and unknown wrapper', async () => {
  for (const body of [
    { items: [record, record] },
    { items: [{ ...record, templateId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, record] },
    { items: [record], extra: true },
  ])
    await expect(fixture(body).api.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    fixture({
      items: [record, { ...record, templateId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
    }).api.list({ limit: 1 }),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('rejects save response with changed content or wrong successor version', async () => {
  await expect(
    fixture({ ...record, content: { ...record.content, fields: ['fatigue', 'note'] } }).api.save(
      command(),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    fixture({
      ...record,
      version: 2,
      previousVersion: 1,
      previousVersionId: crypto.randomUUID(),
    }).api.save(command()),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('preserves finite HTTP failure and sanitizes unknown error payload', async () => {
  await expect(
    fixture({ error: { code: 'APP_CONSENT_REQUIRED' } }, 409).api.save(command()),
  ).rejects.toMatchObject({ status: 409, code: 'APP_CONSENT_REQUIRED' });
  await expect(fixture({ secret: 'unknown' }, 500).api.readHead(templateId)).rejects.toMatchObject({
    status: 500,
    code: 'REQUEST_FAILED',
  });
  await expect(
    fixture({ error: { code: 'NOT_FOUND' } }, 404).api.readHead(templateId),
  ).rejects.toBeInstanceOf(CheckInTemplateRequestError);
});
it('normalizes network failure without exposing its message', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async () => {
    throw Error('PRIVATE_DETAIL');
  });
  await expect(createCheckInTemplateApi({ request }).readHead(templateId)).rejects.toMatchObject({
    status: 0,
    code: 'UNAVAILABLE',
    message: 'UNAVAILABLE',
  });
});
it('preserves pre-aborted and late-aborted signal without consuming response', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await expect(f.api.readHead(templateId, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.request).not.toHaveBeenCalled();
  const late = new AbortController();
  const request: AuthenticatedTransport['request'] = async () => {
    late.abort();
    return transportReplySchema.parse({ status: 200, body: record, traceId: null });
  };
  await expect(
    createCheckInTemplateApi({ request }).readHead(templateId, late.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects an unknown transport envelope field as an invalid response', async () => {
  const request: AuthenticatedTransport['request'] = async () => ({
    status: 200,
    body: record,
    traceId: null,
    unexpected: true,
  });
  await expect(createCheckInTemplateApi({ request }).readHead(templateId)).rejects.toMatchObject({
    status: 0,
    code: 'INVALID_RESPONSE',
  });
});
