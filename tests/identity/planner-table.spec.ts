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

test('planned table sorting and columns remain display-only through reload and responsive split transitions', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Synthetic table ${randomUUID()}`;
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const current = await readPlan();
  const cases = [
    { id: 'table-z-null', name: 'missing', distance: null },
    { id: 'table-b-tie', name: 'tie B', distance: 100 },
    { id: 'table-a-tie', name: 'tie A', distance: 100 },
    { id: 'table-zero', name: 'zero', distance: 0 },
  ];
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `table-${level}`,
      parentId: index === 0 ? null : `table-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: cases.map((value) => ({
      id: value.id,
      blockId: 'table-block',
      date: '2026-09-20',
      localStartTime: null,
      title: `${marker} ${value.name}`,
      sport: 'running',
      durationSeconds: value.distance,
      distanceMeters: value.distance,
      targetRpe: null,
      purpose: '',
      notes: 'saved synthetic note',
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
  await page.goto(
    '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=table&view=stack',
  );
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  await expect(table.getByRole('columnheader', { name: '계획 종류', exact: true })).toBeVisible();
  await expect(
    table
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: `계획: ${marker} zero`, exact: true }) })
      .getByRole('cell', { name: '운동', exact: true }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: '계획 종류 열 표시', exact: true }).uncheck();
  await expect(table.getByRole('columnheader', { name: '계획 종류', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '계획 종류 열 표시', exact: true }).check();
  const names = (suffixes: string[]) => suffixes.map((suffix) => `계획: ${marker} ${suffix}`);
  const rowTitles = table.getByRole('button', { name: /^계획:/ });
  const distanceSort = page.getByRole('button', { name: '거리 정렬', exact: true });
  await distanceSort.click();
  await expect(page).toHaveURL(/plannedSort=distance_asc/);
  await expect(rowTitles).toHaveText(names(['zero', 'tie A', 'tie B', 'missing']));
  await expect(table.getByRole('columnheader').filter({ has: distanceSort })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await distanceSort.click();
  await expect(rowTitles).toHaveText(names(['tie A', 'tie B', 'zero', 'missing']));
  await expect(table.getByRole('columnheader').filter({ has: distanceSort })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  const durationSort = page.getByRole('button', { name: '시간 정렬', exact: true });
  await durationSort.click();
  await expect(rowTitles).toHaveText(names(['zero', 'tie A', 'tie B', 'missing']));
  await durationSort.click();
  await expect(rowTitles).toHaveText(names(['tie A', 'tie B', 'zero', 'missing']));
  await expect(page).toHaveURL(/plannedSort=duration_desc/);
  await table.getByRole('button', { name: `계획: ${marker} zero`, exact: true }).click();
  await page.getByRole('checkbox', { name: '메모 열 표시', exact: true }).uncheck();
  await expect(table.getByRole('columnheader', { name: '메모', exact: true })).toHaveCount(0);
  const query = new URL(page.url()).searchParams;
  expect(query.get('plannedColumns')?.split(',')).not.toContain('notes');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '메모 열 표시', exact: true })).not.toBeChecked();
  await expect(rowTitles).toHaveText(names(['tie A', 'tie B', 'zero', 'missing']));
  await expect(
    table.getByRole('button', { name: `계획: ${marker} zero`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('display settings must keep this draft');
  await page.getByRole('button', { name: '계획 달력·표 함께 보기', exact: true }).click();
  await expect(table).toBeVisible();
  await note.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(table).toHaveCount(0);
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('display settings must keep this draft');
  await expect(page).toHaveURL(/plannedView=split/);
  await expect(page).toHaveURL(/plannedSort=duration_desc/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(table).toBeVisible();
  await expect(rowTitles).toHaveText(names(['tie A', 'tie B', 'zero', 'missing']));
  await expect(table.getByRole('columnheader', { name: '메모', exact: true })).toHaveCount(0);
  await expect(
    table.getByRole('button', { name: `계획: ${marker} zero`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveValue('display settings must keep this draft');
  expect(writes).toBe(0);
  expect((await readPlan()).head).toEqual(saved);
});
