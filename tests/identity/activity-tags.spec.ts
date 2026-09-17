import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { selectedActivityExportSchema } from '../../packages/contracts/src/activity-export';
import {
  activitySchema,
  manualActivityResultSchema,
  activityListSchema,
} from '../../packages/contracts/src/activity';

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
  const marker = `tags-${randomUUID()}`;
  const read = async (id: string) => {
    const response = await page.request.get(`/bff/v1/activities/${id}`, { headers });
    expect(response.status()).toBe(200);
    return activitySchema.parse(await response.json());
  };
  const response = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      activity: {
        title: marker,
        kind: 'running',
        startedAt: '2026-09-15T00:00:00Z',
        timezone: 'Asia/Seoul',
        durationSeconds: null,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: 0, note: '태그와 별도 자기보고', planLink: null },
    },
  });
  expect(response.status()).toBe(200);
  const id = manualActivityResultSchema.parse(await response.json()).activityId;
  const original = await read(id);
  await page.goto(`/activities?${new URLSearchParams({ search: marker, selected: id })}`);
  await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
  const panel = page.getByRole('region', { name: '선택 활동 일괄 태그', exact: true });
  const prepare = async (tag: string, action = 'add') => {
    await panel.getByRole('combobox', { name: '일괄 태그 동작', exact: true }).selectOption(action);
    await panel.getByLabel('변경할 로컬 태그', { exact: true }).fill(tag);
    await panel
      .getByRole('textbox', { name: '일괄 태그 변경 사유', exact: true })
      .fill('합성 태그 분류');
    await panel.getByRole('button', { name: '태그 변경 미리보기', exact: true }).click();
  };
  const close = async () => {
    await panel.getByRole('button', { name: '태그 변경 결과 닫기', exact: true }).click();
    await expect(page.getByRole('region', { name: '활동 일괄 선택', exact: true })).toContainText(
      '일괄 선택 0개',
    );
    await expect(page.getByRole('button', { name: '일괄 선택 해제', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '활동 목록 다시 확인', exact: true }).click();
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
  };
  return { headers, id, marker, read, original, panel, prepare, close };
}

test('local tag confirmation preserves observations, exact literal filters and version-two selected export', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const f = await setup(page);
  const tag = '산 / 길_% é';
  const decomposedInput = `  ${tag.normalize('NFD')}  `;
  expect(decomposedInput.trim()).not.toBe(tag);
  expect(decomposedInput.trim().normalize('NFC')).toBe(tag);
  await f.prepare(decomposedInput);
  expect(await f.read(f.id)).toEqual(f.original);
  const cancel = f.panel.getByRole('button', { name: '태그 변경 취소', exact: true });
  await cancel.focus();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cancel.press('Enter');
  expect(await f.read(f.id)).toEqual(f.original);
  await f.prepare(decomposedInput);
  await page.setViewportSize({ width: 1280, height: 900 });
  await f.panel.getByRole('button', { name: '태그 변경 확인', exact: true }).click();
  await f.close();
  const tagged = await f.read(f.id);
  expect(tagged.overlay.tags).toEqual([tag]);
  expect(tagged.revision).toBe(f.original.revision + 1);
  expect(tagged.original).toEqual(f.original.original);
  expect(tagged.effective).toEqual(f.original.effective);
  expect(tagged.userReport).toEqual(f.original.userReport);
  await page.getByLabel('로컬 태그 필터', { exact: true }).fill(tag);
  await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe(tag);
  await page.reload();
  await expect(page.getByRole('button', { name: f.marker, exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('selected')).toBe(f.id);
  for (const value of [tag, '산 / 길_% É', '%', 'é']) {
    const result = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ tag: value, search: f.marker })}`,
      { headers: f.headers },
    );
    expect(result.status()).toBe(200);
    expect(activityListSchema.parse(await result.json()).total).toBe(value === tag ? 1 : 0);
  }
  await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
  const exporter = page.getByRole('region', { name: '선택 활동 요약 내보내기', exact: true });
  await exporter.getByRole('button', { name: '선택 활동 내보내기 미리보기', exact: true }).click();
  await exporter
    .getByRole('button', { name: '확인하고 내보내기 파일 만들기', exact: true })
    .click();
  const download = page.waitForEvent('download');
  await exporter.getByRole('link', { name: '선택 활동 JSON 다운로드', exact: true }).click();
  const path = await (await download).path();
  assert.ok(path);
  const exported = selectedActivityExportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  expect(exported.schemaVersion).toBe(2);
  expect(exported.activities).toEqual([tagged]);
  await exporter.getByRole('button', { name: '내보내기 닫기', exact: true }).click();
  await f.prepare(tag, 'remove');
  await f.panel.getByRole('button', { name: '태그 변경 확인', exact: true }).click();
  await expect(
    f.panel.getByRole('button', { name: '태그 변경 결과 닫기', exact: true }),
  ).toBeVisible();
  const removed = await f.read(f.id);
  expect(removed.overlay.tags).toEqual([]);
  expect(removed.revision).toBe(tagged.revision + 1);
  expect(removed.original).toEqual(f.original.original);
  expect(removed.userReport).toEqual(f.original.userReport);
});

test('a real committed tag update with a lost response retries the same frozen key and body', async ({
  page,
}) => {
  const f = await setup(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const pattern = `**/bff/v1/activities/${f.id}`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    if (attempts.length !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await f.prepare('Easy');
  await f.panel.getByRole('button', { name: '태그 변경 확인', exact: true }).click();
  const retry = f.panel.getByRole('button', { name: '미확인 태그 변경 다시 확인', exact: true });
  await expect(retry).toBeVisible();
  expect((await f.read(f.id)).revision).toBe(f.original.revision + 1);
  await retry.click();
  await expect(retry).toBeHidden();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  const saved = await f.read(f.id);
  expect(saved.revision).toBe(f.original.revision + 1);
  expect(saved.overlay.tags).toEqual(['Easy']);
  expect(saved.userReport).toEqual(f.original.userReport);
  await page.unroute(pattern);
  await f.close();
  await f.prepare('Easy', 'remove');
  const competing = await page.request.patch(`/bff/v1/activities/${f.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: saved.revision,
      tags: ['Easy', 'Concurrent'],
      reason: '합성 동시 태그 변경',
    },
  });
  expect(competing.status()).toBe(200);
  await f.panel.getByRole('button', { name: '태그 변경 확인', exact: true }).click();
  await expect(f.panel).toContainText('수정 충돌: 최신 기록 확인 필요');
  await expect(retry).toBeHidden();
  expect((await f.read(f.id)).overlay.tags).toEqual(['Easy', 'Concurrent']);
  expect((await f.read(f.id)).revision).toBe(saved.revision + 1);
});
