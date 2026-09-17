import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { activityListSchema } from '../../packages/contracts/src/activity';
import { sessionCompletionReadSchema } from '../../packages/contracts/src/session-completion';

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
  async function get(path: string) {
    const response = await page.request.get(path, { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return response.json();
  }
  const previous = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const actualBefore = activityListSchema.parse(await get('/bff/v1/activities')).total;
  const ranges = [
    ['2026-09-01', '2026-10-15'],
    ['2026-09-03', '2026-10-12'],
    ['2026-09-10', '2026-09-30'],
    ['2026-09-12', '2026-09-24'],
  ];
  const draft = planDraftSchema.parse({
    title: 'Synthetic period movement',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: ranges[index]?.[0],
      endDateExclusive: ranges[index]?.[1],
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      { id: 'movable', date: '2026-09-16', locked: false },
      { id: 'completed', date: '2026-09-18', locked: false },
      { id: 'date-locked', date: '2026-09-17', locked: true },
    ].map(({ id, date, locked }) => ({
      id,
      blockId: 'block',
      date,
      localStartTime: null,
      title: id,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: locked, time: false, intensity: false },
      steps: [],
    })),
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
  const completed = await page.request.post(
    '/bff/v1/plans/session-completion?sessionId=completed',
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        action: 'complete',
        confirmed: true,
        expectedPlanVersionId: saved.id,
        expectedRevision: null,
        reason: null,
      },
    },
  );
  expect(completed.status()).toBe(200);
  await page.goto('/planner?lens=period&period=phase&plannedView=agenda&view=stack');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const panel = page.getByRole('region', { name: '기간 날짜 이동', exact: true });
  await expect(panel).toBeVisible();
  const period = (level: string) =>
    page.getByRole('group', { name: `${level}: ${level}`, exact: true });
  const session = (id: string) => page.getByRole('group', { name: id, exact: true });
  const head = async () => planReadSchema.parse(await get('/bff/v1/plans/current')).head;
  const report = async () =>
    sessionCompletionReadSchema.parse(
      await get('/bff/v1/plans/session-completion?sessionId=completed'),
    );
  return { get, panel, period, session, saved, draft, head, report, actualBefore };
}

test('period descendant movement preserves completed and locked dates until explicit save, with atomic undo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const fixture = await setup(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes += 1;
  });
  const start = fixture.panel.getByLabel('이동할 기간 시작일', { exact: true });
  await start.fill('2026-09-11');
  await fixture.panel
    .getByRole('radio', { name: '자식 기간과 세션 함께 이동', exact: true })
    .check();
  const preview = fixture.panel.getByRole('button', { name: '기간 이동 영향 확인', exact: true });
  await preview.focus();
  await preview.press('Enter');
  const apply = fixture.panel.getByRole('button', {
    name: '확인하고 기간 이동 초안 적용',
    exact: true,
  });
  await expect(apply).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cancel = fixture.panel.getByRole('button', { name: '기간 이동 검토 취소', exact: true });
  await cancel.focus();
  await cancel.press('Enter');
  await expect(apply).toHaveCount(0);
  await expect(fixture.period('phase').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-10',
  );
  expect(writes).toBe(0);
  await preview.click();
  await apply.click();
  await expect(fixture.period('phase').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-11',
  );
  await expect(fixture.period('block').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-13',
  );
  await expect(fixture.session('movable').getByLabel('세션 날짜', { exact: true })).toHaveValue(
    '2026-09-17',
  );
  await expect(fixture.session('completed').getByLabel('세션 날짜', { exact: true })).toHaveValue(
    '2026-09-18',
  );
  await expect(fixture.session('date-locked').getByLabel('세션 날짜', { exact: true })).toHaveValue(
    '2026-09-17',
  );
  expect((await fixture.head())?.id).toBe(fixture.saved.id);
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(fixture.period('phase').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-10',
  );
  await expect(fixture.period('block').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-12',
  );
  await expect(fixture.session('movable').getByLabel('세션 날짜', { exact: true })).toHaveValue(
    '2026-09-16',
  );
  expect((await fixture.report()).report).toMatchObject({ status: 'completed', revision: 1 });
  await start.fill('2026-09-11');
  await fixture.panel
    .getByRole('radio', { name: '자식 기간과 세션 함께 이동', exact: true })
    .check();
  await preview.click();
  await apply.click();
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${fixture.saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  const saved = await fixture.head();
  expect(saved?.draft.sessions.map(({ id, date }) => ({ id, date }))).toEqual([
    { id: 'movable', date: '2026-09-17' },
    { id: 'completed', date: '2026-09-18' },
    { id: 'date-locked', date: '2026-09-17' },
  ]);
  const historical = planSnapshotSchema.parse(
    await fixture.get(`/bff/v1/plans/versions/${fixture.saved.id}`),
  );
  expect(historical.draft).toEqual(fixture.draft);
  expect((await fixture.report()).totalHistory).toBe(1);
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities')).total).toBe(
    fixture.actualBefore,
  );
});

test('period movement rejects fixed completed dates outside the shifted Block and invalid selected-only containment', async ({
  page,
}) => {
  const fixture = await setup(page);
  await fixture.panel.getByLabel('이동할 기간 시작일', { exact: true }).fill('2026-09-20');
  await fixture.panel
    .getByRole('radio', { name: '자식 기간과 세션 함께 이동', exact: true })
    .check();
  await fixture.panel.getByRole('button', { name: '기간 이동 영향 확인', exact: true }).click();
  await expect(fixture.panel.getByRole('alert')).toBeVisible();
  await expect(
    fixture.panel.getByRole('button', { name: '확인하고 기간 이동 초안 적용', exact: true }),
  ).toHaveCount(0);
  await expect(fixture.period('phase').getByLabel('기간 시작일', { exact: true })).toHaveValue(
    '2026-09-10',
  );
  await fixture.panel.getByRole('radio', { name: '이 기간만 이동', exact: true }).check();
  await fixture.panel.getByRole('button', { name: '기간 이동 영향 확인', exact: true }).click();
  await expect(fixture.panel.getByRole('alert')).toBeVisible();
  await expect(
    fixture.panel.getByRole('button', { name: '확인하고 기간 이동 초안 적용', exact: true }),
  ).toHaveCount(0);
  expect((await fixture.head())?.id).toBe(fixture.saved.id);
  expect((await fixture.report()).report).toMatchObject({ status: 'completed', revision: 1 });
});
