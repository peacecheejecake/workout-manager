import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityListSchema } from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
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
const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  // The identity harness provisions synthetic accounts in a private PostgreSQL database.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

async function setupPriority(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const readActuals = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const current = await readPlan();
  const actuals = await readActuals();
  const draft = planDraftSchema.parse({
    title: `Synthetic period priority ${randomUUID()}`,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `priority-${level}`,
      parentId: index === 0 ? null : `priority-${levels[index - 1]}`,
      level,
      title: level === 'block' ? '우선순위 Block' : level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-01-08',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'priority-session',
        blockId: 'priority-block',
        date: '2080-01-03',
        localStartTime: null,
        title: '잠긴 독립 세션',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: 0,
        intensityLabel: 'A',
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: true, time: true, intensity: true },
        steps: [
          {
            id: 'priority-step',
            kind: 'work',
            durationSeconds: null,
            distanceMeters: 0,
            repetitions: 2,
          },
        ],
      },
    ],
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/bff/v1/') &&
      !['GET', 'HEAD'].includes(request.method())
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    '/planner?lens=period&period=priority-block&plannedView=table&plannedSession=priority-session',
  );
  return { headers, saved, writes, readPlan, readActuals, actuals };
}
const priority = (page: Page) =>
  page
    .getByRole('group', { name: 'block: 우선순위 Block', exact: true })
    .getByRole('combobox', { name: '기간 우선순위', exact: true });
const selectedPeriod = (page: Page) =>
  page.getByRole('region', { name: '현재 선택한 기간', exact: true });
async function commit(page: Page) {
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}
async function openComparison(page: Page, version: number) {
  await page.getByRole('button', { name: `버전 ${version}과 비교`, exact: true }).click();
  const panel = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  await panel
    .getByRole('combobox', { name: '비교할 기간', exact: true })
    .selectOption('priority-block');
  const row = panel
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^우선순위 Block ·/ }) });
  await row.locator('summary').click();
  return { panel, row };
}

test('period priority survives review, responsive editing and history while locked session values remain unchanged', async ({
  page,
}) => {
  const f = await setupPriority(page);
  expect(f.saved.draft.periods.every((period) => !Object.hasOwn(period, 'priority'))).toBe(true);
  await expect(selectedPeriod(page)).toContainText('기간 우선순위 미지정');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const choice = priority(page);
  await expect(choice).toBeEnabled();
  await expect(choice).toHaveValue('');
  await expect(page.getByRole('combobox', { name: '강도 라벨', exact: true })).toBeDisabled();
  await choice.selectOption('high');
  await choice.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(choice).toHaveValue('high');
    await expect(choice).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await expect(selectedPeriod(page)).toContainText('기간 우선순위 높음');
  expect(f.writes).toEqual([]);
  expect((await f.readPlan()).head).toEqual(f.saved);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  const preview = page.getByRole('region', { name: '변경 미리보기', exact: true });
  await preview.getByText('변경 전후 전체 내용 비교', { exact: true }).click();
  const blocks = preview.getByRole('listitem').filter({ hasText: 'block · 우선순위 Block · 상위' });
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toContainText('기간 우선순위 미지정');
  await expect(blocks.nth(1)).toContainText('기간 우선순위 높음');
  expect(f.writes).toEqual([]);
  expect((await f.readPlan()).head).toEqual(f.saved);
  await commit(page);
  expect(f.writes).toEqual(['PUT /bff/v1/plans/current']);
  const highRead = await f.readPlan();
  const high = highRead.head;
  assert.ok(high);
  expect(high.draft).toEqual({
    ...f.saved.draft,
    periods: f.saved.draft.periods.map((period) =>
      period.id === 'priority-block' ? { ...period, priority: 'high' } : period,
    ),
  });
  expect(high.version).toBe(f.saved.version + 1);
  expect(highRead.history.map((entry) => entry.id)).toEqual(
    expect.arrayContaining([f.saved.id, high.id]),
  );
  await page.reload();
  await expect(selectedPeriod(page)).toContainText('기간 우선순위 높음');
  const comparison = await openComparison(page, f.saved.version);
  expect(new URL(page.url()).searchParams.get('compareFrom')).toBe(f.saved.id);
  expect(new URL(page.url()).searchParams.get('compareTo')).toBe(high.id);
  await expect(
    comparison.row.getByRole('region', { name: '이전 기간', exact: true }),
  ).toContainText('기간 우선순위 미지정 (이전 형식에 값 없음)');
  await expect(
    comparison.row.getByRole('region', { name: '이후 기간', exact: true }),
  ).toContainText('기간 우선순위 높음');
  await comparison.panel.getByRole('button', { name: '버전 비교 닫기', exact: true }).click();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(choice).toHaveValue('high');
  await choice.selectOption('low');
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  expect((await f.readPlan()).head).toEqual(high);
  expect(f.writes).toHaveLength(1);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(choice).toHaveValue('high');
  await choice.selectOption('');
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  expect((await f.readPlan()).head).toEqual(high);
  await commit(page);
  const cleared = (await f.readPlan()).head;
  assert.ok(cleared);
  expect(cleared.draft).toEqual({
    ...f.saved.draft,
    periods: f.saved.draft.periods.map((period) =>
      period.id === 'priority-block' ? { ...period, priority: null } : period,
    ),
  });
  expect(cleared.draft.sessions).toEqual(f.saved.draft.sessions);
  for (const period of cleared.draft.periods.filter((period) => period.id !== 'priority-block'))
    expect(period).not.toHaveProperty('priority');
  expect(f.writes).toEqual(['PUT /bff/v1/plans/current', 'PUT /bff/v1/plans/current']);
  await page.reload();
  await expect(selectedPeriod(page)).toContainText('기간 우선순위 미지정');
  const finalComparison = await openComparison(page, f.saved.version);
  const later = finalComparison.row.getByRole('region', { name: '이후 기간', exact: true });
  await expect(later).toContainText('기간 우선순위 미지정');
  await expect(later.getByText('기간 우선순위 미지정', { exact: true })).toBeVisible();
  const old = await page.request.get(`/bff/v1/plans/versions/${f.saved.id}`, {
    headers: f.headers,
  });
  expect(old.status()).toBe(200);
  expect(planSnapshotSchema.parse(await old.json())).toEqual(f.saved);
  expect(await f.readActuals()).toEqual(f.actuals);
});
