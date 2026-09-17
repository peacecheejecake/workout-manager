import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

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

async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const read = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const previous = await read();
  const draft = planDraftSchema.parse({
    title: 'Synthetic dashboard period navigation',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: `2026-09-${String(index + 1).padStart(2, '0')}`,
      endDateExclusive: `2026-09-${28 - index}`,
      timezone: 'Asia/Seoul',
      intent: `Synthetic ${level} purpose`,
      isPartial: false,
    })),
    sessions: [],
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: previous.head?.id ?? null,
      draft,
    },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/bff/v1/'))
      writes += 1;
  });
  const path = '/dashboard?anchor=2026-09-17&window=10&timezone=Asia%2FSeoul';
  const unchanged = async () => {
    expect(writes).toBe(0);
    expect((await read()).head).toEqual(saved);
  };
  return { path, unchanged };
}

const navigator = (page: Page) =>
  page.getByRole('region', { name: '대시보드 기간 탐색', exact: true });
function expectQuery(page: Page, expected: Record<string, string>) {
  return expect
    .poll(() => {
      const query = new URL(page.url()).searchParams;
      return Object.fromEntries(Object.keys(expected).map((key) => [key, query.get(key)]));
    })
    .toEqual(expected);
}

test('dashboard hierarchy keyboard navigation preserves rolling filters through reload and browser history', async ({
  page,
}) => {
  const fixture = await setup(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture.path);
  const region = navigator(page);
  await region.getByRole('button', { name: 'season · season', exact: true }).click();
  await expectQuery(page, {
    planPeriod: 'season',
    anchor: '2026-09-17',
    window: '10',
    timezone: 'Asia/Seoul',
  });
  const wave = region.getByRole('button', { name: '기간 원형: wave · wave', exact: true });
  await wave.focus();
  await wave.press('Enter');
  await expectQuery(page, { planPeriod: 'wave' });
  await region
    .getByRole('button', { name: '기간 원형: phase · phase', exact: true })
    .press('Enter');
  await expectQuery(page, { planPeriod: 'phase' });
  await page.goBack();
  await expectQuery(page, { planPeriod: 'wave' });
  await page.goForward();
  await expectQuery(page, { planPeriod: 'phase' });
  await region.getByRole('button', { name: '기간 타임라인 보기', exact: true }).click();
  await expectQuery(page, { planPeriod: 'phase', planPeriodView: 'timeline' });
  await page.reload();
  await expect(
    region.getByRole('button', { name: '기간 타임라인 보기', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    region
      .getByRole('region', { name: '현재 선택한 기간', exact: true })
      .getByRole('heading', { name: 'phase', exact: true }),
  ).toBeVisible();
  await page.getByRole('spinbutton', { name: '조회 일수', exact: true }).fill('3');
  await page.getByRole('button', { name: '조회 적용', exact: true }).click();
  await expectQuery(page, {
    planPeriod: 'phase',
    planPeriodView: 'timeline',
    window: '3',
    anchor: '2026-09-17',
    timezone: 'Asia/Seoul',
  });
  await region.getByRole('button', { name: '계획 기간 다시 확인', exact: true }).click();
  await expect(
    region.getByRole('link', { name: '선택한 기간 계획 열기', exact: true }),
  ).toBeVisible();
  await fixture.unchanged();
  await region.getByRole('link', { name: '선택한 기간 계획 열기', exact: true }).click();
  await expect(page).toHaveURL(/\/planner\?/);
  await expectQuery(page, { lens: 'period', period: 'phase' });
  await fixture.unchanged();
});

test('mobile dashboard period list opens the selected calendar without saving a plan', async ({
  page,
}) => {
  const fixture = await setup(page);
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto(`${fixture.path}&planPeriod=phase&planPeriodView=timeline`);
  const region = navigator(page);
  const block = region.getByRole('button', { name: 'block · block', exact: true });
  await block.focus();
  await block.press('Enter');
  await expectQuery(page, { planPeriod: 'block', planPeriodView: 'timeline' });
  await expect(
    region
      .getByRole('region', { name: '현재 선택한 기간', exact: true })
      .getByRole('heading', { name: 'block', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await fixture.unchanged();
  await region.getByRole('button', { name: '이 기간 달력 보기', exact: true }).click();
  await expect(page).toHaveURL(/\/planner\?/);
  await expectQuery(page, { lens: 'period', period: 'block', plannedView: 'calendar' });
  await fixture.unchanged();
});

test('saved period navigation remains usable when the independent dashboard report fails', async ({
  page,
}) => {
  const fixture = await setup(page);
  // Fault injection affects only the report; plan navigation still reads the real API/DB.
  await page.route('**/bff/v1/dashboard?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FIXTURE_REPORT_UNAVAILABLE' }),
    }),
  );
  await page.goto(fixture.path);
  await expect(page.getByText(/최신 확인 실패/)).toBeVisible();
  const region = navigator(page);
  await region.getByRole('button', { name: 'season · season', exact: true }).click();
  await expectQuery(page, { planPeriod: 'season', window: '10' });
  await expect(
    region.getByRole('link', { name: '선택한 기간 계획 열기', exact: true }),
  ).toBeVisible();
  await fixture.unchanged();
});
