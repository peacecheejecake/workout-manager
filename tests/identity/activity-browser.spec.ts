import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  type ActivityImport,
  type ActivityImportResult,
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

async function seedActivities(
  page: Page,
  headers: Awaited<ReturnType<typeof login>>,
  paginated = false,
) {
  const prefix = `activity-browser-${randomUUID()}`;
  const created: ActivityImportResult[] = [];
  const add = async (
    suffix: string,
    values: Partial<ActivityImport['activity']>,
    source = 'fixture',
  ) => {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: { kind: source, sourceId: randomUUID(), revision: 1, contentHash: 'b'.repeat(64) },
        activity: {
          title: `${prefix} ${suffix}`,
          kind: 'running',
          startedAt: null,
          timezone: 'UTC',
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: null,
          ...values,
        },
      },
    });
    expect(response.status()).toBe(200);
    const result = activityImportResultSchema.parse(await response.json());
    created.push(result);
    return result;
  };
  const zero = await add('zero', {
    startedAt: '2022-08-03T12:00:00Z',
    distanceMeters: 0,
    durationSeconds: 0,
    durationKind: 'timer',
  });
  const missing = await add('missing', {});
  const cycling = await add(
    'cycling',
    {
      kind: 'cycling',
      startedAt: '2022-08-03T13:00:00Z',
      distanceMeters: 2500,
      durationSeconds: 120,
      durationKind: 'moving',
    },
    'fit',
  );
  if (paginated) {
    for (let index = 0; index < 18; index++) {
      await add(`earlier-${String(index).padStart(2, '0')}`, {
        startedAt: `2022-08-02T12:${String(index).padStart(2, '0')}:00Z`,
        distanceMeters: 100,
      });
    }
  }
  return {
    prefix,
    zero,
    missing,
    cycling,
    url: `/activities?${new URLSearchParams({ search: prefix, sort: 'started_desc', view: 'table' })}`,
    async cleanup() {
      for (const record of created) {
        const response = await page.request.delete(`/bff/v1/activities/${record.activityId}`, {
          headers,
          data: { expectedRevision: record.revision },
        });
        expect(response.status()).toBe(204);
      }
    },
  };
}

