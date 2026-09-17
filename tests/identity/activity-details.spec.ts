import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityDetailsReadSchema,
  activityExportSchema,
  activityImportResultSchema,
  activityListSchema,
  activitySummarySchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import { activityDetailsSchema } from '../../packages/contracts/src/activity-details';

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

test('explicit v1 and v2 file imports keep one activity while source details retain zero, unknown and tenant boundaries', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(5000);
  const headers = await login(page, 'Alice');
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: `Synthetic detail import ${randomUUID()}`,
      kind: 'running',
      startedAt: '2023-06-15T12:00:00Z',
      timezone: 'UTC',
      durationSeconds: null,
      durationKind: 'unknown',
      distanceMeters: 0,
    },
  });
  const details = activityDetailsSchema.parse({
    schemaVersion: 1,
    streamIndex: 0,
    sessionIndex: 0,
    startedAt: '2023-06-15T12:00:00Z',
    recordedAt: '2023-06-15T12:30:00Z',
    elapsedSeconds: null,
    records: Array.from({ length: 300 }, (_, index) => ({
      index,
      timestamp: index === 1 ? '2023-06-15T12:00:01Z' : null,
      distanceMeters: index === 0 ? 0 : null,
      heartRateBpm: index === 0 ? 0 : null,
    })),
    laps: [
      {
        index: 0,
        startedAt: null,
        recordedAt: '2023-06-15T12:30:00Z',
        elapsedSeconds: null,
        timerSeconds: 0,
        distanceMeters: 0,
        averageHeartRateBpm: 0,
        maximumHeartRateBpm: null,
      },
    ],
  });
  const enhanced = importActivitySchema.parse({
    ...command,
    idempotencyKey: randomUUID(),
    source: { ...command.source, revision: 2, contentHash: 'b'.repeat(64) },
    details,
  });
  const summary = async () => {
    const response = await page.request.get('/bff/v1/activities/summary', { headers });
    expect(response.status()).toBe(200);
    return activitySummarySchema.parse(await response.json());
  };
  const matching = async () => {
    const response = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ search: command.activity.title ?? '' })}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/bff/v1/activity-imports'
    )
      writes++;
  });
  try {
    const before = await summary();
    await page.goto('/activities/import');
    const upload = page.getByLabel('가져올 활동 JSON', { exact: true });
    const file = (schemaVersion: 1 | 2, item: typeof enhanced | typeof command) => ({
      name: `synthetic-v${schemaVersion}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify(activityExportSchema.parse({ schemaVersion, imports: [item] })),
      ),
    });
    await upload.setInputFiles(file(1, command));
    await expect(page.getByText('가져오기 미리보기: 1개 세션', { exact: true })).toBeVisible();
    await expect(
      page.getByText('세부 기록 없음 · 요약만 제공된 활동입니다.', { exact: true }),
    ).toBeVisible();
    expect(writes).toBe(0);
    expect(await summary()).toEqual(before);
    const importResponse = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/bff/v1/activity-imports',
      );
    const firstPending = importResponse();
    await page.getByRole('button', { name: '확인하고 가져오기', exact: true }).click();
    const firstResponse = await firstPending;
    expect(firstResponse.status()).toBe(200);
    const first = activityImportResultSchema.parse(await firstResponse.json());
    expect(first.outcome).toBe('imported');
    const readDetails = async () => {
      const response = await page.request.get(`/bff/v1/activities/${first.activityId}/details`, {
        headers,
      });
      expect(response.status()).toBe(200);
      return activityDetailsReadSchema.parse(await response.json());
    };
    expect((await readDetails()).details).toBeNull();
    const afterLegacy = await summary();
    expect(afterLegacy.count).toBe(before.count + 1);
    expect(afterLegacy.distanceMeters.knownCount).toBe(before.distanceMeters.knownCount + 1);
    const v2 = file(2, enhanced);
    expect(v2.buffer.byteLength).toBeGreaterThan(16 * 1024);
    await upload.setInputFiles(v2);
    await expect(page.getByText('세부 기록: 레코드 300개 · 랩 1개', { exact: true })).toBeVisible();
    await expect(
      page.getByText('레코드 미확인: 시각 299개 · 거리 299개 · 심박수 299개', { exact: true }),
    ).toBeVisible();
    expect(writes).toBe(1);
    expect((await readDetails()).details).toBeNull();
    const secondPending = importResponse();
    await page.getByRole('button', { name: '확인하고 가져오기', exact: true }).click();
    const secondResponse = await secondPending;
    expect(secondResponse.status()).toBe(200);
    const second = activityImportResultSchema.parse(await secondResponse.json());
    expect(second.activityId).toBe(first.activityId);
    expect(second.revision).toBeGreaterThan(first.revision);
    const currentDetails = await readDetails();
    expect(currentDetails).toEqual({
      activityId: first.activityId,
      activityRevision: second.revision,
      source: enhanced.source,
      details,
    });
    expect(await summary()).toEqual(afterLegacy);
    const list = await matching();
    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe(first.activityId);
    expect(list.items[0]?.original).toEqual(command.activity);
    expect(list.items[0]?.effective).toEqual(command.activity);
    await page.reload();
    await expect(
      page.getByRole('button', { name: command.activity.title ?? '', exact: true }),
    ).toBeVisible();
    expect(await readDetails()).toEqual(currentDetails);

    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const bob = await login(other, 'Bob');
      const denied = await other.request.get(`/bff/v1/activities/${first.activityId}/details`, {
        headers: bob,
      });
      expect(denied.status()).toBe(404);
      expect(await denied.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await otherContext.close();
    }
    const { idempotencyKey: originalKey, ...originalBody } = command;
    const replay = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': originalKey },
      data: originalBody,
    });
    expect(replay.status()).toBe(200);
    expect(activityImportResultSchema.parse(await replay.json())).toEqual(first);
    expect(await readDetails()).toEqual(currentDetails);
    const { idempotencyKey: enhancedKey, ...enhancedBody } = enhanced;
    assert.ok(enhancedKey);
    const conflicting = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        ...enhancedBody,
        details: {
          ...details,
          records: details.records.map((record) =>
            record.index === 0 ? { ...record, heartRateBpm: 1 } : record,
          ),
        },
      },
    });
    expect(conflicting.status()).toBe(409);
    expect(await conflicting.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(await readDetails()).toEqual(currentDetails);
    expect(await summary()).toEqual(afterLegacy);
    const removed = await page.request.delete(`/bff/v1/activities/${first.activityId}`, {
      headers,
      data: { expectedRevision: second.revision },
    });
    expect(removed.status()).toBe(204);
    expect(
      (
        await page.request.get(`/bff/v1/activities/${first.activityId}/details`, { headers })
      ).status(),
    ).toBe(404);
    const suppressed = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        ...enhancedBody,
        source: { ...enhanced.source, revision: 3, contentHash: 'c'.repeat(64) },
      },
    });
    expect(suppressed.status()).toBe(200);
    expect(activityImportResultSchema.parse(await suppressed.json()).outcome).toBe('suppressed');
    expect(
      (
        await page.request.get(`/bff/v1/activities/${first.activityId}/details`, { headers })
      ).status(),
    ).toBe(404);
    expect((await matching()).total).toBe(0);
    expect(await summary()).toEqual(before);
  } finally {
    // Private synthetic Alice only; the other account is never mutated or deleted.
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
      timeout: 5000,
    });
    expect(erased.status()).toBe(200);
  }
});
