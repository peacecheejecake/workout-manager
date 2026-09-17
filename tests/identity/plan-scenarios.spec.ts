import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

import {
  planScenarioSchema,
  planScenarioListSchema,
  planScenarioApplyResultSchema,
} from '../../packages/contracts/src/plan-scenarios';
import { sessionCompletionListSchema } from '../../packages/contracts/src/session-completion';
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
    title: 'Synthetic scenario base',
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
  return { headers, get, read, save, saved, draft, actuals };
}
const scenarioRoot = '/bff/v1/plan-scenarios';
const scenarioPanel = (page: Page) =>
  page.getByRole('region', { name: '계획 시나리오', exact: true });
async function currentCompletions(page: Page, headers: Awaited<ReturnType<typeof login>>) {
  const response = await page.request.get('/bff/v1/plans/current/session-completions', { headers });
  expect(response.status()).toBe(200);
  return sessionCompletionListSchema.parse(await response.json());
}

test('a separately saved scenario leaves current scheduling untouched until an explicit UI apply and lost-response replay', async ({
  page,
}) => {
  const f = await setup(page);
  const panel = scenarioPanel(page);
  await panel
    .getByRole('combobox', { name: '시나리오 기준 계획 버전', exact: true })
    .selectOption(f.saved.id);
  await panel.getByRole('button', { name: '시나리오 A 만들기', exact: true }).click();
  await panel.getByRole('button', { name: '시나리오 검토 취소', exact: true }).click();
  const empty = await page.request.get(`${scenarioRoot}?basePlanVersionId=${f.saved.id}`, {
    headers: f.headers,
  });
  expect(planScenarioListSchema.parse(await empty.json()).total).toBe(0);
  await panel.getByRole('button', { name: '시나리오 A 만들기', exact: true }).click();
  await panel.getByRole('button', { name: '확인하고 시나리오 만들기', exact: true }).click();
  await panel.getByRole('button', { name: '시나리오 A 선택', exact: true }).click();
  await panel.getByRole('button', { name: '시나리오 초안 편집', exact: true }).click();
  const editor = panel.getByRole('region', { name: '시나리오 초안 편집', exact: true });
  await editor.getByLabel('시나리오 계획 제목', { exact: true }).fill('Synthetic alternate A');
  await editor.getByLabel('세션 날짜', { exact: true }).fill('2026-09-21');
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(editor.getByLabel('시나리오 계획 제목', { exact: true })).toHaveValue(
    'Synthetic alternate A',
  );
  await editor.getByRole('button', { name: '시나리오 저장 미리보기', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await f.read()).head).toEqual(f.saved);
  await panel.getByRole('button', { name: '확인하고 시나리오 저장', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '현재 계획 적용 미리보기', exact: true }),
  ).toBeEnabled();
  const list = planScenarioListSchema.parse(
    await f.get(`${scenarioRoot}?basePlanVersionId=${f.saved.id}`),
  );
  const entry = list.items[0];
  assert.ok(entry);
  const alternative = planScenarioSchema.parse(await f.get(`${scenarioRoot}/${entry.id}`));
  expect(alternative).toMatchObject({ revision: 2, draft: { title: 'Synthetic alternate A' } });
  expect((await f.read()).head).toEqual(f.saved);
  const revisionOne = planScenarioSchema.parse(
    await f.get(`${scenarioRoot}/${entry.id}/revisions/1`),
  );
  expect(revisionOne.draft).toEqual(f.saved.draft);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const pattern = `**/bff/v1/plan-scenarios/${entry.id}/apply`;
  await page.route(pattern, async (route) => {
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    if (attempts.length !== 1) return route.continue();
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: '현재 계획 적용 미리보기', exact: true }).click();
  await panel.getByRole('button', { name: '확인하고 현재 계획에 적용', exact: true }).click();
  const retry = panel.getByRole('button', { name: '같은 시나리오 요청 다시 확인', exact: true });
  await expect(retry).toBeVisible();
  const applied = (await f.read()).head;
  assert.ok(applied);
  expect(applied.version).toBe(f.saved.version + 1);
  expect(applied.draft).toEqual(alternative.draft);
  await retry.click();
  await expect(retry).toBeHidden();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await f.read()).head).toEqual(applied);
  expect(activityListSchema.parse(await f.get('/bff/v1/activities'))).toEqual(f.actuals);
  await page.unroute(pattern);
});

