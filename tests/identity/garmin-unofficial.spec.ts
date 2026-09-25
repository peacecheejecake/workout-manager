import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';
import { unofficialAccounts, unofficialOwner } from '../../scripts/fixtures/garmin-unofficial';

/**
 * The temporary unofficial Garmin collector (M1-06b-tmp) end to end: the real app shells, API,
 * PostgreSQL, the TypeScript bridge and the Python worker, with the worker's SYNTHETIC
 * provider (`--fixture`). No live Garmin account is involved; a real-account run is separate
 * evidence the owner produces by logging in through the app.
 *
 * The fixture account "Carol" is the deployment's configured owner; "Bob" is anyone else.
 * The tests share the owner's connection and run in order.
 */
test.describe.configure({ mode: 'serial' });

const shells = {
  Next: 'http://127.0.0.1:3100',
  Vite: 'http://127.0.0.1:4200',
} as const;
const statusPath = '/bff/v1/integrations/garmin-unofficial/status';

async function login(page: Page, name: 'Bob' | 'Carol') {
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
      'athleteId' in session &&
      typeof session.athleteId === 'string' &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    athleteId: session.athleteId,
    headers: {
      origin: shells.Next,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    },
  };
}
function panel(page: Page) {
  return page.getByRole('region', { name: '비공식 임시 Garmin 연결', exact: true });
}
async function unofficialState(page: Page, headers: Record<string, string>) {
  const response = await page.request.get(statusPath, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    provider: string;
    official: boolean;
    state: string;
    lastRun: {
      id: string;
      state: string;
      imported: number;
      skipped: number;
      suppressed: number;
    } | null;
  };
}
async function activityIds(page: Page, headers: Record<string, string>) {
  const response = await page.request.get('/bff/v1/activities?limit=100', { headers });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: { id: string; revision: number }[] };
  return body.items;
}
/** Click "지금 가져오기" and wait for a NEW run to finish; returns that run. */
async function importNow(page: Page, headers: Record<string, string>) {
  const before = (await unofficialState(page, headers)).lastRun?.id ?? null;
  await panel(page).getByRole('button', { name: '지금 가져오기' }).click();
  await expect
    .poll(
      async () => {
        const run = (await unofficialState(page, headers)).lastRun;
        return run !== null && run.id !== before ? run.state : 'waiting';
      },
      { timeout: 30_000 },
    )
    .toBe('succeeded');
  const run = (await unofficialState(page, headers)).lastRun;
  assert.ok(run);
  // The screen shows the same finished run.
  await expect(panel(page).getByText('완료 · 직접')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '지금 가져오기' })).toBeEnabled();
  return run;
}
async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}
/** The password must not appear in any URL the browser requests or in browser storage. */
function watchForPassword(page: Page, password: string) {
  const leaks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(password) || request.url().includes(encodeURIComponent(password)))
      leaks.push(request.url());
  });
  return async () => {
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toContain(password);
    expect(leaks).toEqual([]);
  };
}

test('a non-owner account never sees the unofficial connection and gets the fixed 403', async ({
  page,
}) => {
  const bob = await login(page, 'Bob');
  expect(bob.athleteId).not.toBe(unofficialOwner.athleteId);
  await expect(page.getByRole('heading', { name: 'Garmin 연결 설정' })).toBeVisible();
  await expect(page.getByText('Garmin 연결 상태:', { exact: false })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText(/비공식 임시 Garmin 연결/)).toHaveCount(0);
  const refused = await page.request.get(statusPath, { headers: bob.headers });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: 'GARMIN_UNOFFICIAL_OWNER_ONLY' } });
  const refusedLogin = await page.request.post('/bff/v1/integrations/garmin-unofficial/login', {
    headers: bob.headers,
    data: { email: unofficialAccounts.plain.email, password: unofficialAccounts.plain.password },
  });
  expect(refusedLogin.status()).toBe(403);
});

