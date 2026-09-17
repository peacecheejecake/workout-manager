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

async function setupOrbit(page: Page) {
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
    const response = await page.request.get('/bff/v1/activities?limit=100&offset=0', {
      headers,
      timeout: 5000,
    });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const current = await readPlan();
  const actuals = await readActuals();
  const marker = `Orbit ${randomUUID()}`;
  const periods = [
    { id: 'season', parentId: null, level: 'season', title: 'Season', start: 1, end: 92 },
    { id: 'wave-a', parentId: 'season', level: 'wave', title: 'Wave A', start: 1, end: 61 },
    { id: 'wave-b', parentId: 'season', level: 'wave', title: 'Wave B', start: 65, end: 92 },
    { id: 'phase-a', parentId: 'wave-a', level: 'phase', title: 'Phase A', start: 1, end: 51 },
    { id: 'phase-b', parentId: 'wave-a', level: 'phase', title: 'Phase B', start: 52, end: 61 },
    { id: 'block-a', parentId: 'phase-a', level: 'block', title: 'Main Block', start: 1, end: 41 },
    {
      id: 'block-tiny',
      parentId: 'phase-a',
      level: 'block',
      title: 'Tiny Partial Block',
      start: 50,
      end: 51,
    },
  ];
  const date = (day: number) => new Date(Date.UTC(2080, 0, day)).toISOString().slice(0, 10);
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'UTC',
    periods: periods.map(({ start, end, ...period }) => ({
      ...period,
      startDate: date(start),
      endDateExclusive: date(end),
      timezone: 'UTC',
      intent: `${period.title} synthetic intent`,
      isPartial: period.id === 'block-tiny',
    })),
    sessions: [
      {
        id: 'orbit-session',
        blockId: 'block-a',
        date: date(4),
        localStartTime: null,
        title: `${marker} planned only`,
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
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
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/bff/v1/'))
      writes++;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  return {
    marker,
    date,
    saved,
    path: `/planner?lens=calendar&from=${date(1)}&to=${date(92)}&view=stack`,
    async unchanged() {
      expect(writes).toBe(0);
      expect((await readPlan()).head).toEqual(saved);
      expect(await readActuals()).toEqual(actuals);
    },
  };
}

const explorer = (page: Page) => page.getByRole('region', { name: '기간 탐색', exact: true });
const selectedPeriod = (page: Page) =>
  explorer(page).getByRole('region', { name: '현재 선택한 기간', exact: true });

test('period ring and list navigate the same unequal hierarchy with preview-only focus and browser history', async ({
  page,
}) => {
  const fixture = await setupOrbit(page);
  await page.goto(fixture.path);
  const region = explorer(page);
  const breadcrumbs = region.getByRole('navigation', { name: '기간 경로', exact: true });
  await expect(breadcrumbs.getByRole('button', { name: '전체 계획', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await region.getByRole('button', { name: 'season · Season', exact: true }).click();
  await expect(page).toHaveURL(/lens=period/);
  await expect(page).toHaveURL(/period=season(?:&|$)/);
  await expect(region).toContainText('자식 기간 미배정: 4일');
  const beforePreview = page.url();
  const waveB = region.getByRole('button', { name: 'wave · Wave B', exact: true });
  await waveB.hover();
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toContainText('Wave B synthetic intent');
  expect(page.url()).toBe(beforePreview);
  await expect(
    selectedPeriod(page).getByRole('heading', { name: 'Season', exact: true }),
  ).toBeVisible();
  const waveRing = region.getByRole('button', { name: '기간 원형: wave · Wave A', exact: true });
  await expect(waveRing).toBeVisible();
  await waveRing.focus();
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toContainText('Wave A synthetic intent');
  expect(page.url()).toBe(beforePreview);
  await fixture.unchanged();
  await waveRing.press('Enter');
  await expect(page).toHaveURL(/period=wave-a(?:&|$)/);
  await expect(region).toContainText('자식 기간 미배정: 1일');
  const waveUrl = page.url();
  await region
    .getByRole('button', { name: '기간 원형: phase · Phase A', exact: true })
    .press('Enter');
  await expect(page).toHaveURL(/period=phase-a(?:&|$)/);
  const phaseUrl = page.url();
  await expect(region).toContainText('자식 기간 미배정: 9일');
  const mainRing = region.getByRole('button', {
    name: '기간 원형: block · Main Block',
    exact: true,
  });
  const tinyRing = region.getByRole('button', {
    name: '기간 원형: block · Tiny Partial Block',
    exact: true,
  });
  await expect(mainRing).toBeVisible();
  await expect(tinyRing).toBeVisible();
  const arcLength = async (name: string) =>
    region
      .getByRole('button', { name, exact: true })
      .locator('path')
      .evaluate((element) => {
        if (!(element instanceof SVGGeometryElement))
          throw new Error('Expected SVG sector geometry');
        return element.getTotalLength();
      });
  const mainLength = await arcLength('기간 원형: block · Main Block');
  const tinyLength = await arcLength('기간 원형: block · Tiny Partial Block');
  expect(mainLength / tinyLength).toBeCloseTo(40, 0);
  await expect(tinyRing.locator('text')).toHaveText('2');
  const tinyList = region.getByRole('button', { name: 'block · Tiny Partial Block', exact: true });
  await tinyList.focus();
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toContainText('부분 기간');
  expect(page.url()).toBe(phaseUrl);
  await tinyList.click();
  await expect(page).toHaveURL(/period=block-tiny(?:&|$)/);
  const tinyUrl = page.url();
  await expect(selectedPeriod(page)).toContainText(
    `${fixture.date(50)}–${fixture.date(51)} (종료일 미포함)`,
  );
  await expect(selectedPeriod(page)).toContainText('부분 기간');
  await expect(region).toContainText('하위 기간이 없습니다.');
  // Keep the pointer outside reappearing list items so this checks stale state, not a fresh hover.
  await page.mouse.move(0, 0);
  await page.goBack();
  await expect(page).toHaveURL(phaseUrl);
  await expect(
    region.getByRole('complementary', { name: '기간 미리보기', exact: true }),
  ).toHaveCount(0);
  await expect(
    selectedPeriod(page).getByRole('heading', { name: 'Phase A', exact: true }),
  ).toBeFocused();
  await tinyRing.press('Enter');
  await expect(page).toHaveURL(tinyUrl);
  await page.reload();
  await expect(selectedPeriod(page)).toContainText('Tiny Partial Block');
  await page.goBack();
  await expect(page).toHaveURL(phaseUrl);
  await page.goBack();
  await expect(page).toHaveURL(waveUrl);
  await page.goForward();
  await expect(page).toHaveURL(phaseUrl);
  await breadcrumbs.getByRole('button', { name: 'Season', exact: true }).click();
  await expect(page).toHaveURL(/period=season(?:&|$)/);
  await breadcrumbs.getByRole('button', { name: '전체 계획', exact: true }).click();
  await expect(breadcrumbs.getByRole('button', { name: '전체 계획', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(new URL(page.url()).searchParams.has('period')).toBe(false);
  await fixture.unchanged();
});

test('calendar switching and narrow agenda retain the selected session and an unsaved draft', async ({
  page,
}) => {
  const fixture = await setupOrbit(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${fixture.path}&plannedSession=orbit-session`);
  await expect(page.getByRole('list', { name: '계획 날짜 agenda', exact: true })).toBeVisible();
  const session = page.getByRole('button', {
    name: `계획: ${fixture.marker} planned only`,
    exact: true,
  });
  await expect(session).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByRole('textbox', { name: '세션 메모', exact: true });
  await note.fill('Synthetic orbit draft retained');
  await note.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue('Synthetic orbit draft retained');
    await expect(note).toBeFocused();
    expect(new URL(page.url()).searchParams.get('plannedSession')).toBe('orbit-session');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 320, height: 900 });
  const region = explorer(page);
  for (const name of ['season · Season', 'wave · Wave A', 'phase · Phase A', 'block · Main Block'])
    await region.getByRole('button', { name, exact: true }).click();
  await expect(page).toHaveURL(/period=block-a(?:&|$)/);
  await expect(session).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveValue('Synthetic orbit draft retained');
  await selectedPeriod(page)
    .getByRole('button', { name: '이 기간 달력 보기', exact: true })
    .click();
  await expect(page).toHaveURL(/lens=calendar/);
  const calendarQuery = new URL(page.url()).searchParams;
  expect(calendarQuery.get('from')).toBe(fixture.date(1));
  expect(calendarQuery.get('to')).toBe(fixture.date(41));
  expect(calendarQuery.get('plannedSession')).toBe('orbit-session');
  expect(calendarQuery.get('plannedView')).toBe('calendar');
  await expect(page.getByRole('list', { name: '계획 날짜 달력', exact: true })).toBeVisible();
  await expect(note).toHaveValue('Synthetic orbit draft retained');
  await page.goBack();
  await expect(page).toHaveURL(/period=block-a(?:&|$)/);
  await expect(note).toHaveValue('Synthetic orbit draft retained');
  await selectedPeriod(page)
    .getByRole('button', { name: '상위 기간으로 돌아가기', exact: true })
    .click();
  await region.getByRole('button', { name: 'block · Tiny Partial Block', exact: true }).click();
  await expect(page).toHaveURL(/plannedSession=orbit-session/);
  await expect(page.getByRole('region', { name: '선택한 계획 세션', exact: true })).toContainText(
    '현재 조회 범위 밖',
  );
  await expect(note).toHaveValue('Synthetic orbit draft retained');
  await fixture.unchanged();
});

test('missing selection and invalid draft recover explicitly without exposing the previous account draft', async ({
  page,
}) => {
  const fixture = await setupOrbit(page);
  await page.goto('/planner?lens=period&period=absent-orbit-period&plannedSession=orbit-session');
  const region = explorer(page);
  await expect(region.getByRole('alert')).toContainText('URL이 가리키는 기간을 찾을 수 없습니다.');
  await expect(
    region.getByRole('group', { name: '기간 날짜 길이 원형 탐색', exact: true }),
  ).toHaveCount(0);
  await region.getByRole('button', { name: '전체 계획 보기', exact: true }).click();
  await expect(page).toHaveURL(/lens=rolling/);
  expect(new URL(page.url()).searchParams.has('period')).toBe(false);
  await expect(region.getByRole('button', { name: 'season · Season', exact: true })).toBeVisible();
  await fixture.unchanged();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const privateNote = `${fixture.marker} unsaved private draft`;
  const note = page.getByRole('textbox', { name: '세션 메모', exact: true });
  await note.fill(privateNote);
  const end = page.getByLabel('기간 종료일 (미포함)', { exact: true }).first();
  await end.fill(fixture.date(1));
  await expect(region).toContainText('초안의 기간 구조가 유효하지 않습니다.');
  await expect(region.getByRole('button', { name: 'season · Season', exact: true })).toHaveCount(0);
  await expect(
    region.getByRole('group', { name: '기간 날짜 길이 원형 탐색', exact: true }),
  ).toHaveCount(0);
  await expect(selectedPeriod(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeDisabled();
  await expect(note).toHaveValue(privateNote);
  await expect(end).toHaveValue(fixture.date(1));
  await fixture.unchanged();
  await end.fill(fixture.date(92));
  await expect(region.getByRole('button', { name: 'season · Season', exact: true })).toBeVisible();
  await expect(
    region.getByRole('group', { name: '기간 날짜 길이 원형 탐색', exact: true }),
  ).toBeVisible();
  await expect(note).toHaveValue(privateNote);
  await fixture.unchanged();

  let refreshedHeaders: Awaited<ReturnType<typeof login>>;
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    const bobHeaders = await login(page, 'Bob');
    const before = await page.request.get('/bff/v1/plans/current', { headers: bobHeaders });
    expect(before.status()).toBe(200);
    const bobPlan = planReadSchema.parse(await before.json());
    await page.goto(fixture.path);
    await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '계획 초안', exact: true })).toHaveCount(0);
    await expect(page.getByText(fixture.marker, { exact: false })).toHaveCount(0);
    await expect(page.getByText(privateNote, { exact: false })).toHaveCount(0);
    const after = await page.request.get('/bff/v1/plans/current', { headers: bobHeaders });
    expect(after.status()).toBe(200);
    expect(planReadSchema.parse(await after.json())).toEqual(bobPlan);
  } finally {
    // Restore Alice even on a failed Bob assertion, so teardown erases only this test's owner.
    await page.goto('/account');
    const logout = page.getByRole('button', { name: '로그아웃', exact: true });
    await expect(logout.or(page.getByRole('link', { name: 'OIDC로 로그인' }))).toBeVisible();
    if (await logout.isVisible()) await logout.click();
    refreshedHeaders = await login(page);
    cleanupHeaders.set(page, refreshedHeaders);
  }
  const restored = await page.request.get('/bff/v1/plans/current', { headers: refreshedHeaders });
  expect(restored.status()).toBe(200);
  expect(planReadSchema.parse(await restored.json()).head).toEqual(fixture.saved);
  await page.goto(fixture.path);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(note).toHaveValue('');
  await expect(end).toHaveValue(fixture.date(92));
  await expect(region.getByRole('button', { name: 'season · Season', exact: true })).toBeVisible();
});

test('an actual orbit chunk failure leaves the period list usable and retries the failed chart', async ({
  page,
}) => {
  const fixture = await setupOrbit(page);
  let interrupted = false;
  let allowOrbit = false;
  const chunks = '**/_next/static/chunks/*.js';
  await page.route(chunks, async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    if (!allowOrbit && text.includes('기간 날짜 길이 원형 탐색')) {
      interrupted = true;
      await route.abort('failed');
      return;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto(fixture.path);
    const region = explorer(page);
    await expect.poll(() => interrupted).toBe(true);
    await expect(region.getByRole('alert')).toContainText('원형 보기를 불러오지 못했습니다.');
    await expect(
      region.getByRole('group', { name: '기간 날짜 길이 원형 탐색', exact: true }),
    ).toHaveCount(0);
    for (const name of ['season · Season', 'wave · Wave A', 'phase · Phase A'])
      await region.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(/period=phase-a(?:&|$)/);
    await expect(selectedPeriod(page)).toContainText('Phase A');
    await expect(
      region.getByRole('button', { name: 'block · Tiny Partial Block', exact: true }),
    ).toBeVisible();
    await expect(region.getByRole('alert')).toContainText(
      '아래 기간 목록으로 계속 탐색할 수 있습니다.',
    );
    await fixture.unchanged();
    allowOrbit = true;
    await region.getByRole('button', { name: '기간 원형 다시 불러오기', exact: true }).click();
    const tiny = region.getByRole('button', {
      name: '기간 원형: block · Tiny Partial Block',
      exact: true,
    });
    await expect(tiny).toBeVisible();
    await expect(region.getByRole('alert')).toHaveCount(0);
    await tiny.press('Enter');
    await expect(page).toHaveURL(/period=block-tiny(?:&|$)/);
    await expect(selectedPeriod(page)).toContainText('부분 기간');
    await fixture.unchanged();
  } finally {
    await page.unroute(chunks);
  }
});
