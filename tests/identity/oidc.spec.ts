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
  // Browser storage holds exactly one entry: the account scope the private-storage helper
  // writes so a previous account's opt-in drafts are cleared before a new one mounts. It
  // names the current athlete and nothing else — no token, no session id, no CSRF token.
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  expect(Object.keys(storage.local)).toEqual(['workout:private:account-scope']);
  expect(storage.local['workout:private:account-scope']).toBe(bob.athleteId);
  expect(storage.session).toEqual({});
  expect(JSON.stringify(storage)).not.toContain(alice.athleteId);
  expect(JSON.stringify(storage)).not.toContain(alice.csrfToken);
  expect(JSON.stringify(storage)).not.toContain(alice.sessionId);
});

test('a second-tab account switch cannot populate the previous session consent cache', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await expect(page.getByText('현재 동의:', { exact: false })).toBeVisible();
  const alice = (await (await page.request.get('/bff/v1/session')).json()) as {
    athleteId: string;
    sessionId: string;
  };
  let releaseSession: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  // The account screen refetches three session-bound reads on visibility: consent, Garmin
  // status and operations status. Whichever SESSION_CHANGED answer lands first tears the old
  // account down and aborts the other two, so without holding the panels back the consent
  // read loses that race about one time in fifteen and its 409 is never delivered (M2-01v).
  // Holding them keeps the consent read the only one that can answer, so this test always
  // exercises the path it is named for.
  const heldUntilRelease = new Set([
    '/bff/v1/session',
    '/bff/v1/integrations/garmin/status',
    '/bff/v1/operations/status',
  ]);
  await page.route(
    (url) => heldUntilRelease.has(url.pathname),
    async (route) => {
      await delayed;
      await route.continue().catch(() => {}); // An account mismatch cancels the obsolete request.
    },
  );
  const second = await context.newPage();
  await second.goto('/bff/v1/auth/login');
  await second.getByRole('link', { name: 'Sign in as Bob' }).click();
  await expect(second.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const bob = (await (await second.request.get('/bff/v1/session')).json()) as { athleteId: string };
  expect(bob.athleteId).not.toBe(alice.athleteId);
  // Every consent answer this tab receives for Alice's session from here on, whatever its
  // status. The property under test is that none of them can be a consent head once Bob owns
  // the cookie.
  const aliceConsentAnswers: number[] = [];
  page.on('response', (response) => {
    if (
      response.url().endsWith('/bff/v1/consents/ai') &&
      response.request().method() === 'GET' &&
      response.request().headers()['x-workout-session-id'] === alice.sessionId
    )
      aliceConsentAnswers.push(response.status());
  });
  const rejected = page.waitForResponse(
    (response) => response.url().endsWith('/bff/v1/consents/ai') && response.status() === 409,
  );
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await rejected;
  await expect(page.getByText(`로그인된 계정: ${alice.athleteId}`)).toBeHidden();
  expect(aliceConsentAnswers.filter((status) => status !== 409)).toEqual([]);
  releaseSession();
  await expect(page.getByText(`로그인된 계정: ${bob.athleteId}`)).toBeVisible();
  await expect(page.getByText('현재 동의: 허용하지 않음')).toBeVisible();
  expect(aliceConsentAnswers.filter((status) => status !== 409)).toEqual([]);
  await second.close();
});
