import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activitySchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

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

// S09 / V2-F13: actual API/DB source observations; selection is a read-only client interaction.
test('source chart and laps share bounded selection across responsive layouts without writes', async ({
  page,
}) => {
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
  let revision = imported.revision;
  try {
    const corrected = await page.request.patch(`/bff/v1/activities/${imported.activityId}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: revision,
        startedAt: '2024-01-01T00:00:00Z',
        timezone: 'UTC',
        reason: 'Synthetic source clock remains unchanged',
      },
    });
    expect(corrected.status()).toBe(200);
    revision = activitySchema.parse(await corrected.json()).revision;
    let writes = 0;
    page.on('request', (request) => {
      if (
        !['GET', 'HEAD'].includes(request.method()) &&
        new URL(request.url()).pathname.startsWith('/bff/v1/')
      )
        writes++;
    });
    await page.goto(`/activities?selected=${imported.activityId}&detailTab=intervals`);
    const workbench = page.getByRole('region', { name: '원본 관측 워크벤치', exact: true });
    const selection = workbench.getByRole('region', { name: '관측 선택 요약', exact: true });
    await expect(workbench).toBeVisible();
    await expect(workbench).toContainText('전체 520개 중 500개 표시');
    await expect(
      workbench.getByRole('table', { name: '원본 관측 표' }).getByRole('row'),
    ).toHaveCount(21);
    const firstRecord = workbench.getByRole('button', { name: '관측 0 선택', exact: true });
    await firstRecord.focus();
    await firstRecord.press('Enter');
    await expect(selection).toContainText('선택한 관측 0');
    await expect(selection).toContainText('거리 0 m · 심박 0 bpm');
    await expect(selection).toContainText('2023-06-15T12:00:00.000Z');
    await expect(selection).not.toContainText('2024-01-01');
    await workbench.getByRole('button', { name: '랩', exact: true }).click();
    await workbench.getByRole('button', { name: '랩 0 선택', exact: true }).click();
    await expect(selection).toContainText('2023-06-15T12:00:10.000Z');
    await expect(selection).toContainText('경과 시간 10 초 · 타이머 시간 8 초');
    await expect(selection).not.toContainText('2023-06-16');
    await workbench.getByRole('button', { name: '관측 개요', exact: true }).click();
    await expect(selection).toContainText('선택한 랩 0');
    const heartChart = workbench.getByRole('img', { name: '원본 심박 (bpm) 차트', exact: true });
    await expect(heartChart).toBeVisible();
    await expect(heartChart.locator('circle[data-in-range="true"]')).toHaveCount(9);
    await workbench.getByRole('button', { name: '차트 다음 페이지', exact: true }).click();
    await expect(workbench).toContainText('500–519');
    await expect(workbench).toContainText('전체 520개 중 20개 표시');
    await expect(selection).toContainText('선택한 랩 0');
    await workbench.getByRole('button', { name: '차트 이전 페이지', exact: true }).click();
    const rangeStart = workbench.getByLabel('구간 시작 (UTC)', { exact: true });
    await rangeStart.fill('2023-06-15T12:00:04');
    await workbench.getByLabel('구간 끝 (UTC)', { exact: true }).fill('2023-06-15T12:00:06');
    await workbench.getByRole('button', { name: '구간 적용', exact: true }).click();
    await expect(selection).toContainText('2023-06-15T12:00:04.000Z – 2023-06-15T12:00:06.000Z');
    await expect(heartChart.locator('circle[data-in-range="true"]')).toHaveCount(3);
    await rangeStart.focus();
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(rangeStart).toBeFocused();
      await expect(rangeStart).toHaveValue('2023-06-15T12:00:04');
      await expect(selection).toContainText('2023-06-15T12:00:06.000Z');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith(`/activities/${imported.activityId}/context`),
      ),
      page.waitForResponse((response) =>
        response.url().endsWith(`/activities/${imported.activityId}/details`),
      ),
      page.getByRole('button', { name: '활동 상세 다시 확인', exact: true }).click(),
    ]);
    await expect(workbench).toBeVisible();
    await expect(selection).toContainText('2023-06-15T12:00:04.000Z – 2023-06-15T12:00:06.000Z');
    await expect(rangeStart).toHaveValue('2023-06-15T12:00:04');
    await workbench.getByRole('button', { name: '랩', exact: true }).click();
    await expect(
      workbench.getByRole('table', { name: '원본 랩 표' }).locator('tr[data-in-range="true"]'),
    ).toHaveCount(1);
    await workbench.getByRole('button', { name: '랩 1 선택', exact: true }).click();
    await expect(selection).toContainText(
      '시작 시각 또는 경과 시간이 없어 랩 구간을 표시할 수 없습니다.',
    );
    await page
      .getByRole('tablist', { name: '활동 상세 보기', exact: true })
      .getByRole('tab', { name: '출처', exact: true })
      .click();
    await expect(page.getByRole('region', { name: '상세 출처', exact: true })).toContainText(
      command.source.sourceId,
    );
    expect(
      await page.evaluate((marker) => {
        const values = (storage: Storage) =>
          Array.from({ length: storage.length }, (_, index) =>
            storage.getItem(storage.key(index) ?? ''),
          );
        return [...values(localStorage), ...values(sessionStorage)].some((value) =>
          value?.includes(marker),
        );
      }, command.source.sourceId),
    ).toBe(false);
    await page
      .getByRole('tablist', { name: '활동 상세 보기', exact: true })
      .getByRole('tab', { name: '구간', exact: true })
      .click();
    await page.reload();
    await expect(workbench).toBeVisible();
    await expect(selection).toContainText('선택 구간 없음');
    expect(writes).toBe(0);
  } finally {
    const deleted = await page.request.delete(`/bff/v1/activities/${imported.activityId}`, {
      headers,
      data: { expectedRevision: revision },
    });
    expect(deleted.status()).toBe(204);
  }
});
