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
  '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=agenda&plannedSession=target-session&view=stack';
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
    title: 'Synthetic session targets',
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
        id: 'target-session',
        blockId: 'block',
        date: '2026-09-20',
        localStartTime: null,
        title: 'Synthetic target session',
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
  expect(saved.draft.sessions[0]).not.toHaveProperty('paceTarget');
  expect(saved.draft.sessions[0]).not.toHaveProperty('heartRateTarget');
  await page.goto(plannerUrl);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  return { headers, get, read, save, saved, draft, actuals };
}
async function savePreview(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}
const paceMin = (page: Page) =>
  page.getByRole('spinbutton', { name: '목표 페이스 빠른 경계 (초/km)', exact: true });
const paceMax = (page: Page) =>
  page.getByRole('spinbutton', { name: '목표 페이스 느린 경계 (초/km)', exact: true });
const heartMin = (page: Page) =>
  page.getByRole('spinbutton', { name: '목표 심박 하한 (bpm)', exact: true });
const heartMax = (page: Page) =>
  page.getByRole('spinbutton', { name: '목표 심박 상한 (bpm)', exact: true });
const paceTarget = { minSecondsPerKm: 300, maxSecondsPerKm: 360 };
const heartRateTarget = { minBpm: 120, maxBpm: 150 };
async function fillTargets(page: Page) {
  await paceMin(page).fill('300');
  await paceMax(page).fill('360');
  await heartMin(page).fill('120');
  await heartMax(page).fill('150');
}

test('legacy targets become explicit saved ranges, survive reload and history, and clear to null without rewriting old snapshots', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const fixture = await setup(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes += 1;
  });
  await fillTargets(page);
  await heartMax(page).focus();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(heartMax(page)).toBeFocused();
  await expect(paceMin(page)).toHaveValue('300');
  expect(writes).toBe(0);
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await savePreview(page);
  const withTargets = (await fixture.read()).head;
  assert.ok(withTargets);
  expect(withTargets.draft.sessions[0]).toEqual({
    ...fixture.draft.sessions[0],
    paceTarget,
    heartRateTarget,
  });
  await page.goto(`${plannerUrl}&compareFrom=${fixture.saved.id}&compareTo=${withTargets.id}`);
  const comparison = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  await comparison.getByText(/^세션 Synthetic target session ·/).click();
  await expect(comparison.getByRole('region', { name: '이전 세션', exact: true })).toContainText(
    '미지정 (이전 형식에 값 없음)',
  );
  await expect(comparison.getByRole('region', { name: '이후 세션', exact: true })).toContainText(
    '목표 페이스: 300–360 초/km',
  );
  await expect(comparison.getByRole('region', { name: '이후 세션', exact: true })).toContainText(
    '목표 심박: 120–150 bpm',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(paceMin(page)).toHaveValue('300');
  const clear = page.getByRole('button', { name: '목표 페이스 비우기', exact: true });
  await clear.focus();
  await clear.press('Enter');
  await page.getByRole('button', { name: '목표 심박 비우기', exact: true }).click();
  await savePreview(page);
  const cleared = (await fixture.read()).head;
  assert.ok(cleared);
  expect(cleared.draft.sessions[0]).toEqual({
    ...fixture.draft.sessions[0],
    paceTarget: null,
    heartRateTarget: null,
  });
  const original = planSnapshotSchema.parse(
    await fixture.get(`/bff/v1/plans/versions/${fixture.saved.id}`),
  );
  expect(original).toEqual(fixture.saved);
  await page.goto(`${plannerUrl}&compareFrom=${withTargets.id}&compareTo=${cleared.id}`);
  await comparison.getByText(/^세션 Synthetic target session ·/).click();
  await expect(comparison.getByRole('region', { name: '이후 세션', exact: true })).toContainText(
    '미지정 (명시적으로 비움)',
  );
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});

test('invalid target ranges cannot save and a locked source requires a separately committed unlock while its duplicate is independent', async ({
  page,
}) => {
  const fixture = await setup(page);
  await paceMin(page).fill('400');
  await paceMax(page).fill('300');
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeDisabled();
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await fillTargets(page);
  await page.getByRole('checkbox', { name: 'intensity 잠금', exact: true }).check();
  await savePreview(page);
  const locked = (await fixture.read()).head;
  assert.ok(locked);
  const invalid = await fixture.save(locked.id, {
    ...locked.draft,
    sessions: locked.draft.sessions.map((session) => ({
      ...session,
      paceTarget: { minSecondsPerKm: 310, maxSecondsPerKm: 360 },
      locks: { ...session.locks, intensity: false },
    })),
  });
  expect(invalid.status()).toBe(409);
  expect(await invalid.json()).toMatchObject({ error: { code: 'PLAN_LOCKED' } });
  expect((await fixture.read()).head).toEqual(locked);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(paceMin(page)).toBeDisabled();
  await expect(heartMin(page)).toBeDisabled();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('plannedSession'))
    .not.toBe('target-session');
  const copyId = new URL(page.url()).searchParams.get('plannedSession');
  assert.ok(copyId);
  await expect(paceMin(page)).toBeEnabled();
  await expect(paceMin(page)).toHaveValue('300');
  await expect(heartMax(page)).toHaveValue('150');
  await expect(
    page.getByRole('checkbox', { name: 'intensity 잠금', exact: true }),
  ).not.toBeChecked();
  await savePreview(page);
  const final = (await fixture.read()).head;
  expect(final?.draft.sessions.find((session) => session.id === 'target-session')).toEqual(
    locked.draft.sessions[0],
  );
  expect(final?.draft.sessions.find((session) => session.id === copyId)).toMatchObject({
    paceTarget,
    heartRateTarget,
    locks: { date: false, time: false, intensity: false },
  });
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});
