import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  type ActivityImportResult,
} from '../../packages/contracts/src/activity';
import { checkInCommandResultSchema } from '../../packages/contracts/src/check-ins';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

const anchor = '2023-04-14';
const dashboardUrl = `/dashboard?anchor=${anchor}&window=3&timezone=UTC`;

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

async function seedReports(page: Page, headers: Awaited<ReturnType<typeof login>>) {
  const activities: ActivityImportResult[] = [];
  for (const [startedAt, distanceMeters] of [
    ['2023-04-13T12:00:00Z', null],
    ['2023-04-14T12:00:00Z', 0],
  ] as const) {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'e'.repeat(64),
        },
        activity: {
          title: 'Synthetic dashboard UI activity',
          kind: 'running',
          startedAt,
          timezone: 'UTC',
          distanceMeters,
          durationSeconds: distanceMeters,
          durationKind: distanceMeters === null ? 'unknown' : 'timer',
        },
      },
    });
    expect(response.status()).toBe(200);
    activities.push(activityImportResultSchema.parse(await response.json()));
  }
  const note = `Synthetic dashboard UI check-in ${randomUUID()}`;
  const response = await page.request.post('/bff/v1/check-ins', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      values: {
        observedAt: '2023-04-14T16:00:00Z',
        timezone: 'Asia/Seoul',
        fatigue: 0,
        discomfort: null,
        bodyLocation: null,
        note,
      },
    },
  });
  expect(response.status()).toBe(200);
  const checkIn = checkInCommandResultSchema.parse(await response.json());
  return {
    note,
    checkInId: checkIn.id,
    async cleanup() {
      for (const activity of activities) {
        const removed = await page.request.delete(`/bff/v1/activities/${activity.activityId}`, {
          headers,
          data: { expectedRevision: activity.revision },
        });
        expect(removed.status()).toBe(204);
      }
      const removed = await page.request.delete(`/bff/v1/check-ins/${checkIn.id}`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { expectedRevision: checkIn.revision },
      });
      expect(removed.status()).toBe(200);
    },
  };
}

