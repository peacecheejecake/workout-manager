import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityListSchema } from '../../packages/contracts/src/activity';
import {
  coachingMessageResultSchema,
  coachingMessagesSchema,
} from '../../packages/contracts/src/coaching-threads';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
  type PlanDraft,
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
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
});

const base = '/bff/v1/coaching-threads';
const selected = (page: Page) =>
  page.getByRole('region', { name: '선택한 상담 기록', exact: true });
const messageInput = (page: Page) =>
  selected(page).getByRole('textbox', { name: '사용자 메시지', exact: true });

async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const readActuals = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const savePlan = async (draft: PlanDraft, expectedVersionId: string | null) => {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft },
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const post = (path: string, data: unknown) =>
    page.request.post(path, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data,
    });
  const readMessages = async (id: string) => {
    const response = await page.request.get(`${base}/${id}/messages?limit=100`, { headers });
    expect(response.status()).toBe(200);
    return coachingMessagesSchema.parse(await response.json());
  };
  const current = await readPlan();
  const actuals = await readActuals();
  const draft = planDraftSchema.parse({
    title: '상담에 고정할 합성 계획',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `coach-${level}`,
      parentId: index === 0 ? null : `coach-${levels[index - 1]}`,
      level,
      title: `상담 ${level}`,
      startDate: '2080-01-01',
      endDateExclusive: '2080-01-08',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
      ...(level === 'season'
        ? {
            constraints: {
              unavailableDates: ['2080-01-04'],
              dailyTimeLimits: [{ date: '2080-01-03', availableSeconds: 300 }],
            },
          }
        : {}),
    })),
    sessions: [
      {
        id: 'coach-session',
        blockId: 'coach-block',
        title: '잠금이 있는 상담 세션',
        date: '2080-01-03',
        localStartTime: null,
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: 0,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: true, time: false, intensity: true },
        steps: [],
      },
    ],
  });
  const saved = await savePlan(draft, current.head?.id ?? null);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/bff/v1/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${path}`);
  });
  return { headers, saved, actuals, readActuals, readPlan, savePlan, post, readMessages, writes };
}

// Real OIDC/BFF/private PostgreSQL: only synthetic user text is entered, no AI reply is mocked.
test('creates a scoped conversation pinned to its saved plan and preserves its draft across responsive layouts', async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto('/coach');
  const form = page.getByRole('region', { name: '새 상담 기록', exact: true });
  await form
    .getByRole('combobox', { name: '상담 계획 버전', exact: true })
    .selectOption(f.saved.id);
  const kind = form.getByRole('combobox', { name: '상담 범위 종류', exact: true });
  const target = form.getByRole('combobox', { name: '상담 대상', exact: true });
  for (const scope of ['phase', 'block', 'session']) {
    await kind.selectOption(scope);
    await target.selectOption(`coach-${scope}`);
    await expect(target).toHaveValue(`coach-${scope}`);
  }
  await form.getByRole('textbox', { name: '상담 제목', exact: true }).fill('기간 조정 상담');
  const first = '잠긴 날짜를 유지하며 조상 기간의 가용 시간을 검토하고 싶습니다.';
  await form.getByRole('textbox', { name: '첫 사용자 메시지', exact: true }).fill(first);
  expect(f.writes).toEqual([]);
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === base && response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: '상담 기록 만들기', exact: true }).click();
  const created = coachingMessageResultSchema.parse(await (await createdResponse).json());
  expect(created.thread.scope).toEqual({ kind: 'session', targetId: 'coach-session' });
  await expect(page).toHaveURL(new RegExp(`thread=${created.thread.id}`));
  await expect(selected(page)).toContainText(first);
  await expect(selected(page)).toContainText('잠금이 있는 상담 세션');
  const context = selected(page).getByRole('region', { name: '저장된 상담 맥락', exact: true });
  await expect(context).toHaveAttribute('data-plan-version-id', f.saved.id);
  await expect(context).toContainText('운동 불가 날짜: 2080-01-04');
  await expect(context).toContainText('2080-01-03: 300초');
  await expect(context).toContainText('계획 거리: 0m · 계획 시간: 미정');
  await expect(context).toContainText('계획 잠금: 날짜 켜짐 · 시각 꺼짐 · 강도 켜짐');
  await page.reload();
  await expect(selected(page)).toContainText(first);
  const draftText = '미저장 합성 초안: 좁은 화면에서도 내용을 보존합니다.';
  const input = messageInput(page);
  await input.fill(draftText);
  await input.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draftText);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(f.writes).toEqual([`POST ${base}`]);
  expect((await f.readMessages(created.thread.id)).messages).toHaveLength(1);
  expect(
    await page.evaluate(
      (text) =>
        [localStorage, sessionStorage].some((storage) =>
          Object.values(storage).join('').includes(text),
        ),
      draftText,
    ),
  ).toBe(false);
  const newer = await f.savePlan(
    {
      ...f.saved.draft,
      title: '상담 생성 이후의 새 계획',
      periods: f.saved.draft.periods.map((period) =>
        period.level === 'season'
          ? {
              ...period,
              constraints: {
                unavailableDates: [],
                dailyTimeLimits: [{ date: '2080-01-03', availableSeconds: 600 }],
              },
            }
          : period,
      ),
    },
    f.saved.id,
  );
  await expect(input).toHaveValue(draftText);
  await selected(page).getByRole('button', { name: '사용자 메시지 저장', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(selected(page)).toContainText(draftText);
  await page.reload();
  await expect(selected(page)).toContainText(draftText);
  await expect(context).toContainText(f.saved.draft.title);
  await expect(context).toHaveAttribute('data-plan-version-id', f.saved.id);
  await expect(context).toContainText('운동 불가 날짜: 2080-01-04');
  await expect(context).toContainText('2080-01-03: 300초');
  await expect(context).not.toContainText(newer.draft.title);
  await expect(context).not.toContainText('2080-01-03: 600초');
  await expect(
    selected(page)
      .getByRole('region', { name: '사용자 메시지 기록', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(2);
  const stored = await f.readMessages(created.thread.id);
  expect(stored.thread.planVersionId).toBe(f.saved.id);
  expect(
    stored.messages.map((message) => ({ role: message.role, content: message.content })),
  ).toEqual([
    { role: 'user', content: first },
    { role: 'user', content: draftText },
  ]);
  expect(stored.hasMore).toBe(false);
  expect((await f.readPlan()).head).toEqual(newer);
  expect(await f.readActuals()).toEqual(f.actuals);
  expect(f.writes).toEqual([`POST ${base}`, `POST ${base}/${created.thread.id}/messages`]);
});

test('keeps a conflicted draft locked until messages beyond the first page are displayed and reviewed', async ({
  page,
}) => {
  const f = await setup(page);
  const response = await f.post(base, {
    planVersionId: f.saved.id,
    scope: { kind: 'block', targetId: 'coach-block' },
    title: '페이지 경계의 합성 상담',
    message: '합성 기록 1',
  });
  expect(response.status()).toBe(200);
  const created = coachingMessageResultSchema.parse(await response.json());
  const path = `${base}/${created.thread.id}/messages`;
  for (let revision = 1; revision < 50; revision++) {
    const appended = await f.post(path, {
      expectedRevision: revision,
      message: `합성 기록 ${revision + 1}`,
    });
    expect(appended.status()).toBe(200);
  }
  await page.goto(`/coach?thread=${created.thread.id}`);
  const input = messageInput(page);
  const save = selected(page).getByRole('button', { name: '사용자 메시지 저장', exact: true });
  await expect(selected(page).getByText('합성 기록 50', { exact: true })).toBeVisible();
  await input.fill('페이지를 모두 확인한 뒤 저장할 합성 초안');
  const concurrent = await f.post(path, {
    expectedRevision: 50,
    message: '새 페이지에 추가된 51번째 합성 기록',
  });
  expect(concurrent.status()).toBe(200);
  const conflict = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === path && reply.request().method() === 'POST',
  );
  await save.click();
  expect((await conflict).status()).toBe(409);
  const review = page.getByRole('button', { name: '최신 기록 확인 후 다시 검토', exact: true });
  await review.click();
  await expect(save).toBeDisabled();
  await expect(selected(page)).not.toContainText('새 페이지에 추가된 51번째 합성 기록');
  await selected(page).getByRole('button', { name: '메시지 더 보기', exact: true }).click();
  await expect(selected(page)).toContainText('새 페이지에 추가된 51번째 합성 기록');
  await expect(save).toBeDisabled();
  await review.click();
  await expect(save).toBeEnabled();
  await expect(input).toHaveValue('페이지를 모두 확인한 뒤 저장할 합성 초안');
  await save.click();
  await expect(input).toHaveValue('');
  const stored = await f.readMessages(created.thread.id);
  expect(stored.thread.revision).toBe(52);
  expect(stored.messages).toHaveLength(52);
  expect(stored.messages.at(-1)?.content).toBe('페이지를 모두 확인한 뒤 저장할 합성 초안');
  expect((await f.readPlan()).head).toEqual(f.saved);
  expect(await f.readActuals()).toEqual(f.actuals);
});

test('preserves a conflicted message for explicit review and retries a committed lost response without duplication', async ({
  page,
}) => {
  const f = await setup(page);
  const response = await f.post(base, {
    planVersionId: f.saved.id,
    scope: { kind: 'block', targetId: 'coach-block' },
    title: '동시 작성과 재확인 상담',
    message: '합성 첫 메시지',
  });
  expect(response.status()).toBe(200);
  const created = coachingMessageResultSchema.parse(await response.json());
  const path = `${base}/${created.thread.id}/messages`;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/coach?thread=${created.thread.id}`);
  const input = messageInput(page);
  const local = '다른 탭의 변경을 확인한 뒤에도 남아야 하는 합성 초안';
  await input.fill(local);
  const concurrent = await f.post(path, { expectedRevision: 1, message: '다른 탭의 합성 메시지' });
  expect(concurrent.status()).toBe(200);
  const conflictResponse = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === path && reply.request().method() === 'POST',
  );
  await selected(page).getByRole('button', { name: '사용자 메시지 저장', exact: true }).click();
  expect((await conflictResponse).status()).toBe(409);
  await expect(input).toHaveValue(local);
  await page.getByRole('button', { name: '최신 기록 확인 후 다시 검토', exact: true }).click();
  await expect(selected(page)).toContainText('다른 탭의 합성 메시지');
  await expect(input).toHaveValue(local);
  expect((await f.readMessages(created.thread.id)).messages).toHaveLength(2);
  await selected(page).getByRole('button', { name: '사용자 메시지 저장', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(selected(page)).toContainText(local);

  const attempts: { key: string | null; body: string | null }[] = [];
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      key: route.request().headers()['idempotency-key'] ?? null,
      body: route.request().postData(),
    });
    // Commit against the real server and lose only its first reply; no successful response is fabricated.
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  const lostText = '응답만 유실된 합성 메시지';
  await input.fill(lostText);
  await selected(page).getByRole('button', { name: '사용자 메시지 저장', exact: true }).click();
  const retry = page.getByRole('button', { name: '같은 요청 재확인', exact: true });
  await expect(retry).toBeVisible();
  await expect(input).toHaveValue(lostText);
  await expect(input).toBeDisabled();
  const beforeRetry = await f.readMessages(created.thread.id);
  expect(beforeRetry.thread.revision).toBe(4);
  expect(beforeRetry.messages.map((message) => message.content)).toEqual([
    '합성 첫 메시지',
    '다른 탭의 합성 메시지',
    local,
    lostText,
  ]);
  await retry.click();
  await expect(input).toHaveValue('');
  await expect(selected(page)).toContainText(lostText);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await f.readMessages(created.thread.id)).toEqual(beforeRetry);
  await page.reload();
  await expect(selected(page)).toContainText(local);
  await expect(selected(page)).toContainText(lostText);
  expect(await f.readMessages(created.thread.id)).toEqual(beforeRetry);
  expect((await f.readPlan()).head).toEqual(f.saved);
  expect(await f.readActuals()).toEqual(f.actuals);
  expect(f.writes).toEqual(Array.from({ length: 4 }, () => `POST ${path}`));
});
