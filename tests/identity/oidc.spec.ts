import { test, expect } from '@playwright/test';

test('actual OIDC login, consent, logout, and separate account isolation', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('현재 동의: 허용하지 않음')).toBeVisible();
  const sessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'workout_session',
  );
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Lax');
  const session = await page.request.get('/bff/v1/session');
  const alice = (await session.json()) as {
    athleteId: string;
    csrfToken: string;
    sessionId: string;
  };
  const rejected = await page.request.put('/bff/v1/consents/ai', {
    data: { granted: true, expectedRevision: 0 },
    headers: { 'idempotency-key': 'no-csrf-token', 'x-workout-session-id': alice.sessionId },
  });
  expect(rejected.status()).toBe(403);
  await page.getByRole('button', { name: 'AI 전달에 동의' }).click();
  await expect(page.getByText('현재 동의: 허용', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'AI 동의 철회' })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Bob' }).click();
  await expect(page.getByText('현재 동의: 허용하지 않음')).toBeVisible();
  const bob = (await (await page.request.get('/bff/v1/session')).json()) as { athleteId: string };
  expect(bob.athleteId).not.toBe(alice.athleteId);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test('a second-tab account switch cannot populate the previous session consent cache', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const alice = (await (await page.request.get('/bff/v1/session')).json()) as { athleteId: string };
  let releaseSession: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route('**/bff/v1/session', async (route) => {
    await delayed;
    await route.continue().catch(() => {}); // An account mismatch cancels the obsolete request.
  });
  const second = await context.newPage();
  await second.goto('/bff/v1/auth/login');
  await second.getByRole('link', { name: 'Sign in as Bob' }).click();
  await expect(second.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const bob = (await (await second.request.get('/bff/v1/session')).json()) as { athleteId: string };
  expect(bob.athleteId).not.toBe(alice.athleteId);
  const rejected = page.waitForResponse(
    (response) => response.url().endsWith('/bff/v1/consents/ai') && response.status() === 409,
  );
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await rejected;
  await expect(page.getByText(`로그인된 계정: ${alice.athleteId}`)).toBeHidden();
  releaseSession();
  await expect(page.getByText(`로그인된 계정: ${bob.athleteId}`)).toBeVisible();
  await expect(page.getByText('현재 동의: 허용하지 않음')).toBeVisible();
  await second.close();
});
