import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  checkInCommandResultSchema,
  checkInSchema,
  checkInListSchema,
} from '../../packages/contracts/src/check-ins';

const url = '/wellbeing?from=2024-03-10&toExclusive=2024-03-11';
async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const session: unknown = await (await page.request.get('/bff/v1/session')).json();
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
const cleanup = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (!headers) return;
  cleanup.delete(page);
  const result = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(result.status()).toBe(200);
});
async function seed(page: Page, count: number) {
  const headers = await login(page);
  cleanup.set(page, headers);
  const created = [];
  for (let index = 0; index < count; index++) {
    // Same reported local day, multiple observations, with UTC instants crossing the US DST jump.
    const observedAt = new Date(Date.parse('2024-03-10T05:30:00Z') + index * 60000).toISOString();
    const values = {
      observedAt,
      timezone: 'America/New_York',
      fatigue: index % 2 === 0 ? 0 : null,
      discomfort: index % 2 === 0 ? null : 0,
      bodyLocation: null,
      note: `Synthetic trend ${index}`,
    };
    const response = await page.request.post('/bff/v1/check-ins', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { values },
    });
    expect(response.status()).toBe(200);
    created.push({ ...checkInCommandResultSchema.parse(await response.json()), values });
  }
  return { headers, created };
}