test('activity browser keeps independent selected details through paging, filters, history and reload', async ({
  page,
}) => {
  const headers = await login(page);
  const records = await seedActivities(page, headers, true);
  try {
    await page.goto(records.url);
    const workspace = page.getByRole('region', { name: '활동 검색과 조회', exact: true });
    const table = page.getByRole('table', { name: '조회 조건에 맞는 활동', exact: true });
    await expect(
      workspace.getByText('조회 조건에 맞는 활동 21개 · 현재 페이지 20개', { exact: true }),
    ).toBeVisible();
    await expect(table.getByRole('rowheader').nth(0)).toHaveText(`${records.prefix} cycling`);
    await expect(table.getByRole('rowheader').nth(1)).toHaveText(`${records.prefix} zero`);
    await table.getByRole('button', { name: `${records.prefix} zero`, exact: true }).click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('selected') === records.zero.activityId,
    );
    const detail = page.getByRole('region', { name: '선택한 활동 상세', exact: true });
    const effective = detail.getByRole('region', { name: '정정 반영 기록', exact: true });
    await expect(effective.getByText(`${records.prefix} zero`, { exact: true })).toBeVisible();
    await expect(effective.getByText('0m', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '다음 활동', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('offset') === '20');
    await expect(
      workspace.getByText('조회 조건에 맞는 활동 21개 · 현재 페이지 1개', { exact: true }),
    ).toBeVisible();
    await expect(table.getByRole('rowheader')).toHaveText([`${records.prefix} missing`]);
    await expect(effective.getByText(`${records.prefix} zero`, { exact: true })).toBeVisible();
    const detailResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/bff/v1/activities/${records.zero.activityId}/context` &&
        response.request().method() === 'GET',
    );
    await page.reload();
    expect((await detailResponse).status()).toBe(200);
    await expect(table.getByRole('rowheader')).toHaveText([`${records.prefix} missing`]);
    await expect(effective.getByText(`${records.prefix} zero`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '이전 활동', exact: true }).click();
    await expect(
      workspace.getByText('조회 조건에 맞는 활동 21개 · 현재 페이지 20개', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: '활동 정렬', exact: true })
      .selectOption('distance_asc');
    await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('sort') === 'distance_asc');
    await expect(table.getByRole('rowheader').nth(0)).toHaveText(`${records.prefix} zero`);

    await page
      .getByRole('textbox', { name: '활동 제목 검색', exact: true })
      .fill(`${records.prefix} cycling`);
    await page.getByLabel('활동 시작일', { exact: true }).fill('2022-08-03');
    await page.getByLabel('활동 종료일 (이 날짜 제외)', { exact: true }).fill('2022-08-04');
    await page.getByRole('textbox', { name: '날짜 조회 시간대', exact: true }).fill('UTC');
    await page.getByRole('combobox', { name: '종목 필터', exact: true }).selectOption('cycling');
    await page.getByRole('combobox', { name: '출처 필터', exact: true }).selectOption('fit');
    await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('search') === `${records.prefix} cycling` &&
        url.searchParams.get('from') === '2022-08-03' &&
        url.searchParams.get('toExclusive') === '2022-08-04' &&
        url.searchParams.get('timezone') === 'UTC' &&
        url.searchParams.get('kind') === 'cycling' &&
        url.searchParams.get('source') === 'fit' &&
        url.searchParams.get('selected') === records.zero.activityId,
    );
    await expect(table.getByRole('rowheader')).toHaveText([`${records.prefix} cycling`]);
    await expect(effective.getByText(`${records.prefix} zero`, { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('textbox', { name: '활동 제목 검색', exact: true })).toHaveValue(
      records.prefix,
    );
    await expect(page.getByRole('combobox', { name: '출처 필터', exact: true })).toHaveValue('');
    await expect(table.getByRole('rowheader')).toHaveCount(20);
    await expect(table.getByRole('rowheader').nth(0)).toHaveText(`${records.prefix} zero`);
    await page.goto(`${records.url}&from=2022-08-03`);
    await expect(workspace.getByRole('alert')).toContainText('조회 주소를 확인하세요.');
    await expect(table).toBeHidden();
    await page.getByRole('button', { name: '날짜 조건 지우기', exact: true }).click();
    await expect(workspace.getByRole('alert')).toBeHidden();
    await expect(table.getByRole('rowheader')).toHaveCount(20);
  } finally {
    await records.cleanup();
  }
});

test('activity cards and table preserve unknowns and zero, reflow and recover from stale list failures', async ({
  page,
}) => {
  const headers = await login(page);
  const records = await seedActivities(page, headers);
  try {
    const listRequests = '**/bff/v1/activities?**';
    await page.route(listRequests, (route) => route.abort('failed'));
    await page.goto(records.url);
    const workspace = page.getByRole('region', { name: '활동 검색과 조회', exact: true });
    const alert = workspace.getByRole('alert');
    const table = page.getByRole('table', { name: '조회 조건에 맞는 활동', exact: true });
    await expect(alert).toContainText('목록을 불러오지 못했습니다.');
    await expect(table).toBeHidden();
    await page.unroute(listRequests);
    await page.getByRole('button', { name: '활동 목록 다시 확인', exact: true }).click();
    await expect(table.getByRole('rowheader')).toHaveText([
      `${records.prefix} cycling`,
      `${records.prefix} zero`,
      `${records.prefix} missing`,
    ]);
    const zeroRow = table
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: `${records.prefix} zero`, exact: true }) });
    const missingRow = table.getByRole('row').filter({
      has: page.getByRole('button', { name: `${records.prefix} missing`, exact: true }),
    });
    await expect(zeroRow.getByRole('cell').nth(2)).toHaveText('0m');
    await expect(zeroRow.getByRole('cell').nth(3)).toHaveText('0초 · 타이머 시간 (timer)');
    await expect(missingRow.getByRole('cell').nth(2)).toHaveText('거리 미확인');
    await expect(missingRow.getByRole('cell').nth(3)).toHaveText(
      '시간 미확인 · 정의 미확인 시간 (unknown)',
    );
    await page.getByRole('button', { name: '카드 보기', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === 'cards');
    await expect(table).toBeHidden();
    const zeroCard = page
      .getByRole('article')
      .filter({ has: page.getByRole('button', { name: `${records.prefix} zero`, exact: true }) });
    const missingCard = page.getByRole('article').filter({
      has: page.getByRole('button', { name: `${records.prefix} missing`, exact: true }),
    });
    await expect(zeroCard).toContainText('0m · 0초 · 타이머 시간 (timer)');
    await expect(missingCard).toContainText(
      '거리 미확인 · 시간 미확인 · 정의 미확인 시간 (unknown)',
    );
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(zeroCard).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.getByRole('button', { name: '표 보기', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === 'table');
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(table).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.setViewportSize(viewportFixtures[0]);
    const scrollRegion = page.getByRole('region', { name: '활동 표 가로 탐색', exact: true });
    const right = page.getByRole('button', { name: '활동 표 오른쪽으로 이동', exact: true });
    const left = page.getByRole('button', { name: '활동 표 왼쪽으로 이동', exact: true });
    const regionId = await scrollRegion.getAttribute('id');
    assert.ok(regionId);
    await expect(right).toHaveAttribute('aria-controls', regionId);
    await expect(left).toHaveAttribute('aria-controls', regionId);
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
    await page.route(listRequests, (route) => route.abort('failed'));
    await page.getByRole('button', { name: '활동 목록 다시 확인', exact: true }).click();
    await expect(alert).toContainText('아래는 마지막 조회 결과');
    await expect(table.getByRole('rowheader')).toHaveCount(3);
    await page.unroute(listRequests);
    await page.getByRole('button', { name: '활동 목록 다시 확인', exact: true }).click();
    await expect(alert).toBeHidden();
    await expect(table.getByRole('rowheader')).toHaveCount(3);
  } finally {
    await records.cleanup();
  }
});
