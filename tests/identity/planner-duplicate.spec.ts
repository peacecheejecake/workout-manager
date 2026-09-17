import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityListSchema } from '../../packages/contracts/src/activity';
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

test('duplicating a selected locked session creates an isolated draft and requires explicit save', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const title = '가'.repeat(200);
  const draft = planDraftSchema.parse({
    title: 'Synthetic duplicate plan',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'original-session',
        blockId: 'block',
        date: '2026-09-20',
        localStartTime: null,
        title,
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: 0,
        purpose: 'Copy boundary fixture',
        notes: 'Preserve original',
        priority: 'normal',
        locks: { date: true, time: true, intensity: true },
        steps: [
          {
            id: 'original-step',
            kind: 'work',
            durationSeconds: null,
            distanceMeters: 0,
            repetitions: 1,
          },
        ],
      },
    ],
  });
  const current = await readPlan();
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  const readActivities = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const beforeActivities = await readActivities();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes++;
  });
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(
    '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&view=stack&plannedView=split&plannedSession=original-session',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('plannedSession'))
    .not.toBe('original-session');
  const firstCopyId = new URL(page.url()).searchParams.get('plannedSession');
  expect(firstCopyId).toBeTruthy();
  await expect(page.getByLabel('세션 제목', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('세션 제목', { exact: true })).toBeFocused();
  expect(writes).toBe(0);
  expect((await readPlan()).head).toEqual(saved);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page).not.toHaveURL(/plannedSession=/);
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  await expect(table.getByRole('button', { name: /^계획:/ })).toHaveCount(1);
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect(page).toHaveURL(/plannedSession=/);
  const copyId = new URL(page.url()).searchParams.get('plannedSession');
  assert.ok(copyId);
  expect(copyId).not.toBe(firstCopyId);
  await expect(table.getByRole('button', { name: /^계획:/ })).toHaveCount(2);
  await expect(table.locator('[data-planned-session][aria-pressed="true"]')).toHaveAttribute(
    'data-planned-session',
    copyId,
  );
  const calendar = page.getByRole('list', { name: '계획 날짜 달력', exact: true });
  await expect(calendar.locator('[data-planned-session][aria-pressed="true"]')).toHaveAttribute(
    'data-planned-session',
    copyId,
  );
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('Copy only');
  await note.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('Copy only');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  expect(writes).toBe(1);
  const next = (await readPlan()).head;
  expect(next?.draft.sessions).toHaveLength(2);
  expect(next?.draft.sessions.find((session) => session.id === 'original-session')).toEqual(
    draft.sessions[0],
  );
  const copy = next?.draft.sessions.find((session) => session.id === copyId);
  expect(copy).toMatchObject({
    title,
    date: '2026-09-20',
    blockId: 'block',
    localStartTime: null,
    distanceMeters: 0,
    durationSeconds: null,
    targetRpe: 0,
    notes: 'Copy only',
    locks: { date: false, time: false, intensity: false },
  });
  expect(copy?.steps).toHaveLength(1);
  expect(copy?.steps[0]?.id).not.toBe('original-step');
  expect(copy?.steps[0]).toMatchObject({
    kind: 'work',
    durationSeconds: null,
    distanceMeters: 0,
    repetitions: 1,
  });
  expect(await readActivities()).toEqual(beforeActivities);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`plannedSession=${copyId}`));
  await expect(page.getByRole('region', { name: '선택한 계획 세션', exact: true })).toContainText(
    '저장된 계획',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(page.getByLabel('세션 메모', { exact: true })).toHaveValue('Copy only');
});
