import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityListSchema } from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
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
  // Only the synthetic account in the private OIDC/PostgreSQL harness is erased.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

async function setupIntensity(page: Page, locked: boolean) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const readActuals = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const current = await readPlan();
  const actuals = await readActuals();
  const title = `Synthetic intensity ${randomUUID()}`;
  const sessionTitle = `${title} session`;
  const draft = planDraftSchema.parse({
    title,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `intensity-${level}`,
      parentId: index === 0 ? null : `intensity-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-01-08',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'intensity-session',
        blockId: 'intensity-block',
        date: '2080-01-03',
        localStartTime: null,
        title: sessionTitle,
        sport: 'running',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: 0,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: locked, time: locked, intensity: locked },
        ...(locked ? { intensityLabel: 'A' } : {}),
        steps: [
          {
            id: 'intensity-step',
            kind: 'work',
            durationSeconds: null,
            distanceMeters: 0,
            repetitions: 1,
          },
        ],
      },
    ],
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  const writes: { key: string | undefined; body: unknown }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    '/planner?lens=calendar&from=2080-01-01&to=2080-01-08&plannedView=table&plannedSession=intensity-session',
  );
  return {
    headers,
    draft,
    saved,
    writes,
    sessionTitle,
    readPlan,
    async actualsUnchanged() {
      expect(await readActuals()).toEqual(actuals);
    },
  };
}

const intensity = (page: Page) => page.getByRole('combobox', { name: '강도 라벨', exact: true });
const detail = (page: Page) => page.getByRole('region', { name: '선택한 계획 세션', exact: true });
async function savePreview(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}

test('a legacy session adds a reviewed intensity label without changing RPE or missing metrics and copies it independently', async ({
  page,
}) => {
  const fixture = await setupIntensity(page, false);
  expect(fixture.saved.draft.sessions[0]).not.toHaveProperty('intensityLabel');
  await expect(detail(page)).toContainText('강도 라벨: 미지정');
  await expect(detail(page)).toContainText('목표 RPE: 0');
  const table = page.getByRole('table', { name: '계획 세션 표', exact: true });
  await expect(table.getByRole('columnheader', { name: '강도 라벨', exact: true })).toBeVisible();
  const sourceRow = table.getByRole('row').filter({
    has: page.getByRole('button', { name: `계획: ${fixture.sessionTitle}`, exact: true }),
  });
  await expect(sourceRow.getByRole('cell', { name: '미지정', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const label = intensity(page);
  await expect(label).toHaveValue('');
  await label.selectOption('B');
  await label.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(label).toHaveValue('B');
    await expect(label).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  for (const lock of ['date', 'time', 'intensity'])
    await page.getByRole('checkbox', { name: `${lock} 잠금`, exact: true }).check();
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  const preview = page.getByRole('region', { name: '변경 미리보기', exact: true });
  await preview.getByText('변경 전후 전체 내용 비교', { exact: true }).click();
  await expect(preview.getByRole('heading', { name: '변경 전', exact: true })).toBeVisible();
  await expect(preview.getByRole('heading', { name: '변경 후', exact: true })).toBeVisible();
  const summaries = preview
    .getByRole('listitem')
    .filter({ has: page.getByText(fixture.sessionTitle, { exact: true }) });
  await expect(summaries).toHaveCount(2);
  await expect(summaries.nth(0)).toContainText('강도 라벨: 미지정');
  await expect(summaries.nth(1)).toContainText('강도 라벨: B');
  for (const summary of [summaries.nth(0), summaries.nth(1)]) {
    await expect(summary).toContainText('시간: 미정 · 거리: 미정 · RPE: 0');
  }
  expect(fixture.writes).toHaveLength(0);
  expect((await fixture.readPlan()).head).toEqual(fixture.saved);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  const withLabel = (await fixture.readPlan()).head;
  assert.ok(withLabel);
  expect(withLabel.draft.sessions[0]).toEqual({
    ...fixture.saved.draft.sessions[0],
    intensityLabel: 'B',
    locks: { date: true, time: true, intensity: true },
  });
  await page.reload();
  await expect(detail(page)).toContainText('강도 라벨: B');
  await expect(sourceRow.getByRole('cell', { name: 'B', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(label).toBeDisabled();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect(label).toBeEnabled();
  await expect(label).toHaveValue('B');
  for (const lock of ['date', 'time', 'intensity'])
    await expect(
      page.getByRole('checkbox', { name: `${lock} 잠금`, exact: true }),
    ).not.toBeChecked();
  await label.selectOption('C');
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  expect(fixture.writes).toHaveLength(1);
  expect((await fixture.readPlan()).head).toEqual(withLabel);
  await page.getByRole('button', { name: `계획: ${fixture.sessionTitle}`, exact: true }).click();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  await expect(page).not.toHaveURL(/plannedSession=intensity-session(?:&|$)/);
  const copyId = new URL(page.url()).searchParams.get('plannedSession');
  assert.ok(copyId && copyId !== 'intensity-session');
  await expect(label).toHaveValue('B');
  await savePreview(page);
  expect(fixture.writes).toHaveLength(2);
  const copied = (await fixture.readPlan()).head;
  expect(copied?.draft.sessions).toHaveLength(2);
  expect(copied?.draft.sessions.find((session) => session.id === 'intensity-session')).toEqual(
    withLabel.draft.sessions[0],
  );
  const copy = copied?.draft.sessions.find((session) => session.id === copyId);
  expect(copy).toMatchObject({
    intensityLabel: 'B',
    targetRpe: 0,
    durationSeconds: null,
    distanceMeters: null,
    locks: { date: false, time: false, intensity: false },
  });
  expect(copy?.steps[0]?.id).not.toBe('intensity-step');
  expect(copy?.steps[0]).toMatchObject({
    durationSeconds: null,
    distanceMeters: 0,
    repetitions: 1,
  });
  await fixture.actualsUnchanged();
});

test('a saved intensity lock requires its own committed unlock and old receipts cannot change newer history', async ({
  page,
}) => {
  const fixture = await setupIntensity(page, true);
  const original = await fixture.readPlan();
  const badLabel = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: fixture.saved.id,
      draft: {
        ...fixture.draft,
        sessions: fixture.draft.sessions.map((session) => ({ ...session, intensityLabel: 'D' })),
      },
    },
  });
  expect(badLabel.status()).toBe(400);
  const forgedUnlock = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: fixture.saved.id,
      draft: {
        ...fixture.draft,
        sessions: fixture.draft.sessions.map((session) => ({
          ...session,
          intensityLabel: 'B',
          locks: { ...session.locks, intensity: false },
        })),
      },
    },
  });
  expect(forgedUnlock.status()).toBe(409);
  expect(await forgedUnlock.json()).toMatchObject({ error: { code: 'PLAN_LOCKED' } });
  expect(await fixture.readPlan()).toEqual(original);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const label = intensity(page);
  await expect(label).toHaveValue('A');
  await expect(label).toBeDisabled();
  await page.getByRole('checkbox', { name: 'intensity 잠금', exact: true }).uncheck();
  await expect(label).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
  await savePreview(page);
  const unlocked = (await fixture.readPlan()).head;
  assert.ok(unlocked);
  expect(unlocked.draft.sessions[0]).toEqual({
    ...fixture.saved.draft.sessions[0],
    locks: { date: true, time: true, intensity: false },
  });
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(label).toBeEnabled();
  await label.selectOption('B');
  await savePreview(page);
  const current = await fixture.readPlan();
  expect(current.head?.draft.sessions[0]).toEqual({
    ...unlocked.draft.sessions[0],
    intensityLabel: 'B',
  });
  expect(current.history).toHaveLength(original.history.length + 2);
  expect(current.history).toEqual(expect.arrayContaining(original.history));
  expect(fixture.writes).toHaveLength(2);
  const unlockCommand = fixture.writes[0];
  assert.ok(unlockCommand?.key);
  const replay = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': unlockCommand.key },
    data: unlockCommand.body,
  });
  expect(replay.status()).toBe(200);
  expect(planSnapshotSchema.parse(await replay.json())).toEqual(unlocked);
  expect(await fixture.readPlan()).toEqual(current);
  await page.reload();
  await expect(detail(page)).toContainText('강도 라벨: B');
  await expect(detail(page)).toContainText('목표 RPE: 0');
  await fixture.actualsUnchanged();
});
