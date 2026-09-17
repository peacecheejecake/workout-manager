import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  coachingConstraintListSchema,
  coachingConstraintCommandResultSchema,
} from '../../packages/contracts/src/coaching-constraints';
import { planReadSchema } from '../../packages/contracts/src/planning';
import { activityListSchema } from '../../packages/contracts/src/activity';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
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
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
});
const base = '/bff/v1/coaching-constraints';
const panel = (page: Page) => page.getByRole('region', { name: '필수 사용자 제약', exact: true });
const input = (page: Page) =>
  panel(page).getByRole('textbox', { name: '사용자 제약 문장', exact: true });
const review = (page: Page) =>
  panel(page).getByRole('button', { name: '제약 변경 검토', exact: true });
const confirmation = (page: Page) =>
  panel(page).getByRole('group', { name: '사용자 제약 변경 확인', exact: true });
async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const list = async () => coachingConstraintListSchema.parse(await get(base));
  const initialPlan = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const initialActuals = activityListSchema.parse(await get('/bff/v1/activities'));
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/bff/v1/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${path}`);
  });
  const assertUnchanged = async () => {
    expect(planReadSchema.parse(await get('/bff/v1/plans/current'))).toEqual(initialPlan);
    expect(activityListSchema.parse(await get('/bff/v1/activities'))).toEqual(initialActuals);
  };
  return { headers, list, writes, assertUnchanged };
}
async function confirm(page: Page, method: 'POST' | 'PUT' | 'DELETE', path: string) {
  const response = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === path && reply.request().method() === method,
  );
  await confirmation(page).getByRole('button', { name: '확인하고 제약 변경', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return coachingConstraintCommandResultSchema.parse(await result.json());
}

// Actual OIDC/BFF/private PostgreSQL; this ledger stores user-confirmed text without modifying a plan.
test('reviews, creates, updates and removes confirmed constraints while preserving responsive drafts and absent versus cleared meaning', async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto('/coach');
  await expect(panel(page)).toContainText('사용자 제약을 아직 확인하지 않았습니다.');
  expect(await f.list()).toEqual({ headRevision: null, items: [] });
  const original = '합성 제약: 주말 오전에는 운동할 수 없습니다.';
  await input(page).fill(original);
  await review(page).click();
  await expect(confirmation(page)).toContainText(original);
  const cancel = confirmation(page).getByRole('button', { name: '제약 변경 취소', exact: true });
  await expect(cancel).toBeFocused();
  expect(f.writes).toEqual([]);
  expect((await f.list()).headRevision).toBeNull();
  await cancel.click();
  await expect(review(page)).toBeFocused();
  await expect(input(page)).toHaveValue(original);
  await review(page).click();
  const created = await confirm(page, 'POST', base);
  expect(created).toMatchObject({ revision: 1, headRevision: 1, deleted: false });
  await expect(input(page)).toHaveValue('');
  await expect(
    panel(page).getByRole('button', { name: `제약 수정 · ${original}`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel(page).getByRole('button', { name: `제약 수정 · ${original}`, exact: true }),
  ).toBeVisible();
  expect((await f.list()).items).toEqual([
    expect.objectContaining({ id: created.id, revision: 1, text: original }),
  ]);
  await panel(page)
    .getByRole('button', { name: `제약 수정 · ${original}`, exact: true })
    .click();
  const changed = '합성 제약: 토요일 오전만 운동할 수 없습니다.';
  await input(page).fill(changed);
  await input(page).focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue(changed);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await panel(page).getByRole('button', { name: '최신 제약 확인', exact: true }).click();
  await expect(review(page)).toBeEnabled();
  await expect(input(page)).toHaveValue(changed);
  expect((await f.list()).items[0]?.text).toBe(original);
  expect(f.writes).toEqual([`POST ${base}`]);
  await review(page).click();
  await expect(confirmation(page)).toContainText(changed);
  const path = `${base}/${created.id}`;
  const updated = await confirm(page, 'PUT', path);
  expect(updated).toEqual({ id: created.id, revision: 2, headRevision: 2, deleted: false });
  await expect(
    panel(page).getByRole('button', { name: `제약 삭제 · ${changed}`, exact: true }),
  ).toBeVisible();
  await page.reload();
  const remove = panel(page).getByRole('button', { name: `제약 삭제 · ${changed}`, exact: true });
  await remove.click();
  await expect(confirmation(page)).toContainText(changed);
  await confirmation(page).getByRole('button', { name: '제약 변경 취소', exact: true }).click();
  expect((await f.list()).headRevision).toBe(2);
  expect(f.writes).toEqual([`POST ${base}`, `PUT ${path}`]);
  await remove.click();
  expect(await confirm(page, 'DELETE', path)).toEqual({
    id: created.id,
    revision: 3,
    headRevision: 3,
    deleted: true,
  });
  await expect(panel(page)).toContainText('현재 저장된 사용자 제약 문장이 없습니다.');
  await expect(panel(page)).not.toContainText('사용자 제약을 아직 확인하지 않았습니다.');
  expect(await f.list()).toEqual({ headRevision: 3, items: [] });
  await page.reload();
  await expect(panel(page)).toContainText('현재 저장된 사용자 제약 문장이 없습니다.');
  await f.assertUnchanged();
  expect(f.writes).toEqual([`POST ${base}`, `PUT ${path}`, `DELETE ${path}`]);
});

test('keeps a conflicting constraint draft for fresh review and retries a committed lost response without a second revision', async ({
  page,
}) => {
  const f = await setup(page);
  const original = '합성 최초 제약';
  const seed = await page.request.post(base, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { expectedHeadRevision: null, confirmed: true, text: original },
  });
  expect(seed.status()).toBe(200);
  const created = coachingConstraintCommandResultSchema.parse(await seed.json());
  const path = `${base}/${created.id}`;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/coach');
  await panel(page)
    .getByRole('button', { name: `제약 수정 · ${original}`, exact: true })
    .click();
  const local = '동시 수정 후에도 남아야 하는 합성 제약 초안';
  await input(page).fill(local);
  await review(page).click();
  const concurrent = await page.request.put(path, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      text: '다른 탭에서 수정한 합성 제약',
    },
  });
  expect(concurrent.status()).toBe(200);
  const conflict = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === path && reply.request().method() === 'PUT',
  );
  await confirmation(page).getByRole('button', { name: '확인하고 제약 변경', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(input(page)).toHaveValue(local);
  await expect(review(page)).toBeDisabled();
  expect((await f.list()).headRevision).toBe(2);
  await panel(page).getByRole('button', { name: '최신 제약 확인', exact: true }).click();
  await expect(review(page)).toBeEnabled();
  await expect(input(page)).toHaveValue(local);
  await expect(panel(page)).toContainText('다른 탭에서 수정한 합성 제약');
  expect(f.writes).toEqual([`PUT ${path}`]);
  expect((await f.list()).headRevision).toBe(2);
  await review(page).focus();
  await page.keyboard.press('Enter');
  expect(await confirm(page, 'PUT', path)).toEqual({
    id: created.id,
    revision: 3,
    headRevision: 3,
    deleted: false,
  });
  await panel(page)
    .getByRole('button', { name: `제약 수정 · ${local}`, exact: true })
    .click();
  const lost = '응답만 유실된 합성 제약 정정';
  await input(page).fill(lost);
  await review(page).click();
  const attempts: { key: string | null; body: string | null }[] = [];
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    attempts.push({
      key: route.request().headers()['idempotency-key'] ?? null,
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await confirmation(page).getByRole('button', { name: '확인하고 제약 변경', exact: true }).click();
  const retry = panel(page).getByRole('button', { name: '같은 제약 요청 재확인', exact: true });
  await expect(retry).toBeVisible();
  await expect(input(page)).toHaveValue(lost);
  await expect(input(page)).toBeDisabled();
  const committed = await f.list();
  expect(committed.headRevision).toBe(4);
  expect(committed.items).toEqual([
    expect.objectContaining({ id: created.id, revision: 4, text: lost }),
  ]);
  await retry.click();
  await expect(input(page)).toHaveValue('');
  await expect(
    panel(page).getByRole('button', { name: `제약 수정 · ${lost}`, exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await f.list()).toEqual(committed);
  await page.reload();
  await expect(
    panel(page).getByRole('button', { name: `제약 수정 · ${lost}`, exact: true }),
  ).toBeVisible();
  expect(await f.list()).toEqual(committed);
  await f.assertUnchanged();
  expect(f.writes).toEqual(Array.from({ length: 4 }, () => `PUT ${path}`));
});
