import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

function parseSession(value: unknown) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      'csrfToken' in value &&
      typeof value.csrfToken === 'string' &&
      value.csrfToken.length > 0,
  );
  return { sessionId: value.sessionId, csrfToken: value.csrfToken };
}
function parseConsent(value: unknown) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      value.kind === 'app' &&
      'granted' in value &&
      typeof value.granted === 'boolean' &&
      'revision' in value &&
      typeof value.revision === 'number' &&
      Number.isInteger(value.revision) &&
      value.revision >= 0 &&
      value.revision <= 2147483647 &&
      (value.revision !== 0 || !value.granted),
  );
  assert.deepEqual(Object.keys(value).sort(), ['granted', 'kind', 'revision']);
  return { kind: value.kind, granted: value.granted, revision: value.revision };
}

/** Explicit positive scenario prerequisite; never invoked by login or global setup. */
export async function grantAppProcessingForScenario(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  const sessionResponse = await page.request.get(`${origin}/bff/v1/session`);
  expect(sessionResponse.status()).toBe(200);
  const session = parseSession(await sessionResponse.json());
  const headers = {
    origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  const read = await page.request.get(`${origin}/bff/v1/consents/app`, { headers });
  expect(read.status()).toBe(200);
  const current = parseConsent(await read.json());
  if (current.granted) return;
  const write = await page.request.put(`${origin}/bff/v1/consents/app`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { granted: true, expectedRevision: current.revision },
  });
  expect(write.status()).toBe(200);
  const committed = parseConsent(await write.json());
  expect(committed).toEqual({ kind: 'app', granted: true, revision: current.revision + 1 });
  const refreshed = await page.request.get(`${origin}/bff/v1/consents/app`, { headers });
  expect(refreshed.status()).toBe(200);
  expect(parseConsent(await refreshed.json())).toEqual(committed);
}