test('empty dashboard keeps missing data explicit and URL periods follow presets, history and validation', async ({
  page,
}) => {
  await login(page);
  await page.goto(dashboardUrl);
  await expect(page.getByRole('heading', { name: '오늘과 최근 기록', exact: true })).toBeVisible();
  const current = page.getByRole('region', { name: '현재 기간', exact: true });
  await expect(
    current.getByRole('heading', { name: '실제 수행 · 0개', exact: true }),
  ).toBeVisible();
  await expect(
    current.getByText('거리: 미보고 · 알려진 0개 · 미보고 0개', { exact: true }),
  ).toHaveCount(1);
  await expect(
    current.getByText('거리: 미보고 · 알려진 0개 · 미보고 0개 · 범위 목표 0개', { exact: true }),
  ).toBeVisible();
  await expect(current.getByText(/^거리: 0m/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '최신 체크인', exact: true })).toContainText(
    '조회 범위에서 확인된 체크인이 없습니다.',
  );
  await expect(
    page.getByRole('region', { name: '확인할 수 없는 정보', exact: true }),
  ).toContainText('OAuth 연결 승인은 동기화 성공이 아닙니다.');
  const table = page.getByRole('table', { name: '날짜별 거리와 보고 현황', exact: true });
  await expect(table.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: '7일', exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('window') === '7');
  await expect(page.getByRole('button', { name: '7일', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(table.getByRole('row')).toHaveCount(8);
  await page.goBack();
  await expect(page).toHaveURL((url) => url.searchParams.get('window') === '3');
  await expect(page.getByRole('spinbutton', { name: '조회 일수', exact: true })).toHaveValue('3');
  await expect(table.getByRole('row')).toHaveCount(4);
  await page.getByRole('spinbutton', { name: '조회 일수', exact: true }).fill('14');
  await page.getByRole('button', { name: '조회 적용', exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('window') === '14');
  await expect(table.getByRole('row')).toHaveCount(15);
  await page.goto(`/dashboard?anchor=${anchor}&window=91&timezone=UTC`);
  await expect(
    page.getByRole('region', { name: '오늘과 최근 기록', exact: true }).getByRole('alert'),
  ).toContainText('3~90일의 조회 기간을 확인하세요.');
  await expect(table).toBeHidden();
  await page.getByRole('spinbutton', { name: '조회 일수', exact: true }).fill('3');
  await page.getByRole('button', { name: '조회 적용', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(4);
});

test('dashboard graph and table preserve known zero, missing values and check-in identity across reflow', async ({
  page,
}) => {
  const headers = await login(page);
  const reports = await seedReports(page, headers);
  try {
    await page.goto(dashboardUrl);
    const current = page.getByRole('region', { name: '현재 기간', exact: true });
    await expect(
      current.getByRole('heading', { name: '실제 수행 · 2개', exact: true }),
    ).toBeVisible();
    await expect(current.getByRole('heading', { name: '계획 · 0개', exact: true })).toBeVisible();
    await expect(
      current.getByText('거리: 0m · 알려진 1개 · 미보고 1개', { exact: true }),
    ).toBeVisible();
    await expect(
      current.getByText('거리: 미보고 · 알려진 0개 · 미보고 0개 · 범위 목표 0개', { exact: true }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: '날짜별 거리와 보고 현황', exact: true });
    await expect(table.getByRole('row')).toHaveCount(4);
    const zeroRow = table
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: '2023-04-14 계획', exact: true }) });
    const unknownRow = table
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: '2023-04-13 계획', exact: true }) });
    await expect(zeroRow.getByRole('cell').nth(0)).toHaveText(
      '미보고 · 알려진 0개 · 미보고 0개 · 범위 목표 0개',
    );
    await expect(zeroRow.getByRole('cell').nth(1)).toHaveText('0m · 알려진 1개 · 미보고 0개');
    await expect(unknownRow.getByRole('cell').nth(1)).toHaveText(
      '미보고 · 알려진 0개 · 미보고 1개',
    );
    const chart = page.getByRole('img', { name: '날짜별 계획·실제 거리', exact: true });
    await expect(chart).toBeVisible();
    await expect(chart.locator('[data-series="actual"]')).toHaveCount(1);
    await expect(chart.locator('[data-series="actual"][data-date="2023-04-14"]')).toHaveAttribute(
      'data-value',
      '0',
    );
    await expect(chart.locator('[data-series="actual"][data-date="2023-04-13"]')).toHaveCount(0);
    await expect(chart.locator('[data-series="planned"]')).toHaveCount(0);
    expect(
      (await chart.locator('g > title').allTextContents()).map((title) => title.slice(0, 10)),
    ).toEqual(['2023-04-12', '2023-04-13', '2023-04-14']);
    await expect(table.getByRole('rowheader')).toHaveText([
      '2023-04-12 계획',
      '2023-04-13 계획',
      '2023-04-14 계획',
    ]);
    const latest = page.getByRole('region', { name: '최신 체크인', exact: true });
    await expect(latest.getByText(reports.note, { exact: true })).toBeVisible();
    await expect(latest).toContainText('저장된 현지 날짜: 2023-04-15');
    await expect(latest).toContainText('피로 0 · 불편감 보고하지 않음');
    await expect(zeroRow.getByRole('cell').nth(3)).toHaveText('1');
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(table).toBeVisible();
      await expect(chart).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.setViewportSize(viewportFixtures[0]);
    for (const controls of [
      { label: '그래프', region: '거리 그래프 가로 탐색' },
      { label: '표', region: '날짜별 기록 표 가로 탐색' },
    ]) {
      const scrollRegion = page.getByRole('region', { name: controls.region, exact: true });
      const right = page.getByRole('button', {
        name: `${controls.label} 오른쪽으로 이동`,
        exact: true,
      });
      const left = page.getByRole('button', {
        name: `${controls.label} 왼쪽으로 이동`,
        exact: true,
      });
      const regionId = await scrollRegion.getAttribute('id');
      assert.ok(regionId);
      await expect(right).toHaveAttribute('aria-controls', regionId);
      await expect(left).toHaveAttribute('aria-controls', regionId);
      await expect.poll(() => scrollRegion.evaluate((element) => element.scrollLeft)).toBe(0);
      await right.focus();
      await page.keyboard.press('Enter');
      await expect(right).toBeFocused();
      await expect
        .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      const afterRight = await scrollRegion.evaluate((element) => element.scrollLeft);
      await left.focus();
      await page.keyboard.press('Space');
      await expect(left).toBeFocused();
      await expect
        .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
        .toBeLessThan(afterRight);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const link = latest.getByRole('link', { name: '이 체크인 상세 보기', exact: true });
    const href = await link.getAttribute('href');
    assert.ok(href);
    const destination = new URL(href, page.url());
    expect(destination.pathname).toBe('/wellbeing');
    expect(destination.searchParams.get('selected')).toBe(reports.checkInId);
    await link.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('selected') === reports.checkInId);
    const selected = page.getByRole('region', { name: '선택한 체크인', exact: true });
    await expect(selected.getByText(reports.note, { exact: true })).toBeVisible();
    await expect(selected.getByText('2023-04-15', { exact: true })).toBeVisible();
  } finally {
    await reports.cleanup();
  }
});

test('dashboard request failure recovers against the real API and labels a failed refresh as stale', async ({
  page,
}) => {
  await login(page);
  const dashboardRequests = '**/bff/v1/dashboard?**';
  await page.route(dashboardRequests, (route) => route.abort('failed'));
  await page.goto(dashboardUrl);
  const alert = page
    .getByRole('region', { name: '오늘과 최근 기록', exact: true })
    .getByRole('alert');
  await expect(alert).toContainText('기록을 불러오지 못했습니다.');
  const table = page.getByRole('table', { name: '날짜별 거리와 보고 현황', exact: true });
  await expect(table).toBeHidden();
  await page.unroute(dashboardRequests);
  await page.getByRole('button', { name: '최신 상태 다시 확인', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(page.getByText('최신 확인 실패.', { exact: false })).toBeHidden();
  await page.route(dashboardRequests, (route) => route.abort('failed'));
  await page.getByRole('button', { name: '최신 상태 다시 확인', exact: true }).click();
  await expect(alert).toContainText('아래는 마지막으로 확인한 기록');
  await expect(table.getByRole('row')).toHaveCount(4);
  await page.unroute(dashboardRequests);
  await page.getByRole('button', { name: '최신 상태 다시 확인', exact: true }).click();
  await expect(page.getByText('최신 확인 실패.', { exact: false })).toBeHidden();
  await expect(table.getByRole('row')).toHaveCount(4);
});
