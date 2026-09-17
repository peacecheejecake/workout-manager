import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
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

const cleanup = new WeakMap<
  Page,
  { headers: Awaited<ReturnType<typeof login>>; id: string; revision: number }
>();
test.afterEach(async ({ page }) => {
  const entry = cleanup.get(page);
  if (!entry) return;
  cleanup.delete(page);
  const response = await page.request.delete(`/bff/v1/activities/${entry.id}`, {
    headers: entry.headers,
    data: { expectedRevision: entry.revision },
    timeout: 5000,
  });
  expect(response.status()).toBe(204);
});
async function setup(page: Page) {
  const headers = await login(page);
  const start = Date.parse('2023-06-15T12:00:00Z');
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'c'.repeat(64) },
    activity: {
      title: `Synthetic source workbench ${randomUUID()}`,
      kind: 'running',
      startedAt: new Date(start).toISOString(),
      timezone: 'UTC',
      durationSeconds: 520,
      durationKind: 'elapsed',
      distanceMeters: 1000,
    },
    details: {
      schemaVersion: 1,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: new Date(start).toISOString(),
      recordedAt: '2023-06-16T12:00:00Z',
      elapsedSeconds: 520,
      records: Array.from({ length: 520 }, (_, index) => ({
        index,
        timestamp:
          index === 2 ? null : new Date(start + (index === 3 ? 1 : index) * 1000).toISOString(),
        distanceMeters: index === 1 ? null : index * 2,
        heartRateBpm: index === 1 ? null : index === 0 ? 0 : 120,
      })),
      laps: [
        {
          index: 0,
          startedAt: new Date(start).toISOString(),
          recordedAt: '2023-06-16T12:00:00Z',
          elapsedSeconds: 10,
          timerSeconds: 8,
          distanceMeters: 0,
          averageHeartRateBpm: 0,
          maximumHeartRateBpm: null,
        },
        {
          index: 1,
          startedAt: null,
          recordedAt: '2023-06-16T12:00:00Z',
          elapsedSeconds: null,
          timerSeconds: 0,
          distanceMeters: null,
          averageHeartRateBpm: null,
          maximumHeartRateBpm: null,
        },
      ],
    },
  });
  const { idempotencyKey, ...body } = command;
  const response = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(response.status()).toBe(200);
  const imported = activityImportResultSchema.parse(await response.json());

  cleanup.set(page, { headers, id: imported.activityId, revision: imported.revision });
  return { headers, imported, command };
}

test('detail tabs preserve URL context and observation interactions while unmounting inactive charts', async ({
  page,
}) => {
  const { imported } = await setup(page);
  const query = new URLSearchParams({
    selected: imported.activityId,
    view: 'table',
    source: 'fixture',
    search: 'Synthetic source workbench',
    sort: 'distance_desc',
    detailTab: 'intervals',
  });
  let writes = 0;
  page.on('request', (request) => {
    if (
      !['GET', 'HEAD'].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith('/bff/v1/')
    )
      writes++;
  });
  await page.goto(`/activities?${query}`);
  const tabs = page.getByRole('tablist', { name: '활동 상세 보기', exact: true }),
    workbench = page.getByRole('region', { name: '원본 관측 워크벤치', exact: true }),
    selection = page.getByRole('region', { name: '관측 선택 요약', exact: true });
  await expect(tabs.getByRole('tab', { name: '구간', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await workbench.getByRole('button', { name: '관측 0 선택', exact: true }).click();
  await expect(selection).toContainText('선택한 관측 0');
  await workbench.getByRole('button', { name: '차트 다음 페이지', exact: true }).click();
  await expect(workbench).toContainText('500–519');
  await workbench.getByLabel('구간 시작 (UTC)', { exact: true }).fill('2023-06-15T12:08:21');
  await workbench.getByLabel('구간 끝 (UTC)', { exact: true }).fill('2023-06-15T12:08:23');
  await workbench.getByRole('button', { name: '구간 적용', exact: true }).click();
  for (const label of ['영향', '출처']) {
    await tabs.getByRole('tab', { name: label, exact: true }).click();
    await expect(page.getByRole('img', { name: '원본 심박 (bpm) 차트', exact: true })).toHaveCount(
      0,
    );
    const params = new URL(page.url()).searchParams;
    for (const [key, value] of query) if (key !== 'detailTab') expect(params.get(key)).toBe(value);
  }
  await expect(page.getByRole('region', { name: '상세 출처', exact: true })).toBeVisible();
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: '영향', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tabs.getByRole('tab', { name: '구간', exact: true }).click();
  await expect(workbench).toContainText('500–519');
  await expect(selection).toContainText('2023-06-15T12:08:21.000Z – 2023-06-15T12:08:23.000Z');
  await expect(workbench.getByLabel('구간 시작 (UTC)', { exact: true })).toHaveValue(
    '2023-06-15T12:08:21',
  );
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(selection).toContainText('2023-06-15T12:08:23.000Z');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await tabs.getByRole('tab', { name: '개요', exact: true }).click();
  await page.reload();
  await expect(tabs.getByRole('tab', { name: '개요', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(new URL(page.url()).searchParams.get('selected')).toBe(imported.activityId);
  await tabs.getByRole('tab', { name: '구간', exact: true }).click();
  await expect(selection).toContainText('선택 구간 없음');
  expect(writes).toBe(0);
});

test('unsupported or invalid detail addresses explain availability and new source revision resets observation selection', async ({
  page,
}) => {
  const { headers, imported, command } = await setup(page);
  const address = (tab: string) => `/activities?selected=${imported.activityId}&detailTab=${tab}`;
  const tabs = page.getByRole('tablist', { name: '활동 상세 보기', exact: true });
  await page.goto(address('overview'));
  for (const label of ['경로', '미디어'])
    await expect(tabs.getByRole('tab', { name: label, exact: true })).toBeDisabled();
  for (const tab of ['route', 'media', 'invalid-tab']) {
    await page.goto(address(tab));
    await expect(page.getByRole('button', { name: '개요로 이동', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '개요로 이동', exact: true }).click();
    await expect(tabs.getByRole('tab', { name: '개요', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(new URL(page.url()).searchParams.get('selected')).toBe(imported.activityId);
  }
  await tabs.getByRole('tab', { name: '구간', exact: true }).click();
  const workbench = page.getByRole('region', { name: '원본 관측 워크벤치', exact: true }),
    selection = page.getByRole('region', { name: '관측 선택 요약', exact: true });
  await workbench.getByRole('button', { name: '관측 0 선택', exact: true }).click();
  await expect(selection).toContainText('선택한 관측 0');
  const { idempotencyKey: _, ...body } = command;
  const changed = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { ...body, source: { ...body.source, revision: 2 } },
  });
  expect(changed.status()).toBe(200);
  const next = activityImportResultSchema.parse(await changed.json());
  cleanup.set(page, { headers, id: imported.activityId, revision: next.revision });
  await page.getByRole('button', { name: '활동 상세 다시 확인', exact: true }).click();
  await expect(selection).toContainText('선택 구간 없음');
  await expect(selection).not.toContainText('선택한 관측 0');
});
