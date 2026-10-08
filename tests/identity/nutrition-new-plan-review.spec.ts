import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  intakeEntriesResponseSchema,
  nutritionPlanVersionSchema,
} from '../../packages/contracts/src/nutrition-core';
import {
  nutritionPlanReadV4Schema,
  nutritionPlansResponseV4Schema,
} from '../../packages/contracts/src/nutrition-race-plan-v4';
import { identityMobileOrigin, identityWebOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';

type Headers = { origin: string; 'x-workout-session-id': string; 'x-csrf-token': string };
const cleanup = new WeakMap<Page, Headers>();
const confirmation =
  '계획 내용을 직접 확인했고 이 버전을 저장합니다. 실제로 먹었다는 뜻은 아닙니다.';

async function login(page: Page, origin: string): Promise<Headers> {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(typeof session === 'object' && session !== null);
  assert.ok('sessionId' in session && typeof session.sessionId === 'string');
  assert.ok('csrfToken' in session && typeof session.csrfToken === 'string');
  const headers = {
    origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  cleanup.set(page, headers);
  await grantAppProcessingForScenario(page);
  return headers;
}

test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (!headers) return;
  cleanup.delete(page);
  const response = await page.request.delete(`${headers.origin}/bff/v1/operations/account`, {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(response.status()).toBe(200);
});

// Real local OIDC + HTTP + UI only. Each Host starts with an empty account;
// cleanup erases that account before the next Alice scenario. No route mocks.
for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: new nutrition draft requires preview then a separate confirmed save`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const headers = await login(page, origin);
    const day = await page.evaluate(() => new Intl.DateTimeFormat('sv-SE').format(new Date()));
    const readPlans = async () => {
      const query = new URLSearchParams({
        from: day,
        toInclusive: day,
        limit: '100',
        maxSchemaVersion: '4',
      });
      const response = await page.request.get(`${origin}/bff/v1/nutrition/plans?${query}`, {
        headers,
      });
      expect(response.status()).toBe(200);
      return nutritionPlansResponseV4Schema.parse(await response.json());
    };
    const readIntakes = async () => {
      const response = await page.request.get(
        `${origin}/bff/v1/nutrition/intakes?${new URLSearchParams({ from: `${day}T00:00:00Z`, toExclusive: `${day}T23:59:59Z`, limit: '100' })}`,
        { headers },
      );
      expect(response.status()).toBe(200);
      return intakeEntriesResponseSchema.parse(await response.json());
    };
    expect((await readPlans()).plans).toEqual([]);
    expect((await readIntakes()).entries).toEqual([]);
    let planWrites = 0;
    let intakeWrites = 0;
    page.on('request', (request) => {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return;
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/bff/v1/nutrition/plans')) planWrites++;
      if (path.startsWith('/bff/v1/nutrition/intakes')) intakeWrites++;
    });
    await page.goto(`${origin}/nutrition`);
    await page.getByRole('link', { name: '새 계획', exact: true }).click();
    await expect(page.getByRole('heading', { name: '새 영양 계획', exact: true })).toBeVisible();
    await expect(page.getByLabel(confirmation, { exact: true })).toHaveCount(0);
    const purpose = `Synthetic new nutrition ${host} ${randomUUID()}`;
    await page.getByLabel('계획 목적', { exact: true }).fill(purpose);
    await page.getByLabel('시작 날짜', { exact: true }).fill(day);
    await page.getByLabel('종료 날짜', { exact: true }).fill(day);
    await page.getByRole('button', { name: '항목 추가', exact: true }).click();
    await page.getByLabel('항목 이름', { exact: true }).fill('합성 식사 계획');
    await page
      .getByLabel('시간·행동 계획 (선택)', { exact: true })
      .fill('합성 식사 계획을 확인한다');
    await page.getByRole('button', { name: '계획 미리보기', exact: true }).click();
    const review = page.getByRole('region', { name: '저장 전 계획 미리보기' });
    await expect(review).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '저장 전 계획 미리보기', exact: true }),
    ).toBeFocused();
    await expect(review.getByText(purpose, { exact: true })).toBeVisible();
    for (const width of [320, 767, 768, 1279, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(review).toBeVisible();
      await expect(review.getByText(purpose, { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    await expect(page.getByLabel('계획 목적', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '확인한 계획 저장', exact: true }),
    ).toBeDisabled();
    await page.getByLabel(confirmation, { exact: true }).check();
    await page.getByRole('button', { name: '편집으로 돌아가기', exact: true }).click();
    await expect(page.getByLabel('계획 목적', { exact: true })).toHaveValue(purpose);
    await expect(page.getByLabel('계획 목적', { exact: true })).toBeFocused();
    await expect(page.getByLabel('항목 이름', { exact: true })).toHaveValue('합성 식사 계획');
    await expect(page.getByLabel('시간·행동 계획 (선택)', { exact: true })).toHaveValue(
      '합성 식사 계획을 확인한다',
    );
    await page.getByRole('button', { name: '계획 미리보기', exact: true }).click();
    await expect(page.getByLabel(confirmation, { exact: true })).not.toBeChecked();
    await expect(
      page.getByRole('button', { name: '확인한 계획 저장', exact: true }),
    ).toBeDisabled();
    expect(planWrites).toBe(0);
    expect((await readPlans()).plans).toEqual([]);
    expect((await readIntakes()).entries).toEqual([]);
    await page.getByLabel(confirmation, { exact: true }).check();
    const savedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === '/bff/v1/nutrition/plans' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '확인한 계획 저장', exact: true }).click();
    const response = await savedResponse;
    expect(response.status()).toBe(200);
    const saved = nutritionPlanVersionSchema.parse(await response.json());
    // V1 is the strict untagged legacy DTO, not a synthesized schemaVersion field.
    expect(saved.version).toBe(1);
    expect(saved.purpose).toBe(purpose);
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({
      title: '합성 식사 계획',
      instructions: '합성 식사 계획을 확인한다',
      foods: [],
      targets: [],
    });
    await expect(page).toHaveURL(`${origin}/nutrition/plans/${saved.planId}`);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '영양 계획 · 버전 1', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('계획 목적', { exact: true })).toHaveValue(purpose);
    const detailResponse = await page.request.get(
      `${origin}/bff/v1/nutrition/plans/${saved.planId}?maxSchemaVersion=4`,
      { headers },
    );
    expect(detailResponse.status()).toBe(200);
    const detail = nutritionPlanReadV4Schema.parse(await detailResponse.json());
    expect(detail.head).toEqual(saved);
    expect(detail.history).toEqual([
      { versionId: saved.versionId, version: 1, approvedAt: saved.approvedAt },
    ]);
    expect((await readPlans()).plans).toEqual([saved]);
    expect((await readIntakes()).entries).toEqual([]);
    expect(planWrites).toBe(1);
    expect(intakeWrites).toBe(0);
  });
}
