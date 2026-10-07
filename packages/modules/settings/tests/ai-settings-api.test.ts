import { expect, test, vi } from 'vitest';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsWriteV1Schema,
} from '@workout/contracts/ai-settings';
import { createAiSettingsPort } from '../src/ai-settings-api.js';
const absent = {
  schemaVersion: 1,
  revision: 0,
  updatedAt: null,
  defaultSelection: null,
  syntheticComparison: { kind: 'off' },
};
const command = aiSettingsWriteV1Schema.parse({
  schemaVersion: 1,
  expectedRevision: 0,
  idempotencyKey: 'settings-write-1',
  catalogRevision: 1,
  policyVersion: 'policy:1',
  disclosureVersion: 'disclosure:1',
  defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
  syntheticComparison: { kind: 'off' },
});
const committed = {
  ...absent,
  revision: 1,
  updatedAt: '2026-10-06T00:00:00Z',
  defaultSelection: command.defaultSelection,
};
const catalog = aiExecutionCatalogV1Schema.parse({
  schemaVersion: 1,
  catalogRevision: 1,
  policyVersion: 'policy:1',
  disclosureVersion: 'disclosure:1',
  approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
  providers: [],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
});
function context() {
  return {
    athleteId: 'local-cache-owner',
    sessionId: 'local-session',
    signal: new AbortController().signal,
  };
}
function transport(body: unknown, status = 200) {
  const request = vi.fn(async (_input: TransportRequest) =>
    transportReplySchema.parse({ body, status, traceId: null }),
  );
  return { request } satisfies AuthenticatedTransport;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

test('GET paths send no ownership/body/header overrides and propagate exact signal', async () => {
  const fake = transport(catalog);
  const api = createAiSettingsPort(fake);
  const scope = context();
  expect(await api.getCatalog(scope)).toEqual(catalog);
  expect(fake.request).toHaveBeenCalledWith({
    path: '/bff/v1/ai-settings/catalog',
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal: scope.signal,
  });
  const settings = transport(absent);
  expect(await createAiSettingsPort(settings).getSettings(scope)).toEqual(absent);
  expect(settings.request).toHaveBeenCalledWith({
    path: '/bff/v1/ai-settings',
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal: scope.signal,
  });
});
test('PUT separates stable idempotency header from strict preference-only body', async () => {
  const fake = transport(committed);
  const scope = context();
  const api = createAiSettingsPort(fake);
  expect(await api.save(scope, command)).toEqual(committed);
  await api.save(scope, command);
  const { idempotencyKey, ...body } = command;
  expect(fake.request).toHaveBeenNthCalledWith(1, {
    path: '/bff/v1/ai-settings',
    method: 'PUT',
    body,
    idempotencyKey,
    signal: scope.signal,
  });
  expect(fake.request.mock.calls[1]?.[0]).toEqual(fake.request.mock.calls[0]?.[0]);
  expect(fake.request).toHaveBeenCalledTimes(2);
});
test.each([
  ['REVISION_CONFLICT', 409],
  ['STALE_CATALOG', 409],
  ['STALE_POLICY', 409],
  ['STALE_DISCLOSURE', 409],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['UNAUTHENTICATED', 401],
  ['FORBIDDEN', 403],
  ['CSRF_REJECTED', 403],
  ['DEFAULT_NOT_SELECTABLE', 422],
  ['COMPARISON_NOT_SELECTABLE', 422],
  ['UNAVAILABLE', 503],
])('preserves stable %s only with its valid HTTP status', async (code, status) => {
  const fake = transport({ error: { code }, requestId: 'synthetic-request-1' }, Number(status));
  const api = createAiSettingsPort(fake);
  await expect(api.save(context(), command)).rejects.toMatchObject({ code });
  expect(fake.request).toHaveBeenCalledOnce();
  await expect(
    createAiSettingsPort(transport({ error: { code } }, 200)).getSettings(context()),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    createAiSettingsPort(
      transport({ error: { code } }, Number(status) === 409 ? 403 : 409),
    ).getSettings(context()),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test.each([
  { error: { code: 'UNKNOWN', message: 'private' } },
  { error: { code: 'STALE_CATALOG', extra: true } },
  { error: { code: 'STALE_CATALOG' }, requestId: 'bad\r\nheader' },
  { error: { code: 'STALE_CATALOG' }, apiKey: 'private' },
])('invalid error shapes are sanitized and never retried', async (body) => {
  const fake = transport(body, 409);
  await expect(createAiSettingsPort(fake).save(context(), command)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    message: 'INVALID_RESPONSE',
  });
  expect(fake.request).toHaveBeenCalledOnce();
});
test('invalid command, extra ownership/key override and unsafe header key never reach transport', async () => {
  const fake = transport(committed);
  const api = createAiSettingsPort(fake);
  for (const invalid of [
    { ...command, athleteId: 'forged' },
    { ...command, apiKey: 'private' },
    { ...command, idempotencyKey: 'bad\r\nheader' },
  ])
    await expect(api.save(context(), invalid)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fake.request).not.toHaveBeenCalled();
});
test('strict success DTO and exact committed choices/revision are required', async () => {
  for (const body of [
    { ...committed, apiKey: 'private' },
    absent,
    { ...committed, revision: 2 },
    { ...committed, defaultSelection: null },
  ])
    await expect(
      createAiSettingsPort(transport(body)).save(context(), command),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    createAiSettingsPort(transport(absent, 201)).getSettings(context()),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test('unknown envelope fields are rejected despite typed transport boundary', async () => {
  const fake: AuthenticatedTransport = {
    request: async () => ({ status: 200, body: absent, traceId: null, extra: 'private' }),
  };
  await expect(createAiSettingsPort(fake).getSettings(context())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
test('catalog cannot expose additional provider even through valid general DTO', async () => {
  const data = {
    ...catalog,
    providers: [
      {
        providerId: 'other',
        displayName: 'Other',
        selectable: true,
        availability: { kind: 'available' },
        recipient: {
          recipientId: 'other',
          displayName: 'Other',
          disclosureVersion: 'disclosure:1',
        },
        models: [],
      },
    ],
  };
  await expect(createAiSettingsPort(transport(data)).getCatalog(context())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
test('network failures are sanitized without automatic retry', async () => {
  const request = vi.fn(async () => {
    throw new Error('private token');
  });
  await expect(createAiSettingsPort({ request }).getSettings(context())).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'UNAVAILABLE',
  });
  expect(request).toHaveBeenCalledOnce();
});
test('pre-abort prevents request and late successful reply cannot bypass abort', async () => {
  const pending = deferred<ReturnType<typeof transportReplySchema.parse>>();
  const request = vi.fn(() => pending.promise);
  const api = createAiSettingsPort({ request });
  const abort = new AbortController();
  const scope = { ...context(), signal: abort.signal };
  const result = api.save(scope, command);
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  pending.resolve(transportReplySchema.parse({ status: 200, body: committed, traceId: null }));
  await assertion;
  expect(request).toHaveBeenCalledOnce();
  await expect(api.getSettings(scope)).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledOnce();
});

test.each([700, 99, 200.5, 204, 302])(
  'invalid or unexpected status %s cannot be accepted as settings',
  async (status) => {
    const fake: AuthenticatedTransport = {
      request: async () => ({ status, body: absent, traceId: null }),
    };
    await expect(createAiSettingsPort(fake).getSettings(context())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  },
);

test.each([
  { error: { code: 'UNKNOWN' } },
  { error: { code: 'CSRF_REJECTED', message: 'private detail' } },
  { error: { code: 'CSRF_REJECTED' }, extra: true },
])('arbitrary or malformed403 is rejected without accepting CSRF or success', async (body) => {
  const fake = transport(body, 403);
  await expect(createAiSettingsPort(fake).save(context(), command)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    message: 'INVALID_RESPONSE',
  });
  expect(fake.request).toHaveBeenCalledOnce();
});
