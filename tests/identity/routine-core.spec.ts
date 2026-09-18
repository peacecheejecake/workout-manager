import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

type SessionHeaders = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const cleanup = new WeakMap<Page, SessionHeaders>();

async function login(page: Page, name: 'Alice' | 'Bob' = 'Alice') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session = (await response.json()) as { sessionId: string; csrfToken: string };
  const headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  cleanup.set(page, headers);
  return headers;
}

test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (!headers) return;
  cleanup.delete(page);
  const erased = await page.request.delete('http://127.0.0.1:3100/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

test('a routine blueprint schedules one occurrence and confirms a checklist run without creating an Activity', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const headers = cleanup.get(page);
  if (!headers) throw new Error('Expected authenticated session');
  const activityBefore = await page.request.get('/bff/v1/activities?limit=1', { headers });
  expect(activityBefore.status()).toBe(200);
  const activityBeforeBody = await activityBefore.json();

  await page.goto('/routines');
  const workspace = page.getByRole('region', { name: '범용 루틴 작업 공간' });
  await workspace.getByRole('button', { name: '새 루틴' }).click();
  const title = `Synthetic checklist ${randomUUID()}`;
  await workspace.getByRole('textbox', { name: '제목', exact: true }).fill(title);
  await workspace.getByRole('button', { name: '단계 추가' }).click();
  await workspace.getByRole('textbox', { name: '단계 제목' }).fill('준비물 확인');
  await workspace.getByRole('textbox', { name: '확인 문구' }).fill('사용자 확인만 기록');
  await workspace.getByRole('button', { name: '루틴 버전 저장' }).click();
  await expect(workspace.getByRole('status')).toContainText('루틴 버전 1을 저장했습니다');
  const routineLink = workspace.getByRole('link', { name: title });
  const routinePath = await routineLink.getAttribute('href');
  if (!routinePath) throw new Error('Expected saved routine link');
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    const denied = await other.request.get(`/bff/v1${routinePath}`, { headers: otherHeaders });
    expect(denied.status()).toBe(404);
    const erased = await other.request.delete('/bff/v1/operations/account', {
      headers: otherHeaders,
      data: { confirmation: 'DELETE MY ACCOUNT' },
    });
    expect(erased.status()).toBe(200);
    cleanup.delete(other);
  } finally {
    await otherContext.close();
  }
  await routineLink.click();
  await expect(workspace.getByRole('heading', { name: '루틴 상세' })).toBeVisible();
  await workspace.getByRole('link', { name: '일정 미리보기' }).click();

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await workspace.getByLabel('현지 날짜').fill(tomorrow);
  await workspace.getByLabel('시간대').fill('UTC');
  await workspace.getByRole('button', { name: '영향 미리보기' }).click();
  await expect(workspace).toContainText('발생분 1개');
  await workspace.getByRole('button', { name: '표시된 루틴 발생분 승인' }).click();
  await expect(workspace.getByRole('status')).toContainText('발생분 1개를 승인했습니다');
  await workspace.getByRole('button', { name: '이 발생분 실행' }).click();
  await expect(page).toHaveURL(/\/routine-runs\/[a-f0-9-]+$/);
  await workspace.getByRole('button', { name: '수행 확인' }).click();
  await expect(workspace).toContainText('수행 1개 · 미확인 0개');

  const activityAfter = await page.request.get('/bff/v1/activities?limit=1', { headers });
  expect(activityAfter.status()).toBe(200);
  expect(await activityAfter.json()).toEqual(activityBeforeBody);
});
