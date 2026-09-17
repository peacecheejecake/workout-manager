import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

import { activityListSchema } from '../../packages/contracts/src/activity';

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

const plannerUrl =
  '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=agenda&plannedSession=quantity-session&view=stack';
async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const read = async () => planReadSchema.parse(await get('/bff/v1/plans/current'));
  const previous = await read();
  const actuals = activityListSchema.parse(await get('/bff/v1/activities'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic quantity ranges',
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
        id: 'quantity-session',
        blockId: 'block',
        date: '2026-09-20',
        localStartTime: null,
        title: 'Synthetic quantity session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: 0,
        intensityLabel: 'B',
        purpose: 'Preserve purpose',
        notes: 'Preserve note',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  const save = (expectedVersionId: string | null, next: unknown) =>
    page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft: next },
      timeout: 5000,
    });
  const created = await save(previous.head?.id ?? null, draft);
  expect(created.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await created.json());
  expect(saved.draft.sessions[0]).not.toHaveProperty('durationRange');
  expect(saved.draft.sessions[0]).not.toHaveProperty('distanceRange');
  await page.goto(plannerUrl);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  return { headers, get, read, save, saved, draft, actuals };
}
async function savePreview(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}
const durationMode = (page: Page) =>
  page.getByRole('combobox', { name: '계획 시간 입력 방식', exact: true });
const distanceMode = (page: Page) =>
  page.getByRole('combobox', { name: '계획 거리 입력 방식', exact: true });
async function ranges(page: Page) {
  await durationMode(page).selectOption('range');
  await page.getByLabel('계획 시간 하한 (초)', { exact: true }).fill('60');
  await page.getByLabel('계획 시간 상한 (초)', { exact: true }).fill('120');
  await distanceMode(page).selectOption('range');
  await page.getByLabel('계획 거리 하한 (m)', { exact: true }).fill('0');
  await page.getByLabel('계획 거리 상한 (m)', { exact: true }).fill('1000.25');
}

test('explicit range targets persist without scalar guesses and appear in dashboard, period summary and immutable history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const fixture = await setup(page);
  await ranges(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await expect(page.getByRole('button', { name: '계획 시간 적용', exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: '계획 길이 조절', exact: true })).toBeDisabled();
  await savePreview(page);
  const ranged = (await fixture.read()).head;
  assert.ok(ranged);
  expect(ranged.draft.sessions[0]).toEqual({
    ...fixture.draft.sessions[0],
    durationSeconds: null,
    distanceMeters: null,
    durationRange: { minSeconds: 60, maxSeconds: 120 },
    distanceRange: { minMeters: 0, maxMeters: 1000.25 },
  });
  await page.goto('/dashboard?anchor=2026-09-20&window=3&timezone=Asia%2FSeoul');
  const current = page.getByRole('region', { name: '현재 기간', exact: true });
  await expect(
    current.getByText('거리: 0–1000.25m · 알려진 1개 · 미보고 0개 · 범위 목표 1개', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    current.getByText('시간: 60–120초 · 알려진 1개 · 미보고 0개 · 범위 목표 1개', { exact: true }),
  ).toBeVisible();
  const chart = page.getByRole('img', { name: '날짜별 계획·실제 거리', exact: true });
  const segment = chart.locator('[data-series="planned-range"][data-date="2026-09-20"]');
  await expect(segment).toHaveAttribute('data-min', '0');
  await expect(segment).toHaveAttribute('data-max', '1000.25');
  await page.goto(
    `${plannerUrl}&lens=period&period=block&compareFrom=${fixture.saved.id}&compareTo=${ranged.id}`.replace(
      'lens=calendar&',
      '',
    ),
  );
  const summary = page.getByRole('region', { name: '저장된 기간 요약', exact: true });
  await expect(
    summary.getByText('거리: 0–1000.25 m · 알려진 1개 · 미정 0개 · 범위 목표 1개', { exact: true }),
  ).toBeVisible();
  const comparison = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  await comparison.getByText(/^세션 Synthetic quantity session ·/).click();
  await expect(comparison.getByRole('region', { name: '이후 세션', exact: true })).toContainText(
    '60–120',
  );
  await expect(comparison.getByRole('region', { name: '이후 세션', exact: true })).toContainText(
    '0–1000.25',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(durationMode(page)).toHaveValue('range');
  await durationMode(page).selectOption('single');
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeDisabled();
  await page.getByLabel('시간 (초, 미정 가능)', { exact: true }).fill('90');
  await savePreview(page);
  expect((await fixture.read()).head?.draft.sessions[0]).toMatchObject({
    durationSeconds: 90,
    durationRange: null,
    distanceRange: { minMeters: 0, maxMeters: 1000.25 },
  });
  expect(
    planSnapshotSchema.parse(await fixture.get(`/bff/v1/plans/versions/${fixture.saved.id}`)),
  ).toEqual(fixture.saved);
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});

test('invalid range edits cannot save, and saved intensity protection also applies to range targets while duplication preserves them', async ({
  page,
}) => {
  const fixture = await setup(page);
  await ranges(page);
  await page.getByLabel('계획 시간 하한 (초)', { exact: true }).fill('121');
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeDisabled();
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await page.getByLabel('계획 시간 하한 (초)', { exact: true }).fill('60');
  await page.getByRole('checkbox', { name: 'intensity 잠금', exact: true }).check();
  await savePreview(page);
  const locked = (await fixture.read()).head;
  assert.ok(locked);
  const invalid = await fixture.save(locked.id, {
    ...locked.draft,
    sessions: locked.draft.sessions.map((session) => ({
      ...session,
      durationRange: { minSeconds: 60, maxSeconds: 180 },
      locks: { ...session.locks, intensity: false },
    })),
  });
  expect(invalid.status()).toBe(409);
  expect(await invalid.json()).toMatchObject({ error: { code: 'PLAN_LOCKED' } });
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(durationMode(page)).toBeDisabled();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('plannedSession'))
    .not.toBe('quantity-session');
  const copyId = new URL(page.url()).searchParams.get('plannedSession');
  assert.ok(copyId);
  await expect(durationMode(page)).toBeEnabled();
  await expect(page.getByLabel('계획 시간 상한 (초)', { exact: true })).toHaveValue('120');
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.getByLabel('계획 거리 상한 (m)', { exact: true })).toHaveValue('1000.25');
  await savePreview(page);
  const saved = (await fixture.read()).head;
  expect(saved?.draft.sessions.find((session) => session.id === 'quantity-session')).toEqual(
    locked.draft.sessions[0],
  );
  expect(saved?.draft.sessions.find((session) => session.id === copyId)).toMatchObject({
    durationRange: { minSeconds: 60, maxSeconds: 120 },
    distanceRange: { minMeters: 0, maxMeters: 1000.25 },
    locks: { intensity: false },
  });
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});
