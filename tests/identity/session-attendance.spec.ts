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
  '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=agenda&plannedSession=attendance-session&view=stack';
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
    title: 'Synthetic attendance lock',
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
        id: 'attendance-session',
        blockId: 'block',
        date: '2026-09-20',
        localStartTime: null,
        title: 'Synthetic attendance session',
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
  expect(saved.draft.sessions[0]?.locks).not.toHaveProperty('attendance');
  await page.goto(plannerUrl);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  return { headers, get, read, save, saved, draft, actuals };
}
async function savePreview(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}
const attendance = (page: Page) =>
  page.getByRole('checkbox', { name: '참석 잠금 (세션 삭제 보호)', exact: true });
const remove = (page: Page) => page.getByRole('button', { name: '세션 삭제', exact: true });

test('attendance protects deletion until a separate unlock commit while schedule and content remain editable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const fixture = await setup(page);
  await expect(attendance(page)).not.toBeChecked();
  await attendance(page).focus();
  await attendance(page).press('Space');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await savePreview(page);
  const locked = (await fixture.read()).head;
  assert.ok(locked);
  expect(locked.draft.sessions[0]?.locks).toMatchObject({
    attendance: true,
    date: false,
    time: false,
    intensity: false,
  });
  const rejected = await fixture.save(locked.id, { ...locked.draft, sessions: [] });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: 'PLAN_LOCKED' } });
  expect((await fixture.read()).head).toEqual(locked);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(remove(page)).toBeDisabled();
  await expect(page.getByLabel('세션 날짜', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('시작 시각 (미정 가능)', { exact: true })).toBeEnabled();
  await page.getByLabel('세션 날짜', { exact: true }).fill('2026-09-21');
  await page.getByLabel('시작 시각 (미정 가능)', { exact: true }).fill('08:30');
  await page
    .getByLabel('세션 메모', { exact: true })
    .fill('Synthetic attendance does not freeze content');
  await savePreview(page);
  const edited = (await fixture.read()).head;
  assert.ok(edited);
  expect(edited.draft.sessions[0]).toMatchObject({
    date: '2026-09-21',
    localStartTime: '08:30',
    notes: 'Synthetic attendance does not freeze content',
    locks: { attendance: true },
  });
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await attendance(page).uncheck();
  await expect(remove(page)).toBeDisabled();
  expect((await fixture.read()).head).toEqual(edited);
  await savePreview(page);
  const unlocked = (await fixture.read()).head;
  assert.ok(unlocked);
  expect(unlocked.draft.sessions[0]?.locks).toMatchObject({ attendance: false });
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(remove(page)).toBeEnabled();
  await remove(page).click();
  expect((await fixture.read()).head).toEqual(unlocked);
  await savePreview(page);
  expect((await fixture.read()).head?.draft.sessions).toEqual([]);
  const original = planSnapshotSchema.parse(
    await fixture.get(`/bff/v1/plans/versions/${fixture.saved.id}`),
  );
  expect(original).toEqual(fixture.saved);
  expect(original.draft.sessions[0]?.locks).not.toHaveProperty('attendance');
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});

test('duplicating an attendance-protected session retains its source and creates an independently deletable copy', async ({
  page,
}) => {
  const fixture = await setup(page);
  await attendance(page).check();
  await savePreview(page);
  const locked = (await fixture.read()).head;
  assert.ok(locked);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('plannedSession'))
    .not.toBe('attendance-session');
  const copyId = new URL(page.url()).searchParams.get('plannedSession');
  assert.ok(copyId);
  await expect(attendance(page)).not.toBeChecked();
  await expect(remove(page)).toBeEnabled();
  expect((await fixture.read()).head).toEqual(locked);
  await savePreview(page);
  const duplicated = (await fixture.read()).head;
  assert.ok(duplicated);
  expect(duplicated.draft.sessions).toHaveLength(2);
  expect(duplicated.draft.sessions.find((session) => session.id === 'attendance-session')).toEqual(
    locked.draft.sessions[0],
  );
  expect(duplicated.draft.sessions.find((session) => session.id === copyId)).toMatchObject({
    locks: { attendance: false, date: false, time: false, intensity: false },
    date: '2026-09-20',
    notes: 'Preserve note',
    targetRpe: 0,
    distanceMeters: 0,
  });
  await page.reload();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(attendance(page)).not.toBeChecked();
  await expect(remove(page)).toBeEnabled();
  expect(activityListSchema.parse(await fixture.get('/bff/v1/activities'))).toEqual(
    fixture.actuals,
  );
});
