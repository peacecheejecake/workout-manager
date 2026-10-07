import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  raceCommandResultSchema,
  raceResultValuesSchema,
} from '../../packages/contracts/src/race-commands';
import { raceResultListPageSchema } from '../../packages/contracts/src/race-queries';
import { responsiveSpec } from '../../packages/ui/foundation/src/responsive';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';
import { shells, type Headers } from './course-editor-support';

// Actual canonical OIDC/API/PostgreSQL acceptance, not intercepted transport or
// a second PB algorithm. All records below are synthetic user-entered actuals.
// Run in the disposable identity fixture; this spec never starts a database.
const tabletStart = responsiveSpec.modes[1].minInclusive;
const desktopStart = responsiveSpec.modes[2].minInclusive;
const widths = [320, tabletStart - 1, tabletStart, desktopStart - 1, desktopStart] as const;

async function login(page: Page, name: 'Alice' | 'Bob'): Promise<Headers> {
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
async function logout(page: Page) {
  await page.goto('/account');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
}
async function compare(pb: Locator) {
  await pb.getByLabel('PB 거리 기준').selectOption('standard');
  await pb.getByLabel('PB 시간 기준').selectOption('both');
  await pb.getByLabel('PB 기간 시작 (선택)').fill('2080-01-01');
  await pb.getByLabel('PB 기간 끝 (선택)').fill('2080-01-31');
  await pb.getByLabel('PB 기준일').fill('2080-01-31');
  // Explicit override submits by keyboard; the new default is already available.
  const apply = pb.getByRole('button', { name: 'PB 비교 적용', exact: true });
  await apply.focus();
  await apply.press('Enter');
}
async function assertReflow(page: Page, pb: Locator, width: number) {
  const box = await pb.boundingBox();
  assert.ok(box);
  expect(box.x, `PB left edge at ${width}px`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `PB right edge at ${width}px`).toBeLessThanOrEqual(width + 1);
  expect(
    await pb.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    `PB horizontal overflow at ${width}px`,
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `document horizontal overflow at ${width}px`,
  ).toBe(true);
  for (const control of await pb.locator('input,select,button').all()) {
    const bounds = await control.boundingBox();
    assert.ok(bounds);
    expect(bounds.x, `control left edge at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width, `control right edge at ${width}px`).toBeLessThanOrEqual(
      width + 1,
    );
    expect(bounds.height, `touch control height at ${width}px`).toBeGreaterThanOrEqual(44);
  }
}

for (const shell of shells) {
  test(`${shell.name}: explicit PB comparison reflows at 320 and layout boundaries, retains focus/pages and clears private policy`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ baseURL: shell.origin });
    const page = await context.newPage();
    const created: { id: string; revision: number }[] = [];
    try {
      let headers = await login(page, 'Alice');
      await grantAppProcessingForScenario(page); // Explicit named positive scenario, never login default.
      const initial = await page.request.get('/bff/v1/race-results?limit=100', { headers });
      expect(initial.status()).toBe(200);
      expect(raceResultListPageSchema.parse(await initial.json()).items).toEqual([]);
      const marker = `PB 반응형 ${shell.name} ${randomUUID().slice(0, 8)}`;
      // One more than the UI's public 50-item page. IDs/revisions remain server allocated.
      for (let index = 0; index < 51; index += 1) {
        const values = raceResultValuesSchema.parse({
          kind: 'race-result',
          raceEventId: null,
          localDate: '2080-01-04',
          timezone: 'Pacific/Auckland',
          source: { kind: 'manual' },
          chipSeconds: 100 + index,
          gunSeconds: 200 + index,
          officialDistanceMeters: 10000,
          deviceDistanceMeters: null,
          linkedActivityId: null,
          weatherNote: `${marker} ${index}`,
        });
        const response = await page.request.post('/bff/v1/race-results', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { values },
        });
        expect(response.status()).toBe(201);
        created.push(raceCommandResultSchema.parse(await response.json()));
      }
      await page.setViewportSize({ width: widths[0], height: 900 });
      await page.goto('/records');
      const results = page.getByRole('region', { name: '실제 대회 결과', exact: true });
      const pb = results.getByRole('region', { name: '거리별 PB 비교', exact: true });
      await expect(results.getByText(/출처 manual/).first()).toBeVisible();
      await expect(pb.getByRole('list', { name: '거리별 PB 결과' })).toHaveCount(0);
      await expect(pb.getByLabel('PB 거리 기준')).toHaveValue('standard');
      await expect(pb.getByLabel('PB 시간 기준')).toHaveValue('chip-preferred');
      await expect(pb.getByLabel('PB 기준일')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      // Genuine future 2080 actuals are excluded by today's default cutoff.
      const comparisonWrites: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/bff/v1/') && request.method() !== 'GET')
          comparisonWrites.push(request.method());
      });
      // Native Tab order across the two explicitly labelled selects, with visible focus.
      await pb.getByLabel('PB 거리 기준').focus();
      await page.keyboard.press('Tab');
      await expect(pb.getByLabel('PB 시간 기준')).toBeFocused();
      expect(
        await pb.getByLabel('PB 시간 기준').evaluate((element) => {
          const style = getComputedStyle(element);
          return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        }),
      ).toBe(true);
      await compare(pb);
      await expect(
        pb.getByText(
          '불러온 50개 기록 기준입니다. 다음 페이지가 있어 전체 PB 비교는 미완료입니다.',
        ),
      ).toBeVisible();
      await expect(pb.getByText(/전체 51개 기록/)).toHaveCount(0);
      await expect(pb.getByRole('list', { name: '거리별 PB 결과' })).toBeVisible();
      const cutoff = pb.getByLabel('PB 기준일');
      await cutoff.focus();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await assertReflow(page, pb, width);
        await expect(cutoff).toBeFocused();
        await expect(cutoff).toHaveValue('2080-01-31');
        await expect(pb.getByLabel('PB 시간 기준')).toHaveValue('both');
        await expect(pb.getByText(/전체 PB 비교는 미완료/)).toBeVisible();
      }
      await results.getByRole('button', { name: '다음 실제 대회 결과 보기', exact: true }).click();
      await expect(pb.getByText('전체 51개 기록을 비교했습니다.', { exact: true })).toBeVisible();
      await expect(pb.getByText('10000 m · Chip · 100 초', { exact: true })).toBeVisible();
      await expect(pb.getByText('10000 m · Gun · 200 초', { exact: true })).toBeVisible();
      await expect(pb.getByText(/첨부 근거는 진위 확인 완료를 뜻하지 않습니다/)).toBeVisible();
      await page.setViewportSize({ width: widths[0], height: 900 });
      await assertReflow(page, pb, widths[0]);
      expect(comparisonWrites).toEqual([]);
      // Same document/account switch boundaries: the local comparison is not a persisted policy.
      await logout(page);
      await login(page, 'Bob');
      await page.goto('/records');
      await expect(pb.getByLabel('PB 시간 기준')).toHaveValue('chip-preferred');
      await expect(pb.getByLabel('PB 거리 기준')).toHaveValue('standard');
      await expect(pb.getByLabel('PB 기준일')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await expect(pb.getByLabel('PB 기준일')).not.toHaveValue('2080-01-31');
      await expect(pb.getByRole('list', { name: '거리별 PB 결과' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(marker);
      await logout(page);
      headers = await login(page, 'Alice');
      await page.goto('/records');
      await expect(pb.getByLabel('PB 시간 기준')).toHaveValue('chip-preferred');
      await expect(pb.getByLabel('PB 거리 기준')).toHaveValue('standard');
      await expect(pb.getByLabel('PB 기준일')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await expect(pb.getByLabel('PB 기준일')).not.toHaveValue('2080-01-31');
      await expect(pb.getByRole('list', { name: '거리별 PB 결과' })).toHaveCount(0);
      // Only this test's returned identities are deleted; unrelated account/source data remains.
      for (const record of created) {
        const response = await page.request.delete(`/bff/v1/race-results/${record.id}`, {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { expectedRevision: record.revision },
        });
        expect(response.status()).toBe(200);
      }
    } finally {
      // On failure, disposable fixture teardown owns remaining DB resources, avoiding expired requests.
      await context.close();
    }
  });
}
