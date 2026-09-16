import { expect, test, type Page } from '@playwright/test';

interface Session {
  athleteId: string;
  sessionId: string;
  csrfToken: string;
}

async function session(page: Page): Promise<Session> {
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  return response.json() as Promise<Session>;
}

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  return session(page);
}

async function status(page: Page) {
  const current = await session(page);
  const response = await page.request.get('/bff/v1/integrations/garmin/status', {
    headers: { 'x-workout-session-id': current.sessionId },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{
    state: string;
    permissions: string[];
    connectedAt: string | null;
  }>;
}

async function begin(page: Page) {
  await page.getByRole('button', { name: 'Garmin 공식 계정 연결', exact: true }).click();
  await expect(page.getByRole('heading', { name: '로컬 Garmin OAuth 검증' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:4500');
}

// These journeys use the real app/API/database and a synthetic OAuth server, not live Garmin.
test('Garmin approval preserves OIDC identity; replay is rejected and disconnect leaves app login intact', async ({
  page,
}) => {
  const before = await login(page, 'Alice');
  await begin(page);
  const callbackRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith('/integrations/garmin/callback'),
  );
  await page.getByRole('link', { name: '테스트 활동 공유 허용' }).click();
  const callbackUrl = (await callbackRequest).url();
  await expect(page).toHaveURL(/\/account\?garmin=connected$/);
  await expect(page.getByText('Garmin 연결 상태: 연결됨', { exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^ACTIVITY_EXPORT$/ })).toBeVisible();
  await expect(
    page.getByText(/연결 승인은 활동 가져오기나 동기화 완료를 의미하지 않습니다/),
  ).toBeVisible();
  expect(await session(page)).toMatchObject({ ...before });
  const connected = await status(page);
  expect(connected).toMatchObject({ state: 'connected', permissions: ['ACTIVITY_EXPORT'] });
  expect(connected.connectedAt).not.toBeNull();

  await page.goto(callbackUrl);
  await expect(page).toHaveURL(/\/account\?garmin=failed$/);
  await expect(page.getByText('Garmin 연결 상태: 연결됨', { exact: true })).toBeVisible();
  expect(await status(page)).toEqual(connected);

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('button', { name: 'Garmin 연결 해제', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.getByRole('button', { name: 'Garmin 연결 해제', exact: true }).click();
  await expect.poll(async () => (await status(page)).state).toBe('not_connected');
  await page.getByRole('button', { name: 'Garmin 상태 다시 확인' }).click();
  await expect(page.getByText('Garmin 연결 상태: 연결되지 않음', { exact: true })).toBeVisible();
  await expect(page.getByText(`로그인된 계정: ${before.athleteId}`, { exact: true })).toBeVisible();
  expect(await session(page)).toMatchObject({ ...before });
});

test('provider denial leaves Garmin disconnected and a forged success query is not trusted', async ({
  page,
}) => {
  const before = await login(page, 'Alice');
  await begin(page);
  await page.getByRole('link', { name: '테스트 연결 거절' }).click();
  await expect(page).toHaveURL(/\/account\?garmin=denied$/);
  await expect(page.getByText('Garmin 연결 상태: 연결되지 않음', { exact: true })).toBeVisible();
  expect(await status(page)).toMatchObject({
    state: 'not_connected',
    permissions: [],
    connectedAt: null,
  });
  await page.goto('/account?garmin=connected');
  await expect(page.getByText('Garmin 연결 상태: 연결되지 않음', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Garmin 공식 계정 연결', exact: true }),
  ).toBeEnabled();
  expect(await session(page)).toMatchObject({ ...before });
});

for (const nextAccount of ['Alice', 'Bob'] as const) {
  test(`an old Garmin callback cannot attach after logout and ${nextAccount} login`, async ({
    page,
    context,
  }) => {
    const original = await login(page, 'Alice');
    await begin(page);
    const approvalHref = await page
      .getByRole('link', { name: '테스트 활동 공유 허용' })
      .getAttribute('href');
    expect(approvalHref).not.toBeNull();
    const approvalUrl = new URL(approvalHref ?? '', page.url()).href;
    const second = await context.newPage();
    await second.goto('/account');
    await second.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(second.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
    const replacement = await login(second, nextAccount);
    expect(replacement.sessionId).not.toBe(original.sessionId);
    if (nextAccount === 'Bob') expect(replacement.athleteId).not.toBe(original.athleteId);
    else expect(replacement.athleteId).toBe(original.athleteId);

    // Complete the original provider approval using the replacement browser session.
    await page.goto(approvalUrl);
    await expect(page).toHaveURL(/\/account\?garmin=failed$/);
    await expect(
      page.getByText(`로그인된 계정: ${replacement.athleteId}`, { exact: true }),
    ).toBeVisible();
    expect(await session(page)).toMatchObject({ ...replacement });
    expect(await status(page)).toMatchObject({
      state: 'not_connected',
      permissions: [],
      connectedAt: null,
    });
    await second.close();
  });
}
