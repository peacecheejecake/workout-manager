import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { certifiedOidcContextPath } from '../../scripts/fixtures/certified-oidc-context';

/**
 * M2-01u: the browser journey against a locally hosted OpenID Certified OP (oidc-provider),
 * which — unlike the hand-written fixture — keeps its own single sign-on session.
 *
 *   IDENTITY_E2E_OIDC=certified pnpm test:identity tests/identity/oidc-certified.spec.ts
 *
 * This is local-OP evidence, not evidence about the production identity provider.
 */
test.skip(
  process.env['IDENTITY_E2E_OIDC'] !== 'certified',
  'Runs only with IDENTITY_E2E_OIDC=certified (the harness must host the certified OP).',
);

const opOrigin = 'http://127.0.0.1:4400';
function passwords(): Record<'alice' | 'bob', string> {
  return (
    JSON.parse(readFileSync(certifiedOidcContextPath, 'utf8')) as {
      passwords: Record<'alice' | 'bob', string>;
    }
  ).passwords;
}
async function signInAtProvider(page: Page, account: 'alice' | 'bob') {
  await expect(
    page.getByRole('heading', { name: 'Certified identity provider sign-in' }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(opOrigin);
  await page.getByLabel('Username').fill(account);
  await page.getByLabel('Password').fill(passwords()[account]);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function athlete(page: Page) {
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { athleteId: string }).athleteId;
}

test('real OP: sign-in, sign-out, re-authenticated account switch and stable account mapping', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await signInAtProvider(page, 'alice');
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('현재 동의: 허용하지 않음')).toBeVisible();
  const alice = await athlete(page);
  const opSession = (await context.cookies(opOrigin)).find((cookie) => cookie.name === '_session');
  expect(opSession, 'the OP keeps its own SSO session').toBeDefined();

  // App sign-out: the product session is revoked server-side; the OP session is not.
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
  expect((await context.cookies(opOrigin)).some((cookie) => cookie.name === '_session')).toBe(true);
  const marker = (await context.cookies()).find((cookie) => cookie.name === 'workout_signed_out');
  expect(marker?.httpOnly).toBe(true);

  // The next sign-in must not be answered from the OP's SSO session: the OP asks again, and
  // a different person can sign in with their own account.
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await signInAtProvider(page, 'bob');
  await expect(page).toHaveURL(/\/account$/);
  const bob = await athlete(page);
  expect(bob).not.toBe(alice);
  expect((await context.cookies()).some((cookie) => cookie.name === 'workout_signed_out')).toBe(
    false,
  );

  // Switching while signed in also re-authenticates, and the same OP subject maps back to
  // the same athlete.
  await page.goto('/bff/v1/auth/login');
  await signInAtProvider(page, 'alice');
  await expect(page).toHaveURL(/\/account$/);
  expect(await athlete(page)).toBe(alice);
});

test('real OP: a first sign-in keeps single sign-on; a session-less sign-out and a cancel still ask again', async ({
  page,
  context,
}) => {
  await page.goto('/bff/v1/auth/login');
  await signInAtProvider(page, 'bob');
  await expect(page).toHaveURL(/\/account$/);
  const bob = await athlete(page);

  // A browser that never signed out of this app (only the product cookies are gone) and
  // still holds the OP session is signed in without a credential prompt.
  const opCookies = (await context.cookies()).filter(
    (cookie) => !cookie.name.startsWith('workout_'),
  );
  await context.clearCookies();
  await context.addCookies(opCookies);
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(await athlete(page)).toBe(bob);

  // Sign-out after the app session has already gone (expired or revoked elsewhere): the API
  // answers 401, which the screen treats as signed out, and it must still leave the marker —
  // otherwise the OP's live SSO session signs the previous user straight back in.
  const withoutSession = (await context.cookies()).filter(
    (cookie) => cookie.name !== 'workout_session',
  );
  await context.clearCookies();
  await context.addCookies(withoutSession);
  const stale = await page.request.post('/bff/v1/auth/logout', {
    headers: { origin: 'http://127.0.0.1:3100' },
  });
  expect(stale.status()).toBe(401);
  expect((await context.cookies()).some((cookie) => cookie.name === 'workout_signed_out')).toBe(
    true,
  );
  await page.goto('/bff/v1/auth/login');
  await signInAtProvider(page, 'alice');
  await expect(page).toHaveURL(/\/account$/);
  expect(await athlete(page)).not.toBe(bob);

  // Cancel at the OP: error=access_denied reaches the callback and no session is created.
  await context.clearCookies();
  await page.goto('/bff/v1/auth/login');
  await expect(
    page.getByRole('heading', { name: 'Certified identity provider sign-in' }),
  ).toBeVisible();
  const callback = page.waitForResponse((response) =>
    response.url().startsWith('http://127.0.0.1:3100/bff/v1/auth/callback'),
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
  const rejected = await callback;
  expect(new URL(rejected.url()).searchParams.get('error')).toBe('access_denied');
  expect(rejected.status()).toBe(401);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
});
