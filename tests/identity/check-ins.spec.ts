import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  checkInSchema,
  checkInCommandResultSchema,
  checkInListSchema,
} from '../../packages/contracts/src/check-ins';
import { accountExportSchema } from '../../packages/contracts/src/operations';

test('OIDC scoped check-in API persists null and zero, corrects revisions, exports and removes health payload', async ({
  page,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  const session = await (await page.request.get('/bff/v1/session')).json();
  const headers = {
    origin: 'http://127.0.0.1:3100',
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
    'idempotency-key': randomUUID(),
  };
  const marker = `합성 체크인 ${randomUUID()}`;
  const values = {
    observedAt: '2026-09-15T23:30:00Z',
    timezone: 'Asia/Seoul',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: marker,
  };
  const create = await page.request.post('/bff/v1/check-ins', { headers, data: { values } });
  expect(create.status()).toBe(200);
  const original = checkInCommandResultSchema.parse(await create.json());
  const replay = await page.request.post('/bff/v1/check-ins', { headers, data: { values } });
  expect(await replay.json()).toEqual(original);
  const path = `/bff/v1/check-ins/${original.id}`;
  const first = await page.request.get(path, { headers });
  expect(checkInSchema.parse(await first.json())).toMatchObject({
    localDate: '2026-09-16',
    values: { fatigue: 0, discomfort: null },
    source: 'user',
    method: 'self_report',
  });
  const list = await page.request.get('/bff/v1/check-ins?from=2026-09-16&toExclusive=2026-09-17', {
    headers,
  });
  expect(
    checkInListSchema.parse(await list.json()).items.some((item) => item.id === original.id),
  ).toBe(true);
  const correction = {
    expectedRevision: original.revision,
    reason: '입력 정정',
    values: { ...values, fatigue: null, discomfort: 0 },
  };
  const updated = await page.request.put(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: correction,
  });
  expect(updated.status()).toBe(200);
  const current = checkInCommandResultSchema.parse(await updated.json());
  const stale = await page.request.put(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: correction,
  });
  expect(stale.status()).toBe(409);
  const exported = await page.request.post('/bff/v1/operations/export', { headers });
  expect(exported.status()).toBe(200);
  const artifact = accountExportSchema.parse(await exported.json());
  expect(artifact.schemaVersion).toBe(4);
  expect(JSON.stringify(artifact.data.checkIns)).toContain(marker);
  expect(
    artifact.data.checkInRevisions.filter((row) => row.check_in_id === original.id),
  ).toHaveLength(2);
  const removed = await page.request.delete(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: current.revision },
  });
  expect(removed.status()).toBe(200);
  expect((await page.request.get(path, { headers })).status()).toBe(404);
  const after = await page.request.post('/bff/v1/operations/export', { headers });
  expect(JSON.stringify(await after.json())).not.toContain(marker);
  const lateReplay = await page.request.post('/bff/v1/check-ins', { headers, data: { values } });
  expect(await lateReplay.json()).toEqual(original);
  expect((await page.request.get(path, { headers })).status()).toBe(404);
});
