import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activitySchema,
  activityImportResultSchema,
  activityExportSchema,
} from '../../packages/contracts/src/activity';
import { activityContextSchema } from '../../packages/contracts/src/activity-context';

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

const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  // Teardown has its own timeout budget, even if the product journey fails.
  // Local isolated OIDC/PostgreSQL synthetic Alice only; never external accounts.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

test('source session heart rate survives explicit v3 import and pace-only correction with legacy and failure states', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const command = {
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Synthetic metric summary',
      kind: 'running',
      startedAt: '2026-09-15T00:00:00Z',
      timezone: 'UTC',
      durationSeconds: 300.6,
      durationKind: 'elapsed',
      distanceMeters: 1000,
    },
    details: {
      schemaVersion: 2,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: null,
      recordedAt: null,
      elapsedSeconds: 300.6,
      sessionSummary: { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
      records: [{ index: 0, timestamp: null, distanceMeters: null, heartRateBpm: 180 }],
      laps: [],
    },
  };
  await page.goto('/activities/import');
  await page.getByLabel('가져올 활동 JSON', { exact: true }).setInputFiles({
    name: 'synthetic-session-heart-rate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(activityExportSchema.parse({ schemaVersion: 3, imports: [command] })),
    ),
  });
  await expect(page.getByText(/출처 세션 평균 심박: 0 bpm/)).toBeVisible();
  const importedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/bff/v1/activity-imports',
  );
  await page.getByRole('button', { name: '확인하고 가져오기', exact: true }).click();
  const imported = await importedResponse;
  expect(imported.status()).toBe(200);
  const id = activityImportResultSchema.parse(await imported.json()).activityId;
  assert.ok(id);
  const read = async () => {
    const response = await page.request.get(`/bff/v1/activities/${id}`, { headers });
    expect(response.status()).toBe(200);
    return activitySchema.parse(await response.json());
  };
  const initial = await read();
  // S09 header: source, observation time and correction state (M2-01k-g). The observation
  // time is the one the server stamped on the summary it answered with, not a client clock.
  const contextOf = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/bff/v1/activities/${id}/context`,
    );
  const firstContext = contextOf();
  await page.goto(`/activities?selected=${id}`);
  const firstObservedAt = activityContextSchema.parse(await (await firstContext).json()).observedAt;
  const header = page.getByRole('region', { name: '활동 요약 출처', exact: true });
  const observed = header.locator('time');
  await expect(header).toContainText(
    `출처 테스트 자료 · 원본 수정 1 · 기록 수정 ${initial.revision} · 사용자 정정 없음`,
  );
  await expect(header).toContainText(`출처 식별자: ${command.source.sourceId}`);
  await expect(observed).toHaveAttribute('datetime', firstObservedAt);
  await expect(observed).toHaveText(firstObservedAt);
  // An observation time, not the activity's own start.
  expect(firstObservedAt).not.toBe(command.activity.startedAt);
  const summary = page.getByRole('region', {
    name: '활동 거리·시간·페이스·심박 요약',
    exact: true,
  });
  const original = summary.getByRole('region', { name: '원본 값의 페이스', exact: true });
  const current = summary.getByRole('region', { name: '현재 값의 페이스', exact: true });
  const heart = summary.getByRole('region', { name: '출처 세션 심박 요약', exact: true });
  await expect(original).toContainText('5:01 /km (초 단위 반올림)');
  await expect(original).toContainText('경과 시간 300.6초');
  await expect(heart).toContainText('평균 심박: 0 bpm');
  await expect(heart).toContainText('최대 심박: 미보고');
  await expect(heart).not.toContainText('180 bpm');
  const corrected = await page.request.patch(`/bff/v1/activities/${id}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: initial.revision,
      durationSeconds: 120,
      durationKind: 'moving',
      reason: 'Synthetic pace correction',
    },
  });
  expect(corrected.status()).toBe(200);
  const correctedRevision = activitySchema.parse(await corrected.json()).revision;
  const secondContext = contextOf();
  await page.getByRole('button', { name: '활동 상세 다시 확인', exact: true }).click();
  const secondObservedAt = activityContextSchema.parse(
    await (await secondContext).json(),
  ).observedAt;
  await expect(header).toContainText(
    `출처 테스트 자료 · 원본 수정 1 · 기록 수정 ${correctedRevision} · 사용자 정정 있음`,
  );
  await expect(observed).toHaveAttribute('datetime', secondObservedAt);
  expect(Date.parse(secondObservedAt)).toBeGreaterThanOrEqual(Date.parse(firstObservedAt));
  await expect(current).toContainText('2:00 /km');
  await expect(current).toContainText('이동 시간 120초');
  await expect(original).toContainText('5:01 /km');
  await expect(heart).toContainText('평균 심박: 0 bpm');
  expect((await read()).original).toEqual(initial.original);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(current).toContainText('2:00 /km');
  const pattern = `**/bff/v1/activities/${id}/details`;
  await page.route(pattern, (route) => route.abort('failed'));
  await page.getByRole('button', { name: '활동 상세 다시 확인', exact: true }).click();
  await expect(heart.getByRole('alert')).toContainText('조회 실패');
  await expect(heart).not.toContainText('평균 심박:');
  await expect(current).toContainText('2:00 /km');
  await page.unroute(pattern);
  await page.getByRole('button', { name: '활동 상세 다시 확인', exact: true }).click();
  await expect(heart).toContainText('평균 심박: 0 bpm');
  const { sessionSummary: _summary, ...detailBase } = command.details;
  const legacyResponse = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: { ...command.source, sourceId: randomUUID() },
      activity: { ...command.activity, title: 'Synthetic legacy summary', distanceMeters: 0 },
      details: { ...detailBase, schemaVersion: 1 },
    },
  });
  expect(legacyResponse.status()).toBe(200);
  const legacy = activityImportResultSchema.parse(await legacyResponse.json());
  await page.goto(`/activities?selected=${legacy.activityId}`);
  await expect(heart).toContainText('이전 형식에 요약 없음');
  await expect(current).toContainText('거리가 0m여서 페이스를 계산하지 않습니다.');
  await expect(current).toContainText('거리 0m');
});
