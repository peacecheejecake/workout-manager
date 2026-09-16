import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityImportResultSchema } from '../../packages/contracts/src/activity';
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

test('calendar table and agenda share planned selection and draft while saving only after explicit confirmation', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Synthetic planner views ${randomUUID()}`;
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const original = await readPlan();
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `views-${level}`,
      parentId: index === 0 ? null : `views-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: ['views-first', 'views-second'].map((id, index) => ({
      id,
      blockId: 'views-block',
      date: index === 0 ? '2026-09-20' : '2026-09-21',
      localStartTime: null,
      title: `${marker} ${index === 0 ? 'first' : 'second'}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: index === 0 ? 0 : null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const savedResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: original.head?.id ?? null,
      draft,
    },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await savedResponse.json());
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
      activity: {
        title: `${marker} actual`,
        kind: 'running',
        startedAt: '2026-09-15T08:00:00+09:00',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: 0,
      },
    },
  });
  expect(imported.status()).toBe(200);
  activityImportResultSchema.parse(await imported.json());
  let planWrites = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      planWrites++;
  });
  await page.goto(
    '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=calendar&view=split',
  );
  const firstSession = page.getByRole('button', { name: `계획: ${marker} first`, exact: true });
  await firstSession.click();
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/plannedSession=views-first/);
  const actuals = page.getByRole('region', { name: '실제 활동 레이어', exact: true });
  await expect(actuals).toContainText(`${marker} actual`);
  await page.getByRole('button', { name: '계획 표 보기', exact: true }).click();
  await expect(page).toHaveURL(/plannedView=table/);
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  const row = page.getByRole('row').filter({ has: firstSession });
  await expect(row).toContainText('2026-09-20');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const date = page.getByLabel('세션 날짜', { exact: true }).first();
  await expect(date).toHaveValue('2026-09-20');
  await date.fill('2026-09-22');
  await expect(row).toContainText('2026-09-22');
  await page.getByRole('button', { name: '계획 달력 보기', exact: true }).click();
  const calendarDay = page
    .getByRole('list', { name: '계획 날짜 달력', exact: true })
    .locator(':scope > li')
    .filter({ has: firstSession });
  await expect(calendarDay).toContainText('2026-09-22');
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '계획 agenda 보기', exact: true }).click();
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  await expect(date).toHaveValue('2026-09-22');
  expect(planWrites).toBe(0);
  expect((await readPlan()).head).toEqual(saved);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(date).toHaveValue('2026-09-20');
  await date.fill('2026-09-23');
  const note = page.getByLabel('세션 메모', { exact: true }).first();
  await note.fill('합성 초안 메모 — 반응형 보기 유지');
  await note.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue('합성 초안 메모 — 반응형 보기 유지');
    await expect(note).toBeFocused();
    await expect(date).toHaveValue('2026-09-23');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: '한 열 보기', exact: true }).click();
  await page.getByRole('button', { name: '계획 표 보기', exact: true }).click();
  await expect(row).toContainText('2026-09-23');
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  await expect(actuals).toContainText(`${marker} actual`);
  expect(planWrites).toBe(0);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '변경 미리보기', exact: true })).toBeVisible();
  expect(planWrites).toBe(0);
  const committedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/bff/v1/plans/current',
  );
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  expect((await committedResponse).status()).toBe(200);
  expect(planWrites).toBe(1);
  await expect(
    page.getByText(`계획 버전 ${saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(firstSession).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toContainText('2026-09-23');
  await expect(row).toContainText('합성 초안 메모 — 반응형 보기 유지');
  await expect(actuals).toContainText(`${marker} actual`);
  const committed = await readPlan();
  expect(committed.head?.version).toBe(saved.version + 1);
  expect(
    committed.head?.draft.sessions.find((session) => session.id === 'views-first'),
  ).toMatchObject({ date: '2026-09-23', notes: '합성 초안 메모 — 반응형 보기 유지' });
  expect(
    committed.head?.draft.sessions.find((session) => session.id === 'views-second')?.date,
  ).toBe('2026-09-21');
});
