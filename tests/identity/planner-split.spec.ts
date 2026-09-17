import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

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

test('simultaneous planned views follow actual container width and preserve selection and draft focus', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Synthetic planner split ${randomUUID()}`;
  const previousResponse = await page.request.get('/bff/v1/plans/current', {
    headers,
    timeout: 5000,
  });
  expect(previousResponse.status()).toBe(200);
  const previous = planReadSchema.parse(await previousResponse.json());
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `split-${level}`,
      parentId: index === 0 ? null : `split-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: ['split-first', 'split-second'].map((id, index) => ({
      id,
      blockId: 'split-block',
      date: index === 0 ? '2026-09-20' : '2026-09-21',
      localStartTime: null,
      title: `${marker} ${index === 0 ? 'first' : 'second'}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
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
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes++;
  });
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/planner?lens=calendar&from=2026-09-14&to=2026-09-28&view=stack');
  const calendar = page.getByRole('list', { name: '계획 날짜 달력', exact: true });
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  const firstName = `계획: ${marker} first`;
  const secondName = `계획: ${marker} second`;
  await expect(calendar).toBeVisible();
  await expect(table).toBeVisible();
  await page.goto(
    '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&view=stack&plannedView=split',
  );
  await expect(calendar).toBeVisible();
  await expect(table).toBeVisible();
  await calendar.getByRole('button', { name: firstName, exact: true }).click();
  await expect(table.getByRole('button', { name: firstName, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await table.getByRole('button', { name: secondName, exact: true }).click();
  await expect(calendar.getByRole('button', { name: secondName, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page).toHaveURL(/plannedSession=split-second/);
  const calendarPane = page.getByRole('region', { name: '계획 달력 패널', exact: true });
  const tablePane = page.getByRole('region', { name: '계획 표 패널', exact: true });
  const calendarWidth = await calendarPane.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const tableWidth = await tablePane.evaluate((element) => element.getBoundingClientRect().width);
  expect(tableWidth / calendarWidth).toBeGreaterThan(1.45);
  expect(tableWidth / calendarWidth).toBeLessThan(1.55);
  // Focus the view that disappears, then require semantic focus recovery on compact layout.
  await table.getByRole('button', { name: secondName, exact: true }).focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page).toHaveURL(/plannedView=split/);
  await expect(table).toHaveCount(0);
  const compactSelected = page.getByRole('button', { name: secondName, exact: true });
  await expect(compactSelected).toHaveAttribute('aria-pressed', 'true');
  await expect(compactSelected).toBeFocused();
  await expect(compactSelected).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(calendar).toBeVisible();
  await expect(table).toBeVisible();
  await expect(table.getByRole('button', { name: secondName, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('button:focus')).toHaveText(secondName);
  await expect(page.locator('button:focus')).toBeInViewport();
  // A separate cycle keeps focus outside disappearing panes: revealing a focused session
  // may legitimately change scroll position during the semantic-focus cycle above.
  const scrollRight = calendarPane.getByRole('button', {
    name: '계획 보기 오른쪽으로 이동',
    exact: true,
  });
  const calendarScrollId = await scrollRight.getAttribute('aria-controls');
  assert.ok(calendarScrollId);
  const calendarScroll = page.locator(`[id="${calendarScrollId}"]`);
  expect(
    await calendarScroll.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await scrollRight.click();
  await expect
    .poll(() => calendarScroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const savedScrollLeft = await calendarScroll.evaluate((element) => element.scrollLeft);
  const stableControl = page.getByRole('button', { name: '계획 달력·표 함께 보기', exact: true });
  await stableControl.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(table).toHaveCount(0);
  await expect(stableControl).toBeFocused();
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(calendar).toBeVisible();
  await expect(table).toBeVisible();
  await expect(stableControl).toBeFocused();
  // Remounting creates a new generated ID, so resolve the restored pane's control again.
  const restoredScrollId = await calendarPane
    .getByRole('button', { name: '계획 보기 오른쪽으로 이동', exact: true })
    .getAttribute('aria-controls');
  assert.ok(restoredScrollId);
  const restoredScroll = page.locator(`[id="${restoredScrollId}"]`);
  await expect
    .poll(async () =>
      Math.abs((await restoredScroll.evaluate((element) => element.scrollLeft)) - savedScrollLeft),
    )
    .toBeLessThanOrEqual(1);
  const viewContainer = page.getByRole('region', { name: '일별 계획', exact: true });
  await viewContainer.evaluate((element) => {
    element.style.width = '420px';
    element.style.maxWidth = '420px';
  });
  await expect(table).toHaveCount(0);
  await expect(page).toHaveURL(/plannedView=split/);
  expect(
    await viewContainer.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(420);
  await viewContainer.evaluate((element) => {
    element.style.removeProperty('width');
    element.style.removeProperty('max-width');
  });
  await expect(table).toBeVisible();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('합성 split 초안 유지');
  await note.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue('합성 split 초안 유지');
    await expect(note).toBeFocused();
    await expect(page).toHaveURL(/plannedView=split/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(writes).toBe(0);
  const unchanged = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
  expect(unchanged.status()).toBe(200);
  expect(planReadSchema.parse(await unchanged.json()).head).toEqual(saved);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '변경 미리보기', exact: true })).toBeVisible();
  expect(writes).toBe(0);
  const committed = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/bff/v1/plans/current',
  );
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  expect((await committed).status()).toBe(200);
  expect(writes).toBe(1);
  await expect(
    page.getByText(`계획 버전 ${saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
});
