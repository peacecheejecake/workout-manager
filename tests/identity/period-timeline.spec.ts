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

async function login(page: Page, name: 'Alice' | 'Bob' = 'Alice') {
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
  // Local synthetic Alice only, isolated by the real OIDC/PostgreSQL E2E harness.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

async function setupTimeline(page: Page) {
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
    const response = await page.request.get('/bff/v1/activities?limit=100&offset=0', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const current = await readPlan();
  const actuals = await readActuals();
  const draft = planDraftSchema.parse({
    title: `Synthetic timeline ${randomUUID()}`,
    timezone: 'UTC',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: '긴 Season',
        startDate: '2024-01-01',
        endDateExclusive: '2027-01-01',
      },
      {
        id: 'wave',
        parentId: 'season',
        level: 'wave',
        title: '윤년 Wave',
        startDate: '2024-02-01',
        endDateExclusive: '2024-04-01',
      },
      {
        id: 'phase',
        parentId: 'wave',
        level: 'phase',
        title: '윤년 Phase',
        startDate: '2024-02-27',
        endDateExclusive: '2024-03-04',
      },
      {
        id: 'main',
        parentId: 'phase',
        level: 'block',
        title: '사흘 Block',
        startDate: '2024-02-27',
        endDateExclusive: '2024-03-01',
      },
      {
        id: 'tiny',
        parentId: 'phase',
        level: 'block',
        title: '하루 부분 Block',
        startDate: '2024-03-03',
        endDateExclusive: '2024-03-04',
      },
    ].map((period) => ({
      ...period,
      timezone: 'UTC',
      intent: `${period.title} synthetic intent`,
      isPartial: period.id === 'tiny',
    })),
    sessions: [
      {
        id: 'timeline-session',
        blockId: 'main',
        date: '2024-02-29',
        localStartTime: null,
        title: '윤일 계획 세션',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'high',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      !['GET', 'HEAD'].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith('/bff/v1/')
    )
      writes.push(request.method());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  return {
    path: '/planner?lens=period&period=phase&periodView=timeline&plannedSession=timeline-session&plannedView=table&plannedSort=title_desc&plannedColumns=distance,notes&plannedPinned=title',
    async unchanged() {
      expect(writes).toEqual([]);
      expect((await readPlan()).head).toEqual(saved);
      expect(await readActuals()).toEqual(actuals);
    },
  };
}
const explorer = (page: Page) => page.getByRole('region', { name: '기간 탐색', exact: true });
const timeline = (page: Page) =>
  page.getByRole('region', { name: '기간 날짜 길이 타임라인', exact: true });
const selected = (page: Page) =>
  explorer(page).getByRole('region', { name: '현재 선택한 기간', exact: true });
function preservedQuery(page: Page) {
  const params = new URL(page.url()).searchParams;
  expect(params.get('plannedSession')).toBe('timeline-session');
  expect(params.get('plannedView')).toBe('table');
  expect(params.get('plannedSort')).toBe('title_desc');
  expect(params.get('plannedColumns')).toBe('distance,notes');
  expect(params.get('plannedPinned')).toBe('title');
}

test('timeline preserves leap-day proportions, gaps and shared selection across keyboard, Orbit, list and URL history', async ({
  page,
}) => {
  const f = await setupTimeline(page);
  await page.goto(f.path);
  const region = explorer(page);
  const timelineView = region.getByRole('button', { name: '기간 타임라인 보기', exact: true });
  const orbitView = region.getByRole('button', { name: '기간 원형 보기', exact: true });
  await expect(timelineView).toHaveAttribute('aria-pressed', 'true');
  await expect(timeline(page)).toBeVisible();
  await expect(region).toContainText('자식 기간 미배정: 2일');
  const main = timeline(page).getByRole('button', {
    name: '기간 타임라인: block · 사흘 Block',
    exact: true,
  });
  const tiny = timeline(page).getByRole('button', {
    name: '기간 타임라인: block · 하루 부분 Block',
    exact: true,
  });
  const geometry = async (id: string) =>
    timeline(page)
      .locator(`[data-period-bar="${id}"]`)
      .evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error('Expected a timeline bar');
        const track = element.parentElement?.getBoundingClientRect();
        const bar = element.getBoundingClientRect();
        if (!track || track.width === 0) throw new Error('Expected a visible timeline track');
        return {
          left: ((bar.left - track.left) / track.width) * 100,
          width: (bar.width / track.width) * 100,
        };
      });
  await expect(main).toBeVisible();
  expect((await geometry('main')).left).toBeCloseTo(0, 1);
  expect((await geometry('main')).width).toBeCloseTo(50, 1);
  const tinyGeometry = await geometry('tiny');
  expect(tinyGeometry.left).toBeCloseTo((100 * 5) / 6, 1);
  expect(tinyGeometry.width).toBeCloseTo(100 / 6, 1);
  await expect(tiny).toContainText('부분 기간');
  const phaseUrl = page.url();
  await tiny.hover();
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toContainText('하루 부분 Block synthetic intent');
  expect(page.url()).toBe(phaseUrl);
  await main.focus();
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toContainText('사흘 Block synthetic intent');
  expect(page.url()).toBe(phaseUrl);
  await main.press('Enter');
  await expect(page).toHaveURL(/period=main(?:&|$)/);
  await expect(selected(page)).toContainText('2024-02-27–2024-03-01 (종료일 미포함)');
  preservedQuery(page);
  await page.goBack();
  await expect(page).toHaveURL(phaseUrl);
  await orbitView.click();
  await expect(page).toHaveURL(/periodView=orbit(?:&|$)/);
  await expect(orbitView).toHaveAttribute('aria-pressed', 'true');
  preservedQuery(page);
  const orbitUrl = page.url();
  await page.reload();
  await expect(orbitView).toHaveAttribute('aria-pressed', 'true');
  await region
    .getByRole('button', { name: '기간 원형: block · 사흘 Block', exact: true })
    .press('Enter');
  await expect(page).toHaveURL(/period=main(?:&|$)/);
  await expect(selected(page)).toContainText('사흘 Block');
  await page.goBack();
  await expect(page).toHaveURL(orbitUrl);
  await page.goBack();
  await expect(page).toHaveURL(phaseUrl);
  await expect(timelineView).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await expect(page).toHaveURL(orbitUrl);
  await timelineView.click();
  await region.getByRole('button', { name: 'block · 하루 부분 Block', exact: true }).click();
  await expect(page).toHaveURL(/period=tiny(?:&|$)/);
  await expect(selected(page)).toContainText('부분 기간');
  const crumbs = region.getByRole('navigation', { name: '기간 경로', exact: true });
  await crumbs.getByRole('button', { name: '긴 Season', exact: true }).click();
  await expect(selected(page)).toContainText('2024-01-01–2027-01-01 (종료일 미포함)');
  await expect(
    selected(page).getByRole('button', { name: '이 기간 달력 보기', exact: true }),
  ).toBeDisabled();
  await expect(
    timeline(page).getByRole('button', { name: '기간 타임라인: wave · 윤년 Wave', exact: true }),
  ).toBeVisible();
  expect((await geometry('wave')).width).toBeCloseTo((100 * 60) / 1096, 1);
  await crumbs.getByRole('button', { name: '전체 계획', exact: true }).click();
  await expect(
    timeline(page).getByRole('button', { name: '기간 타임라인: season · 긴 Season', exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has('period')).toBe(false);
  preservedQuery(page);
  await f.unchanged();
});

test('timeline view changes and responsive focus retain an unsaved draft while summary stays on the saved version', async ({
  page,
}) => {
  const f = await setupTimeline(page);
  await page.goto(f.path.replace('periodView=timeline', 'periodView=invalid'));
  const region = explorer(page);
  await expect(region.getByRole('button', { name: '기간 원형 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('alert').filter({ hasText: /기간.*보기|보기.*기간/ })).toBeVisible();
  await region.getByRole('button', { name: '기간 타임라인 보기', exact: true }).click();
  await expect(page).toHaveURL(/periodView=timeline(?:&|$)/);
  const summary = page.getByRole('region', { name: '저장된 기간 요약', exact: true });
  await expect(summary.getByRole('region', { name: '기간 계획 합계', exact: true })).toContainText(
    '거리: 0 m · 알려진 1개 · 미정 0개',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByRole('textbox', { name: '세션 메모', exact: true });
  await note.fill('Synthetic unsaved timeline draft');
  const distance = page.getByRole('spinbutton', { name: '거리 (m, 미정 가능)', exact: true });
  await distance.fill('123');
  await note.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue('Synthetic unsaved timeline draft');
    await expect(note).toBeFocused();
    await expect(distance).toHaveValue('123');
    await expect(timeline(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    preservedQuery(page);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await region.getByRole('button', { name: '기간 원형 보기', exact: true }).click();
  await region.getByRole('button', { name: '기간 타임라인 보기', exact: true }).click();
  await timeline(page)
    .getByRole('button', { name: '기간 타임라인: block · 사흘 Block', exact: true })
    .press('Enter');
  await expect(page).toHaveURL(/period=main(?:&|$)/);
  await expect(note).toHaveValue('Synthetic unsaved timeline draft');
  await expect(distance).toHaveValue('123');
  await expect(summary).toContainText('저장하지 않은 초안 변경은 이 요약에 반영되지 않습니다.');
  await expect(summary.getByRole('region', { name: '기간 계획 합계', exact: true })).toContainText(
    '거리: 0 m · 알려진 1개 · 미정 0개',
  );
  preservedQuery(page);
  await f.unchanged();
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  await page.reload();
  await expect(
    region.getByRole('button', { name: '기간 타임라인 보기', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(selected(page)).toContainText('사흘 Block');
  preservedQuery(page);
  await f.unchanged();
});
