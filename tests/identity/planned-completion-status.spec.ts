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
  const previousResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(previousResponse.status()).toBe(200);
  const previous = planReadSchema.parse(await previousResponse.json());
  const id = `완료 / ${randomUUID()}`;
  const draft = planDraftSchema.parse({
    title: 'Synthetic completion UI plan',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `completion-ui-${level}`,
      parentId: index === 0 ? null : `completion-ui-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [id, `${id}-other`].map((sessionId, index) => ({
      id: sessionId,
      blockId: 'completion-ui-block',
      date: index === 0 ? '2026-09-20' : '2026-09-21',
      localStartTime: null,
      title: `Synthetic completion session ${index + 1}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const save = async (expectedVersionId: string | null, next = draft) => {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft: next },
      timeout: 5000,
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const saved = await save(previous.head?.id ?? null);
  const path = `/bff/v1/plans/sessions/${encodeURIComponent(id)}/completion`;
  const read = async () => {
    const response = await page.request.get(path, { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return sessionCompletionReadSchema.parse(await response.json());
  };
  const actualCount = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json()).total;
  };
  await page.goto(
    `/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=table&plannedColumns=completion&plannedPinned=completion&view=stack&plannedSession=${encodeURIComponent(id)}`,
  );
  const panel = page.getByRole('region', { name: '세션 완료 확인', exact: true });
  await expect(panel.getByRole('button', { name: '완료 확인하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('Keep this unsaved synthetic note');
  return { headers, saved, draft, path, read, save, actualCount, panel, note };
}

test('completion column shows explicit reports and copy absence while preserving drafts and URL preferences', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page),
    before = await fixture.actualCount();
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  const first = table.getByRole('row').filter({
    has: page.getByRole('checkbox', {
      name: 'Synthetic completion session 1 범위 선택',
      exact: true,
    }),
  });
  await expect(table.getByRole('columnheader', { name: '완료 보고', exact: true })).toBeVisible();
  await expect(first).toContainText('완료 확인 기록 없음');
  await fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }).click();
  await fixture.panel.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(first).toContainText('사용자 완료 확인');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  const copied = table.getByRole('row').filter({
    has: page.getByRole('checkbox', {
      name: 'Synthetic completion session 1 복사 범위 선택',
      exact: true,
    }),
  });
  await expect(copied).toContainText('저장 전 세션');
  await expect(first).toContainText('사용자 완료 확인');
  const selected = new URL(page.url()).searchParams.get('plannedSession');
  const retracted = await page.request.post(fixture.path, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      action: 'retract',
      confirmed: true,
      expectedPlanVersionId: fixture.saved.id,
      expectedRevision: 1,
      reason: 'Synthetic correction',
    },
  });
  expect(retracted.status()).toBe(200);
  await page.getByRole('button', { name: '완료 상태 다시 확인', exact: true }).click();
  await expect(first).toContainText('완료 확인 철회');
  await expect(copied).toContainText('저장 전 세션');
  expect(new URL(page.url()).searchParams.get('plannedSession')).toBe(selected);
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.getByRole('checkbox', { name: '완료 보고 열 표시', exact: true }).uncheck();
  await expect(table.getByRole('columnheader', { name: '완료 보고', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '완료 보고 열 표시', exact: true }).check();
  await expect(first).toContainText('완료 확인 철회');
  expect(new URL(page.url()).searchParams.get('plannedPinned')?.split(',')).toContain('completion');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(first).toContainText('완료 확인 철회');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(copied).toContainText('저장 전 세션');
  expect(await fixture.actualCount()).toBe(before);
});

test('completion read failures and version mismatches stay explicit, recover without draft loss, and accept stable reports from older versions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page),
    table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  const first = table.getByRole('row').filter({
    has: page.getByRole('checkbox', {
      name: 'Synthetic completion session 1 범위 선택',
      exact: true,
    }),
  });
  const endpoint = '**/bff/v1/plans/current/session-completions';
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Synthetic unavailable' } }),
    }),
  );
  await page.getByRole('button', { name: '완료 상태 다시 확인', exact: true }).click();
  await expect(first).toContainText('완료 보고 조회 실패');
  await expect(first).not.toContainText('완료 확인 기록 없음');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.unroute(endpoint);
  await page.route(endpoint, async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    assert.ok(typeof body === 'object' && body !== null);
    await route.fulfill({ response, json: { ...body, currentPlanVersionId: randomUUID() } });
  });
  await page.getByRole('button', { name: '완료 상태 다시 확인', exact: true }).click();
  await expect(first).toContainText('완료 보고 버전 불일치');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.unroute(endpoint);
  await page.getByRole('button', { name: '완료 상태 다시 확인', exact: true }).click();
  await expect(first).toContainText('완료 확인 기록 없음');
  const completed = await page.request.post(fixture.path, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      action: 'complete',
      confirmed: true,
      expectedPlanVersionId: fixture.saved.id,
      expectedRevision: null,
      reason: null,
    },
  });
  expect(completed.status()).toBe(200);
  const next = await fixture.save(fixture.saved.id, {
    ...fixture.draft,
    title: 'New head, same stable session',
  });
  expect(next.id).not.toBe(fixture.saved.id);
  await page.reload();
  await expect(first).toContainText('사용자 완료 확인');
  expect((await fixture.read()).report?.planVersionId).toBe(fixture.saved.id);
  await expect(
    page.getByRole('checkbox', { name: '완료 보고 열 표시', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '완료 보고 열 고정', exact: true }),
  ).toBeChecked();
});