test('Next shell: the owner connects with MFA, imports, sees the unofficial label, deletes, and disconnects', async ({
  page,
}) => {
  const owner = await login(page, 'Carol');
  expect(owner.athleteId).toBe(unofficialOwner.athleteId);
  const checkPassword = watchForPassword(page, unofficialAccounts.mfa.password);
  const section = panel(page);
  await expect(section).toBeVisible();
  await expect(section.getByText('공식 Garmin 연동이 아닌 비공식 임시 연결입니다.')).toBeVisible();
  await expect(section.getByText('Garmin 이용약관에 어긋날 수 있습니다.')).toBeVisible();
  // The official panel keeps its own, separate status.
  await expect(page.getByText('Garmin 연결 상태: 연결되지 않음', { exact: true })).toBeVisible();
  await expect(section.getByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
  // The erase screen warns that erasure cannot end the Garmin-side session.
  await expect(page.getByText(/비공식 임시 Garmin 연결: 계정을 삭제하면/)).toBeVisible();

  await section.getByLabel('Garmin 이메일').fill(unofficialAccounts.mfa.email);
  await section.getByLabel('Garmin 비밀번호').fill(unofficialAccounts.mfa.password);
  await section.getByRole('button', { name: '비공식 연결 로그인' }).click();
  await expect(section.getByText('비공식 연결 상태: 인증 코드 입력 대기')).toBeVisible();
  await section.getByLabel('Garmin 인증 코드').fill('000000');
  await section.getByRole('button', { name: '인증 코드 확인' }).click();
  await expect(section.getByRole('alert')).toContainText('인증 코드가 맞지 않습니다');
  await section.getByLabel('Garmin 인증 코드').fill(unofficialAccounts.mfa.code);
  await section.getByRole('button', { name: '인증 코드 확인' }).click();
  await expect(section.getByText('비공식 연결 상태: 연결됨')).toBeVisible();
  await checkPassword();
  const connected = await unofficialState(page, owner.headers);
  expect(connected).toMatchObject({
    provider: 'garmin-connect-unofficial',
    official: false,
    state: 'connected',
  });
  expect(JSON.stringify(connected)).not.toContain('di_token');

  expect(await importNow(page, owner.headers)).toMatchObject({ imported: 2, skipped: 0 });
  await expect(section.getByText(/새로 가져옴 2/)).toBeVisible();
  const imported = await activityIds(page, owner.headers);
  expect(imported).toHaveLength(2);

  // The activity carries the unofficial provenance label.
  const first = imported[0];
  assert.ok(first);
  await page.goto(`/activities?selected=${first.id}`);
  const source = page.getByRole('region', { name: '활동 요약 출처', exact: true });
  await expect(source.getByText('비공식 임시 Garmin 연결로 가져온 활동')).toBeVisible();
  await expect(source.getByText(/공식 Garmin 연동이 아닙니다/)).toBeVisible();

  // Deleted locally, it is not collected again by the next run.
  const deleted = await page.request.delete(`/bff/v1/activities/${first.id}`, {
    headers: owner.headers,
    data: { expectedRevision: first.revision },
  });
  expect(deleted.status()).toBe(204);
  await page.goto('/account');
  expect(await importNow(page, owner.headers)).toMatchObject({ imported: 0, skipped: 2 });
  await expect(section.getByText(/이미 처리됨 2/)).toBeVisible();
  const after = await activityIds(page, owner.headers);
  expect(after.map((item) => item.id)).not.toContain(first.id);
  expect(after).toHaveLength(1);

  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section.getByRole('button', { name: '지금 가져오기' })).toBeVisible();
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  // Disconnect: the screen says Garmin's side cannot be ended from here, and how to end it.
  await expect(section.getByText(/Garmin 쪽 세션을 끊는 방법이 없어/)).toBeVisible();
  await expect(section.getByText(/Garmin 계정 비밀번호를 변경하고/)).toBeVisible();
  await section.getByRole('button', { name: '비공식 연결 해제' }).click();
  await expect(section.getByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
  await expect(
    section.getByText('처음 연결한 Garmin 계정으로만 다시 연결할 수 있습니다.'),
  ).toBeVisible();
  // Already imported data stays, with its label.
  expect(await activityIds(page, owner.headers)).toHaveLength(1);
});

test('Vite shell: the owner reconnects without MFA, the rerun imports nothing new, and the panel reflows', async ({
  page,
}) => {
  const owner = await login(page, 'Carol');
  await page.goto(`${shells.Vite}/account`);
  const section = panel(page);
  await expect(section).toBeVisible();
  await section.getByLabel('Garmin 이메일').fill(unofficialAccounts.plain.email);
  await section.getByLabel('Garmin 비밀번호').fill(unofficialAccounts.plain.password);
  await section.getByRole('button', { name: '비공식 연결 로그인' }).click();
  await expect(section.getByText('비공식 연결 상태: 연결됨')).toBeVisible();
  expect(await importNow(page, owner.headers)).toMatchObject({ imported: 0, skipped: 2 });
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section.getByRole('button', { name: '비공식 연결 해제' })).toBeVisible();
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await section.getByRole('button', { name: '비공식 연결 해제' }).click();
  await expect(section.getByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
});

test('a different Garmin account is refused after the first one was pinned', async ({ page }) => {
  const owner = await login(page, 'Carol');
  const section = panel(page);
  await section.getByLabel('Garmin 이메일').fill(unofficialAccounts.otherProfile.email);
  await section.getByLabel('Garmin 비밀번호').fill(unofficialAccounts.otherProfile.password);
  await section.getByRole('button', { name: '비공식 연결 로그인' }).click();
  await expect(section.getByRole('alert')).toContainText(
    '처음 연결한 Garmin 계정과 다른 계정이라 연결하지 않았습니다',
  );
  expect((await unofficialState(page, owner.headers)).state).toBe('not_connected');
});
