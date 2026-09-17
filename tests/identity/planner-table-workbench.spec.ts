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

async function setupWorkbench(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const current = await readPlan();
  const marker = `Workbench ${randomUUID()}`;
  const title = (index: number) => `${marker} ${String(index).padStart(3, '0')}`;
  const id = (index: number) => `workbench-${String(index).padStart(3, '0')}`;
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `workbench-${level}`,
      parentId: index === 0 ? null : `workbench-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: Array.from({ length: 120 }, (_, index) => ({
      id: id(index),
      blockId: 'workbench-block',
      date: '2026-09-20',
      localStartTime: null,
      title: title(index),
      sport: 'running',
      durationSeconds: index,
      distanceMeters: index,
      targetRpe: null,
      purpose: 'Synthetic purpose',
      notes: [2, 48, 88].includes(index)
        ? 'Long synthetic note that wraps at different panel widths. '.repeat(45)
        : 'Saved synthetic note',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const created = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(created.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await created.json());
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes++;
  });
  await page.setViewportSize({ width: 1920, height: 1000 });
  const path = '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=table&view=stack';
  return {
    title,
    id,
    path,
    async unchanged() {
      expect(writes).toBe(0);
      expect((await readPlan()).head).toEqual(saved);
    },
  };
}

test('virtual rows, inclusive ranges and sorting remain display-only with 120 real saved sessions', async ({
  page,
}) => {
  const fixture = await setupWorkbench(page);
  await page.goto(`${fixture.path}&plannedSession=${fixture.id(110)}`);
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  await expect(table).toHaveAttribute('aria-rowcount', '121');
  const rowButtons = table.getByRole('button', { name: /^계획:/ });
  await expect.poll(() => rowButtons.count()).toBeGreaterThan(0);
  await expect.poll(() => rowButtons.count()).toBeLessThan(120);
  await page.getByRole('button', { name: '선택한 계획 행으로 이동', exact: true }).click();
  await expect(
    table.getByRole('button', { name: `계획: ${fixture.title(110)}`, exact: true }),
  ).toBeVisible();
  const jumped = table.getByRole('button', { name: `계획: ${fixture.title(110)}`, exact: true });
  await expect(jumped).toBeFocused();
  const scrolling = page.getByRole('region', { name: '계획 표 스크롤 영역', exact: true });
  await scrolling.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(jumped).toBeFocused();
  await expect(
    table.getByRole('button', { name: `계획: ${fixture.title(0)}`, exact: true }),
  ).toBeVisible();
  await expect.poll(() => rowButtons.count()).toBeGreaterThan(0);
  await expect.poll(() => rowButtons.count()).toBeLessThan(60);
  await page.getByRole('button', { name: '선택한 계획 행으로 이동', exact: true }).click();
  await table.getByRole('button', { name: `${fixture.title(110)} 범위 시작`, exact: true }).click();
  await table.getByRole('button', { name: `${fixture.title(115)} 범위 끝`, exact: true }).click();
  await expect(page.getByText(/^현재 조회 범위에서 6개 행 선택\./)).toBeVisible();
  await table.getByRole('button', { name: `${fixture.title(115)} 범위 시작`, exact: true }).click();
  await table.getByRole('button', { name: `${fixture.title(112)} 범위 끝`, exact: true }).click();
  await expect(page.getByText(/^현재 조회 범위에서 4개 행 선택\./)).toBeVisible();
  await page.getByRole('button', { name: '모든 행 표시', exact: true }).click();
  await expect(rowButtons).toHaveCount(120);
  const sort = page.getByRole('button', { name: '거리 정렬', exact: true });
  await sort.click();
  await sort.click();
  await expect(page).toHaveURL(/plannedSort=distance_desc/);
  await expect(rowButtons.first()).toHaveText(`계획: ${fixture.title(119)}`);
  for (const index of [112, 113, 114, 115])
    await expect(
      table.getByRole('checkbox', { name: `${fixture.title(index)} 범위 선택`, exact: true }),
    ).toBeChecked();
  await expect(
    table.getByRole('checkbox', { name: `${fixture.title(111)} 범위 선택`, exact: true }),
  ).not.toBeChecked();
  const keyboardRow = table.getByRole('checkbox', {
    name: `${fixture.title(119)} 범위 선택`,
    exact: true,
  });
  await keyboardRow.focus();
  await page.keyboard.press('Space');
  await expect(keyboardRow).toBeChecked();
  await page.getByRole('button', { name: '행 범위 선택 해제', exact: true }).click();
  await expect(page.getByText(/^현재 조회 범위에서 0개 행 선택\./)).toBeVisible();
  await page.getByRole('button', { name: '가상 스크롤', exact: true }).click();
  await expect.poll(() => rowButtons.count()).toBeGreaterThan(0);
  await expect.poll(() => rowButtons.count()).toBeLessThan(120);
  await fixture.unchanged();
});

test('URL pins and hidden columns restore while responsive remount retains range, scroll and unsaved draft', async ({
  page,
}) => {
  const fixture = await setupWorkbench(page);
  await page.goto(`${fixture.path}&plannedSession=${fixture.id(90)}`);
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  const titlePin = page.getByRole('checkbox', { name: '제목 열 고정', exact: true });
  const notePin = page.getByRole('checkbox', { name: '메모 열 고정', exact: true });
  await titlePin.check();
  await notePin.check();
  await expect(page).toHaveURL(/plannedPinned=/);
  await page.getByRole('checkbox', { name: '메모 열 표시', exact: true }).uncheck();
  await page.reload();
  await expect(titlePin).toBeChecked();
  await expect(notePin).toBeChecked();
  await expect(table.getByRole('columnheader', { name: '메모', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '메모 열 표시', exact: true }).check();
  await expect(table.getByRole('columnheader', { name: '메모', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(table).toBeVisible();
  await expect(titlePin).toBeChecked();
  await expect(table.getByRole('columnheader', { name: '메모', exact: true })).toHaveAttribute(
    'data-pinned',
    'false',
  );
  await expect(page.getByText(/표 영역이 좁아 열 고정을 잠시 해제했습니다/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByRole('button', { name: '선택한 계획 행으로 이동', exact: true }).click();
  const selected = table.getByRole('checkbox', {
    name: `${fixture.title(90)} 범위 선택`,
    exact: true,
  });
  await selected.check();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('Unsaved workbench draft survives responsive remount');
  await page.getByRole('button', { name: '계획 달력·표 함께 보기', exact: true }).click();
  const viewport = page.getByRole('region', { name: '계획 표 스크롤 영역', exact: true });
  await expect(viewport).toBeVisible();
  await page.getByRole('button', { name: '선택한 계획 행으로 이동', exact: true }).click();
  await viewport.evaluate((element) => {
    element.scrollLeft = 180;
    element.dispatchEvent(new Event('scroll'));
  });
  const scroll = await viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-session-id]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    return {
      id: row?.dataset.sessionId ?? null,
      offset: row ? row.getBoundingClientRect().top - top : null,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
  });
  expect(scroll.id).not.toBeNull();
  expect(scroll.id).toMatch(/^workbench-\d{3}$/);
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.left).toBeGreaterThan(0);
  await note.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(table).toHaveCount(0);
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('Unsaved workbench draft survives responsive remount');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(table).toBeVisible();
  await expect(selected).toBeChecked();
  await expect(page.getByText(/^현재 조회 범위에서 1개 행 선택\./)).toBeVisible();
  await expect
    .poll(() =>
      viewport.evaluate((element, expected) => {
        const row = [...element.querySelectorAll<HTMLElement>('[data-session-id]')].find(
          (item) => item.dataset.sessionId === expected.id,
        );
        return row && expected.offset !== null
          ? Math.abs(
              row.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                expected.offset,
            )
          : Number.POSITIVE_INFINITY;
      }, scroll),
    )
    .toBeLessThan(3);
  await expect
    .poll(() =>
      viewport.evaluate((element, left) => Math.abs(element.scrollLeft - left), scroll.left),
    )
    .toBeLessThan(3);
  await expect(note).toHaveValue('Unsaved workbench draft survives responsive remount');
  await expect(titlePin).toBeChecked();
  await expect(notePin).toBeChecked();
  await fixture.unchanged();
});