test('scenario API rejects stale dependencies and foreign access while preserving immutable revisions and same-label slots', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, {
      headers: { ...f.headers, 'idempotency-key': key },
      data,
      timeout: 5000,
    });
  const createBody = { confirmed: true, basePlanVersionId: f.saved.id, label: 'B' };
  const created = await post(scenarioRoot, createBody);
  expect(created.status()).toBe(200);
  const original = planScenarioSchema.parse(await created.json());
  expect((await post(scenarioRoot, createBody)).status()).toBe(409);
  const editedDraft = { ...original.draft, title: 'Synthetic changed alternative' };
  const changed = await page.request.put(`${scenarioRoot}/${original.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { confirmed: true, expectedRevision: 1, draft: editedDraft },
  });
  expect(changed.status()).toBe(200);
  const latest = planScenarioSchema.parse(await changed.json());
  const command = {
    confirmed: true,
    expectedScenarioRevision: latest.revision,
    expectedPlanVersionId: f.saved.id,
    expectedCompletionRevision: (await currentCompletions(page, f.headers)).collectionRevision,
  };
  const stale = await post(`${scenarioRoot}/${original.id}/apply`, {
    ...command,
    expectedScenarioRevision: 1,
  });
  expect(stale.status()).toBe(409);
  expect((await f.read()).head).toEqual(f.saved);
  const completionChanged = await post(`${scenarioRoot}/${original.id}/apply`, {
    ...command,
    expectedCompletionRevision: command.expectedCompletionRevision + 1,
  });
  expect(completionChanged.status()).toBe(409);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    for (const path of [
      `${scenarioRoot}/${original.id}`,
      `${scenarioRoot}/${original.id}/revisions/1`,
    ])
      expect((await other.request.get(path, { headers: otherHeaders })).status()).toBe(404);
    expect(
      (
        await other.request.post(`${scenarioRoot}/${original.id}/apply`, {
          headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
          data: command,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const competing = await f.save(f.saved.id, { ...f.draft, title: 'Synthetic new current head' });
  expect(competing.status()).toBe(200);
  const head = planSnapshotSchema.parse(await competing.json());
  expect((await post(`${scenarioRoot}/${original.id}/apply`, command)).status()).toBe(409);
  const success = await post(`${scenarioRoot}/${original.id}/apply`, {
    ...command,
    expectedPlanVersionId: head.id,
  });
  expect(success.status()).toBe(200);
  const applied = planScenarioApplyResultSchema.parse(await success.json());
  expect(applied.plan.draft).toEqual(latest.draft);
  expect(
    planScenarioSchema.parse(await f.get(`${scenarioRoot}/${original.id}/revisions/1`)),
  ).toEqual(original);
  expect(activityListSchema.parse(await f.get('/bff/v1/activities'))).toEqual(f.actuals);
});

test('cross-branch comparison keeps A and B immutable revisions distinct without applying either plan', async ({
  page,
}) => {
  const f = await setup(page);
  const alternatives = [];
  for (const [label, date] of [
    ['A', '2026-09-21'],
    ['B', '2026-09-22'],
  ] as const) {
    const created = await page.request.post(scenarioRoot, {
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      data: { confirmed: true, basePlanVersionId: f.saved.id, label },
    });
    expect(created.status()).toBe(200);
    const initial = planScenarioSchema.parse(await created.json());
    const changed = await page.request.put(`${scenarioRoot}/${initial.id}`, {
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      data: {
        confirmed: true,
        expectedRevision: initial.revision,
        draft: {
          ...initial.draft,
          title: `Synthetic branch ${label}`,
          sessions: initial.draft.sessions.map((session) => ({
            ...session,
            title: `Synthetic ${label} session`,
            date,
          })),
        },
      },
    });
    expect(changed.status()).toBe(200);
    alternatives.push(planScenarioSchema.parse(await changed.json()));
  }
  const [left, right] = alternatives;
  assert.ok(left && right);
  expect((await f.read()).head).toEqual(f.saved);
  // Fixed revision references deliberately survive a later edit to either branch head.
  await page.goto(`${plannerUrl}&scenarioBase=${f.saved.id}&scenario=${left.id}`);
  const comparison = page.getByRole('region', { name: '시나리오 수정 비교', exact: true });
  await comparison
    .getByRole('combobox', { name: '이전 비교 시나리오', exact: true })
    .selectOption(left.id);
  await comparison
    .getByRole('combobox', { name: '이후 비교 시나리오', exact: true })
    .selectOption(right.id);
  await comparison.getByLabel('이전 시나리오 수정 번호', { exact: true }).fill('2');
  await comparison.getByLabel('이후 시나리오 수정 번호', { exact: true }).fill('2');
  await comparison.getByRole('button', { name: '시나리오 수정 비교하기', exact: true }).click();
  await expect(comparison).toContainText('시나리오 A 수정 2 → 시나리오 B 수정 2');
  await expect(comparison).toContainText('계획 제목·시간대 변경');
  const before = comparison
    .locator('details')
    .filter({ has: page.getByText('이전 시나리오 범위 본문', { exact: true }) });
  const after = comparison
    .locator('details')
    .filter({ has: page.getByText('이후 시나리오 범위 본문', { exact: true }) });
  await before.getByText('이전 시나리오 범위 본문', { exact: true }).click();
  await after.getByText('이후 시나리오 범위 본문', { exact: true }).click();
  await expect(before).toContainText('Synthetic branch A');
  await expect(before).toContainText('Synthetic A session');
  await expect(before).toContainText('2026-09-21');
  await expect(after).toContainText('Synthetic branch B');
  await expect(after).toContainText('Synthetic B session');
  await expect(after).toContainText('2026-09-22');
  const newest = await page.request.put(`${scenarioRoot}/${right.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      expectedRevision: 2,
      draft: { ...right.draft, title: 'Synthetic later B revision' },
    },
  });
  expect(newest.status()).toBe(200);
  await page.reload();
  await expect(comparison).toContainText('시나리오 A 수정 2 → 시나리오 B 수정 2');
  await after.getByText('이후 시나리오 범위 본문', { exact: true }).click();
  await expect(after).toContainText('Synthetic branch B');
  await expect(after).not.toContainText('Synthetic later B revision');
  expect((await f.read()).head).toEqual(f.saved);
  expect(activityListSchema.parse(await f.get('/bff/v1/activities'))).toEqual(f.actuals);
});