test('trend pages retain every observation, zero and unknown independently of the record list and responsive draft', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { headers, created } = await seed(page, 101);
  const firstPageResponse = await page.request.get(
    '/bff/v1/check-ins?from=2024-03-10&toExclusive=2024-03-11&limit=100&offset=0',
    { headers },
  );
  expect(firstPageResponse.status()).toBe(200);
  const firstPage = checkInListSchema.parse(await firstPageResponse.json());
  const nextPageResponse = await page.request.get(
    '/bff/v1/check-ins?from=2024-03-10&toExclusive=2024-03-11&limit=100&offset=100',
    { headers },
  );
  expect(nextPageResponse.status()).toBe(200);
  const nextPage = checkInListSchema.parse(await nextPageResponse.json());
  expect([...firstPage.items, ...nextPage.items].map((item) => item.id).sort()).toEqual(
    created.map((item) => item.id).sort(),
  );
  const fatigueCount = firstPage.items.filter((item) => item.values.fatigue !== null).length;
  const discomfortCount = firstPage.items.filter((item) => item.values.discomfort !== null).length;
  const selectedRecord = firstPage.items.find((item) => item.values.fatigue === 0),
    nextRecord = nextPage.items[0];
  assert.ok(selectedRecord && nextRecord && selectedRecord.values.note);
  const expectedFirstLabels = [...firstPage.items]
    .sort((a, b) => Date.parse(a.values.observedAt) - Date.parse(b.values.observedAt))
    .map((item) => `추세 기록 상세 보기 · ${item.values.observedAt} · ${item.id}`);
  await page.goto(url);
  const trend = page.getByRole('region', { name: '체크인 추세', exact: true });
  const buttons = trend.getByRole('button', { name: /^추세 기록 상세 보기 · / });
  await expect(buttons).toHaveCount(100);
  await expect(
    trend.getByText('부분 조회: 현재 100개 / 전체 101개', { exact: true }),
  ).toBeVisible();
  await expect(
    trend.getByRole('img', { name: `피로 관측점 ${fatigueCount}개 · 0~10 척도`, exact: true }),
  ).toBeVisible();
  await expect(
    trend.getByRole('img', { name: `불편감 관측점 ${discomfortCount}개 · 0~10 척도`, exact: true }),
  ).toBeVisible();
  expect(
    await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
  ).toEqual(expectedFirstLabels);
  const read = await page.request.get(`/bff/v1/check-ins/${selectedRecord.id}`, { headers });
  expect(checkInSchema.parse(await read.json())).toMatchObject({
    localDate: '2024-03-10',
    values: { fatigue: 0, discomfort: null, timezone: 'America/New_York' },
  });
  await expect(
    trend.getByRole('button', {
      name: `추세 기록 상세 보기 · ${selectedRecord.values.observedAt} · ${selectedRecord.id}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    trend.getByRole('button', {
      name: `추세 기록 상세 보기 · ${nextRecord.values.observedAt} · ${nextRecord.id}`,
      exact: true,
    }),
  ).toHaveCount(0);
  const selectedRow = trend
    .getByRole('button', {
      name: `추세 기록 상세 보기 · ${selectedRecord.values.observedAt} · ${selectedRecord.id}`,
      exact: true,
    })
    .locator('xpath=ancestor::tr');
  await expect(selectedRow.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(selectedRow.getByRole('cell', { name: '미보고', exact: true })).toBeVisible();
  await expect(
    selectedRow.getByRole('cell', { name: 'America/New_York', exact: true }),
  ).toBeVisible();
  const note = page.getByRole('textbox', { name: '체크인 메모', exact: true });
  await note.fill('미저장 추세 확인 메모');
  await page.getByRole('button', { name: '다음 기록', exact: true }).click();
  await expect(page).toHaveURL(/offset=20/);
  await expect(buttons).toHaveCount(100);
  await trend.getByRole('button', { name: '추세 다음 페이지', exact: true }).click();
  await expect(page).toHaveURL(/trendOffset=100/);
  await expect(buttons).toHaveCount(1);
  await expect(
    trend.getByRole('button', {
      name: `추세 기록 상세 보기 · ${nextRecord.values.observedAt} · ${nextRecord.id}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('offset')).toBe('20');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(note).toHaveValue('미저장 추세 확인 메모');
  await expect(page.locator('body')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await trend.getByRole('button', { name: '추세 이전 페이지', exact: true }).click();
  await expect(buttons).toHaveCount(100);
  await expect(note).toHaveValue('미저장 추세 확인 메모');
  await page.setViewportSize({ width: 1280, height: 900 });
  await trend
    .getByRole('button', {
      name: `추세 기록 상세 보기 · ${selectedRecord.values.observedAt} · ${selectedRecord.id}`,
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole('region', { name: '선택한 체크인', exact: true })
      .getByText(selectedRecord.values.note, { exact: true }),
  ).toBeVisible();
});

test('trend refresh reflects corrections and deletion and recovers explicitly from a failed trend read', async ({
  page,
}) => {
  const { headers, created } = await seed(page, 2),
    target = created[1];
  assert.ok(target);
  await page.goto(url);
  const trend = page.getByRole('region', { name: '체크인 추세', exact: true }),
    buttons = trend.getByRole('button', { name: /^추세 기록 상세 보기 · / });
  await expect(buttons).toHaveCount(2);
  const changedValues = {
    ...target.values,
    fatigue: 7,
    discomfort: null,
    note: '정정된 합성 추세',
  };
  const update = await page.request.put(`/bff/v1/check-ins/${target.id}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: 1, reason: 'Correct synthetic report', values: changedValues },
  });
  expect(update.status()).toBe(200);
  const corrected = checkInCommandResultSchema.parse(await update.json());
  await trend.getByRole('button', { name: '추세 다시 확인', exact: true }).click();
  const row = trend
    .getByRole('button', {
      name: `추세 기록 상세 보기 · ${target.values.observedAt} · ${target.id}`,
      exact: true,
    })
    .locator('xpath=ancestor::tr');
  await expect(row).toContainText('7');
  await page.route('**/bff/v1/check-ins?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '100')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Synthetic trend read failure' },
        }),
      });
    else await route.continue();
  });
  await trend.getByRole('button', { name: '추세 다시 확인', exact: true }).click();
  await expect(trend.getByRole('alert')).toBeVisible();
  await page.unroute('**/bff/v1/check-ins?**');
  await trend.getByRole('button', { name: '추세 다시 확인', exact: true }).click();
  await expect(buttons).toHaveCount(2);
  await expect(trend.getByRole('alert')).toHaveCount(0);
  const removed = await page.request.delete(`/bff/v1/check-ins/${target.id}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: corrected.revision },
  });
  expect(removed.status()).toBe(200);
  await trend.getByRole('button', { name: '추세 다시 확인', exact: true }).click();
  await expect(buttons).toHaveCount(1);
  await expect(
    trend.getByRole('button', {
      name: `추세 기록 상세 보기 · ${target.values.observedAt} · ${target.id}`,
      exact: true,
    }),
  ).toHaveCount(0);
});
