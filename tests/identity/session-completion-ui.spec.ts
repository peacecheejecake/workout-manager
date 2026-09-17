import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { activityListSchema } from '../../packages/contracts/src/activity';
import { sessionCompletionReadSchema } from '../../packages/contracts/src/session-completion';

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
  const previousResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(previousResponse.status()).toBe(200);
  const previous = planReadSchema.parse(await previousResponse.json());
  const id = `완료 / ${randomUUID()}`;
  const draft = planDraftSchema.parse({
    title: 'Synthetic completion UI plan',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `completion-ui-${level}`,
      parentId: index === 0 ? null : `completion-ui-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [id, `${id}-other`].map((sessionId, index) => ({
      id: sessionId,
      blockId: 'completion-ui-block',
      date: index === 0 ? '2026-09-20' : '2026-09-21',
      localStartTime: null,
      title: `Synthetic completion session ${index + 1}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const save = async (expectedVersionId: string | null, next = draft) => {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft: next },
      timeout: 5000,
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const saved = await save(previous.head?.id ?? null);
  const path = `/bff/v1/plans/sessions/${encodeURIComponent(id)}/completion`;
  const read = async () => {
    const response = await page.request.get(path, { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return sessionCompletionReadSchema.parse(await response.json());
  };
  const actualCount = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json()).total;
  };
  await page.goto(
    `/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=agenda&view=stack&plannedSession=${encodeURIComponent(id)}`,
  );
  const panel = page.getByRole('region', { name: '세션 완료 확인', exact: true });
  await expect(panel.getByRole('button', { name: '완료 확인하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('Keep this unsaved synthetic note');
  return { headers, saved, draft, path, read, save, actualCount, panel, note };
}

test('explicit completion and reasoned retraction preserve drafts and protect only completed scheduling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const fixture = await setup(page);
  const before = await fixture.actualCount();
  let posts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/bff/v1/plans/session-completion'
    )
      posts += 1;
  });
  const trigger = fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true });
  await trigger.click();
  const confirmation = fixture.panel.getByRole('group', { name: '완료 보고 확인', exact: true });
  const cancel = confirmation.getByRole('button', { name: '취소', exact: true });
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cancel.press('Enter');
  await expect(trigger).toBeFocused();
  expect(posts).toBe(0);
  await trigger.press('Enter');
  await confirmation.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(
    fixture.panel.getByRole('button', { name: '완료 확인 철회', exact: true }),
  ).toBeEnabled();
  expect((await fixture.read()).report).toMatchObject({
    status: 'completed',
    revision: 1,
    source: 'user',
    method: 'self_report',
  });
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await expect(page.getByLabel('세션 날짜', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('시작 시각 (미정 가능)', { exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '소속 Block', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '세션 삭제', exact: true })).toBeDisabled();
  await expect(page.getByLabel('계획 시간대', { exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page
    .getByRole('button', { name: '계획: Synthetic completion session 2', exact: true })
    .click();
  await expect(page.getByLabel('세션 날짜', { exact: true })).toBeEnabled();
  await page
    .getByRole('button', { name: '계획: Synthetic completion session 1', exact: true })
    .click();
  await fixture.panel.getByRole('button', { name: '완료 확인 철회', exact: true }).click();
  await expect(fixture.panel.getByRole('alert')).toContainText('정정 사유가 필요합니다');
  await expect(confirmation).toHaveCount(0);
  expect(posts).toBe(1);
  await fixture.panel
    .getByLabel('완료 보고 정정 사유', { exact: true })
    .fill('Synthetic mistaken confirmation');
  await fixture.panel.getByRole('button', { name: '완료 확인 철회', exact: true }).click();
  await confirmation.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(page.getByLabel('세션 날짜', { exact: true })).toBeEnabled();
  const retracted = await fixture.read();
  expect(retracted.report).toMatchObject({ status: 'retracted', revision: 2 });
  expect(retracted.totalHistory).toBe(2);
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.getByLabel('세션 날짜', { exact: true }).fill('2026-09-22');
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${fixture.saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(await fixture.actualCount()).toBe(before);
});

test('a committed completion with a lost browser response retries the exact command once', async ({
  page,
}) => {
  const fixture = await setup(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const pattern = '**/bff/v1/plans/session-completion?*';
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    if (attempts.length !== 1) return route.continue();
    // The real isolated API commits; only delivery to the browser is lost.
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  await fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }).click();
  await fixture.panel.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(
    fixture.panel.getByRole('button', { name: '같은 완료 요청 다시 확인', exact: true }),
  ).toBeVisible();
  expect((await fixture.read()).totalHistory).toBe(1);
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await fixture.panel
    .getByRole('button', { name: '같은 완료 요청 다시 확인', exact: true })
    .click();
  await expect(
    fixture.panel.getByRole('button', { name: '완료 확인 철회', exact: true }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await fixture.read()).totalHistory).toBe(1);
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.unroute(pattern);
});

test('a stale saved-plan confirmation requires fresh reading and a new explicit confirmation', async ({
  page,
}) => {
  const fixture = await setup(page);
  await fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }).click();
  const newer = await fixture.save(fixture.saved.id, {
    ...fixture.draft,
    title: 'Synthetic competing saved head',
  });
  const conflict = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/bff/v1/plans/session-completion',
  );
  await fixture.panel.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  expect((await fixture.read()).report).toBeNull();
  await expect(
    fixture.panel.getByRole('group', { name: '완료 보고 확인', exact: true }),
  ).toHaveCount(0);
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await fixture.panel.getByRole('button', { name: '완료 기록 다시 확인', exact: true }).click();
  await expect(
    fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }),
  ).toBeEnabled();
  await fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }).click();
  await fixture.panel.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(
    fixture.panel.getByRole('button', { name: '완료 확인 철회', exact: true }),
  ).toBeEnabled();
  expect((await fixture.read()).report).toMatchObject({
    planVersionId: newer.id,
    revision: 1,
    status: 'completed',
  });
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
});
