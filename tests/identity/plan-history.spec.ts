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

async function setupHistory(page: Page) {
  page.setDefaultTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const read = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const save = async (draft: unknown) => {
    const current = await read();
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft,
      },
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const session = {
    blockId: 'block-one',
    date: '2080-01-02',
    localStartTime: null,
    sport: 'running',
    durationSeconds: null,
    distanceMeters: 0,
    targetRpe: null,
    purpose: '',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [
      { id: 'warmup', kind: 'warmup', durationSeconds: 0, distanceMeters: null, repetitions: 1 },
      { id: 'work', kind: 'work', durationSeconds: null, distanceMeters: 400, repetitions: 3 },
    ],
  };
  const draft = planDraftSchema.parse({
    title: `Synthetic history ${randomUUID()}`,
    timezone: 'UTC',
    periods: [
      ...(['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2080-01-01',
        endDateExclusive: '2080-01-08',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      ...[
        ['block-one', '첫 Block', '2080-01-01', '2080-01-03'],
        ['block-two', '둘째 Block', '2080-01-03', '2080-01-05'],
        ['block-old', '과거 Block', '2080-01-05', '2080-01-08'],
      ].map(([id, title, startDate, endDateExclusive]) => ({
        id,
        title,
        startDate,
        endDateExclusive,
        parentId: 'phase',
        level: 'block',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
    ],
    sessions: [
      { ...session, id: 'moved', title: '이동한 세션' },
      { ...session, id: 'changed', title: '단계가 바뀐 세션' },
      { ...session, id: 'removed', title: '제거한 세션', blockId: 'block-old', date: '2080-01-06' },
    ],
  });
  const before = await save(draft);
  const afterDraft = planDraftSchema.parse({
    ...draft,
    periods: draft.periods.filter((period) => period.id !== 'block-old'),
    sessions: [
      ...draft.sessions
        .filter((item) => item.id !== 'removed')
        .map((item) =>
          item.id === 'moved'
            ? { ...item, blockId: 'block-two', date: '2080-01-04' }
            : { ...item, distanceMeters: null, steps: [...item.steps].reverse() },
        ),
      { ...session, id: 'added', title: '추가한 세션' },
    ],
  });
  const after = await save(afterDraft);
  const actualResponse = await page.request.get('/bff/v1/activities', { headers });
  expect(actualResponse.status()).toBe(200);
  const actuals = activityListSchema.parse(await actualResponse.json());
  const browserWrites: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/bff/v1/') &&
      !['GET', 'HEAD'].includes(request.method())
    )
      browserWrites.push(request.method());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/planner?lens=calendar&from=2080-01-01&to=2080-01-08&plannedSession=changed');
  return { headers, before, after, read, save, browserWrites, actuals };
}

test('fixed history pairs compare moved and removed periods without changing the current plan or draft', async ({
  page,
}) => {
  const f = await setupHistory(page);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const notes = page.getByRole('textbox', { name: '세션 메모', exact: true });
  await notes.fill('저장하지 않은 메모');
  await page.getByRole('button', { name: `버전 ${f.before.version}과 비교`, exact: true }).click();
  const panel = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  const period = panel.getByRole('combobox', { name: '비교할 기간', exact: true });
  await expect(period).toBeVisible();
  expect(new URL(page.url()).searchParams.get('compareFrom')).toBe(f.before.id);
  expect(new URL(page.url()).searchParams.get('compareTo')).toBe(f.after.id);
  await period.selectOption('block-one');
  await expect(panel.locator('summary').filter({ hasText: '세션 이동한 세션' })).toContainText(
    '선택 기간 밖으로 이동',
  );
  await expect(panel).toContainText('단계가 바뀐 세션');
  await expect(panel).toContainText('추가한 세션');
  const changed = panel.locator('details').filter({
    has: page.locator('summary').filter({ hasText: '단계가 바뀐 세션' }),
  });
  await changed.locator('summary').click();
  const previousSession = changed.getByRole('region', { name: '이전 세션', exact: true });
  const laterSession = changed.getByRole('region', { name: '이후 세션', exact: true });
  await expect(previousSession).toContainText('거리 0m');
  await expect(laterSession).toContainText('거리 미정');
  await expect(previousSession.getByRole('listitem').nth(0)).toContainText('warmup');
  await expect(laterSession.getByRole('listitem').nth(0)).toContainText('work');
  await expect(laterSession.getByRole('listitem').nth(1)).toContainText('0초');
  await period.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(period).toHaveValue('block-one');
    await expect(period).toBeFocused();
    await expect(notes).toHaveValue('저장하지 않은 메모');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await period.selectOption('block-old');
  await expect(panel).toContainText('제거한 세션');
  await expect(panel).toContainText('삭제');
  await expect(panel.locator('summary').filter({ hasText: '세션 이동한 세션' })).toHaveCount(0);
  const frozenUrl = page.url();
  const newer = await f.save({ ...f.after.draft, title: '더 최신인 계획' });
  expect(new URL(page.url()).searchParams.get('compareTo')).toBe(f.after.id);
  await expect(panel).not.toContainText('더 최신인 계획');
  await expect(notes).toHaveValue('저장하지 않은 메모');
  await panel.getByRole('button', { name: '버전 비교 닫기', exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(notes).toHaveValue('저장하지 않은 메모');
  await page.goBack();
  await expect(page).toHaveURL(frozenUrl);
  await expect(period).toHaveValue('block-old');
  await expect(panel).toContainText('제거한 세션');
  await page.goForward();
  await expect(panel).not.toBeVisible();
  await page.goBack();
  await page.reload();
  await expect(period).toHaveValue('block-old');
  await expect(panel).not.toContainText('더 최신인 계획');
  expect((await f.read()).head).toEqual(newer);
  expect(f.browserWrites).toEqual([]);
  const actualResponse = await page.request.get('/bff/v1/activities', { headers: f.headers });
  expect(activityListSchema.parse(await actualResponse.json())).toEqual(f.actuals);
});

test('an unavailable history response cannot become a partial comparison and can be retried', async ({
  page,
}) => {
  const f = await setupHistory(page);
  const target = `**/bff/v1/plans/versions/${f.before.id}`;
  await page.route(target, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":{"code":"TEMPORARY_FAILURE"}}',
    }),
  );
  await page.getByRole('button', { name: `버전 ${f.before.version}과 비교`, exact: true }).click();
  const panel = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  await expect(
    panel.getByRole('button', { name: '버전 비교 다시 확인', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('combobox', { name: '비교할 기간', exact: true })).not.toBeVisible();
  await expect(panel).not.toContainText('단계가 바뀐 세션');
  await page.unroute(target);
  await panel.getByRole('button', { name: '버전 비교 다시 확인', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '비교할 기간', exact: true })).toBeVisible();
  await expect(panel).toContainText('단계가 바뀐 세션');
  expect((await f.read()).head).toEqual(f.after);
  expect(f.browserWrites).toEqual([]);
});
