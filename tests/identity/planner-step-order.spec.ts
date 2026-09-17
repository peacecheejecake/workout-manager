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

async function setupSteps(page: Page, locked: boolean) {
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
  const title = `Synthetic steps ${randomUUID()}`;
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
            id: 'warmup',
            kind: 'warmup',
            durationSeconds: 0,
            distanceMeters: null,
            repetitions: 1,
          },
          { id: 'work', kind: 'work', durationSeconds: null, distanceMeters: 400, repetitions: 3 },
          {
            id: 'recovery',
            kind: 'recovery',
            durationSeconds: 60,
            distanceMeters: 0,
            repetitions: 2,
          },
          {
            id: 'cooldown',
            kind: 'cooldown',
            durationSeconds: null,
            distanceMeters: null,
            repetitions: 1,
          },
        ],
      },
    ],
  });
  const originalSession = draft.sessions[0];
  assert.ok(originalSession);
  draft.sessions.push({
    ...structuredClone(originalSession),
    id: 'other-session',
    title: 'Untouched other session',
    steps: [],
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

const stepRow = (page: Page, id: string) => page.locator(`[data-step-id="${id}"]`);
async function expectOrder(page: Page, ids: string[]) {
  await expect
    .poll(() =>
      page
        .locator('[data-step-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-step-id'))),
    )
    .toEqual(ids);
}
async function savePreview(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}

test('step reorder is a reviewable draft that survives responsive changes and preserves source values', async ({
  page,
}) => {
  const fixture = await setupSteps(page, false);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expectOrder(page, ['warmup', 'work', 'recovery', 'cooldown']);
  await expect(
    stepRow(page, 'warmup').getByRole('button', { name: '단계 위로', exact: true }),
  ).toBeDisabled();
  await expect(
    stepRow(page, 'cooldown').getByRole('button', { name: '단계 아래로', exact: true }),
  ).toBeDisabled();
  const move = stepRow(page, 'work').getByRole('button', { name: '단계 아래로', exact: true });
  await move.click();
  await expectOrder(page, ['warmup', 'recovery', 'work', 'cooldown']);
  await expect(move).toBeFocused();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expectOrder(page, ['warmup', 'recovery', 'work', 'cooldown']);
    await expect(move).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(fixture.writes).toHaveLength(0);
  expect((await fixture.readPlan()).head).toEqual(fixture.saved);
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expectOrder(page, ['warmup', 'work', 'recovery', 'cooldown']);
  await stepRow(page, 'work').getByRole('button', { name: '단계 위로', exact: true }).click();
  await expectOrder(page, ['work', 'warmup', 'recovery', 'cooldown']);
  await expect(
    stepRow(page, 'work').getByRole('combobox', { name: '단계 종류', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  expect(fixture.writes).toHaveLength(0);
  expect((await fixture.readPlan()).head).toEqual(fixture.saved);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  const saved = (await fixture.readPlan()).head;
  assert.ok(saved);
  const source = fixture.saved.draft.sessions[0];
  assert.ok(source);
  const byId = new Map(source.steps.map((step) => [step.id, step]));
  expect(saved.draft).toEqual({
    ...fixture.saved.draft,
    sessions: [
      { ...source, steps: ['work', 'warmup', 'recovery', 'cooldown'].map((id) => byId.get(id)) },
      ...fixture.saved.draft.sessions.slice(1),
    ],
  });
  expect(fixture.writes).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expectOrder(page, ['work', 'warmup', 'recovery', 'cooldown']);
  await fixture.actualsUnchanged();
});

test('saved intensity locks protect order until an independent unlock version is committed', async ({
  page,
}) => {
  const fixture = await setupSteps(page, true);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const move = stepRow(page, 'work').getByRole('button', { name: '단계 위로', exact: true });
  await expect(move).toBeDisabled();
  const forged = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: fixture.saved.id,
      draft: {
        ...fixture.draft,
        sessions: fixture.draft.sessions.map((session) =>
          session.id === 'intensity-session'
            ? {
                ...session,
                steps: [...session.steps].reverse(),
                locks: { ...session.locks, intensity: false },
              }
            : session,
        ),
      },
    },
  });
  expect(forged.status()).toBe(409);
  expect(await forged.json()).toMatchObject({ error: { code: 'PLAN_LOCKED' } });
  expect((await fixture.readPlan()).head).toEqual(fixture.saved);
  await page.getByRole('checkbox', { name: 'intensity 잠금', exact: true }).uncheck();
  await expect(move).toBeDisabled();
  await savePreview(page);
  const unlocked = (await fixture.readPlan()).head;
  assert.ok(unlocked);
  expect(unlocked.draft.sessions[0]?.steps).toEqual(fixture.saved.draft.sessions[0]?.steps);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(move).toBeEnabled();
  await move.click();
  await savePreview(page);
  const changed = (await fixture.readPlan()).head;
  assert.ok(changed);
  const source = unlocked.draft.sessions[0];
  assert.ok(source);
  const byId = new Map(source.steps.map((step) => [step.id, step]));
  expect(changed.draft).toEqual({
    ...unlocked.draft,
    sessions: [
      { ...source, steps: ['work', 'warmup', 'recovery', 'cooldown'].map((id) => byId.get(id)) },
      ...unlocked.draft.sessions.slice(1),
    ],
  });
  expect(fixture.writes).toHaveLength(2);
  await fixture.actualsUnchanged();
});
