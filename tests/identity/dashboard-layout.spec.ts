import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { dashboardReadModelSchema } from '../../packages/contracts/src/dashboard';
import { checkInCommandResultSchema } from '../../packages/contracts/src/check-ins';
import { getLayoutMode, viewportFixtures } from '../../packages/ui/foundation/src/responsive';

const dashboardPath = '/dashboard?anchor=2023-06-15&window=3&timezone=UTC';
const widgetIds = ['plan', 'check-in', 'period-summary', 'daily-distance'];
const defaultSizes = () => ({
  plan: 'standard',
  'check-in': 'standard',
  'period-summary': 'standard',
  'daily-distance': 'standard',
});
const defaultPreference = () => ({
  version: 1,
  order: [...widgetIds],
  sizes: { mobile: defaultSizes(), tablet: defaultSizes(), desktop: defaultSizes() },
});

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
      'athleteId' in session &&
      typeof session.athleteId === 'string' &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    athleteId: session.athleteId,
    key: `workout:dashboard-layout:v1:${encodeURIComponent(session.athleteId)}`,
    headers: {
      origin: new URL(page.url()).origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    },
  };
}

const cleanupSessions = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const session = cleanupSessions.get(page);
  if (!session) return;
  cleanupSessions.delete(page);
  // This account exists only in the isolated local OIDC/private PostgreSQL harness.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers: session.headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

async function readModel(page: Page, session: Awaited<ReturnType<typeof login>>) {
  const response = await page.request.get(
    `/bff/v1/dashboard${dashboardPath.slice(dashboardPath.indexOf('?'))}`,
    {
      headers: session.headers,
      timeout: 5000,
    },
  );
  expect(response.status()).toBe(200);
  const model = dashboardReadModelSchema.parse(await response.json());
  // The query observation clock changes on a fresh read; all domain values/revisions must match.
  return { ...model, observedAt: null };
}

async function readPreference(page: Page, key: string) {
  const raw = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  return value;
}

async function setupLayout(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const session = await login(page);
  cleanupSessions.set(page, session);
  const note = `Synthetic layout health note ${randomUUID()}`;
  const response = await page.request.post('/bff/v1/check-ins', {
    headers: { ...session.headers, 'idempotency-key': randomUUID() },
    data: {
      values: {
        observedAt: '2023-06-15T12:00:00Z',
        timezone: 'UTC',
        fatigue: 0,
        discomfort: null,
        bodyLocation: null,
        note,
      },
    },
  });
  expect(response.status()).toBe(200);
  checkInCommandResultSchema.parse(await response.json());
  const baseline = await readModel(page, session);
  let writes = 0;
  let dashboardFetches = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/bff/v1/') && request.method() !== 'GET') writes++;
    if (path === '/bff/v1/dashboard' && request.method() === 'GET') dashboardFetches++;
  });
  return {
    session,
    note,
    baseline,
    fetches: () => dashboardFetches,
    async open() {
      await page.goto(dashboardPath);
      await expect(page.getByRole('region', { name: '최신 체크인', exact: true })).toContainText(
        note,
      );
      await expect(
        page.getByRole('button', { name: '최신 상태 다시 확인', exact: true }),
      ).toBeEnabled();
    },
    async unchanged() {
      expect(writes).toBe(0);
      expect(await readModel(page, session)).toEqual(baseline);
    },
  };
}

const layout = (page: Page) => page.getByRole('region', { name: '대시보드 배치', exact: true });
const widget = (page: Page, label: string) =>
  layout(page).getByRole('region', { name: `${label} 위젯`, exact: true });
const widgetOrder = (page: Page) =>
  layout(page)
    .locator('[data-dashboard-widget]:not([inert])')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-dashboard-widget')),
    );
const activeDrag = (page: Page) => page.locator('[data-dashboard-dragging="true"]:not([inert])');

test('layout preferences apply locally, reload, cancel and reset without saving domain records', async ({
  page,
}) => {
  const fixture = await setupLayout(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture.open();
  const region = layout(page);
  await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
  await expect(region.getByRole('button', { name: /손잡이$/ })).toHaveCount(0);
  expect(await readPreference(page, fixture.session.key)).toBeNull();
  const beforeEditFetches = fixture.fetches();
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  await region.getByRole('button', { name: '현재 계획 아래로', exact: true }).click();
  await region.getByRole('combobox', { name: '현재 계획 너비', exact: true }).selectOption('wide');
  await expect
    .poll(() => widgetOrder(page))
    .toEqual(['check-in', 'plan', 'period-summary', 'daily-distance']);
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  expect(await readPreference(page, fixture.session.key)).toBeNull();
  expect(fixture.fetches()).toBe(beforeEditFetches);
  await fixture.unchanged();
  await region.getByRole('button', { name: '배치 적용', exact: true }).click();
  const applied = defaultPreference();
  applied.order = ['check-in', 'plan', 'period-summary', 'daily-distance'];
  applied.sizes.desktop.plan = 'wide';
  await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(applied);
  await expect(region.getByRole('button', { name: '배치 편집', exact: true })).toBeFocused();
  await expect(region.getByRole('button', { name: /손잡이$/ })).toHaveCount(0);
  await page.reload();
  await expect.poll(() => widgetOrder(page)).toEqual(applied.order);
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  await region.getByRole('button', { name: '기본 배치로 되돌리기', exact: true }).click();
  await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
  expect(await readPreference(page, fixture.session.key)).toEqual(applied);
  await region.getByRole('button', { name: '배치 취소', exact: true }).click();
  await expect.poll(() => widgetOrder(page)).toEqual(applied.order);
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  await region.getByRole('button', { name: '기본 배치로 되돌리기', exact: true }).click();
  await region.getByRole('button', { name: '배치 적용', exact: true }).click();
  await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(defaultPreference());
  await fixture.unchanged();
});

test('pointer moves and width changes cancel safely while breakpoint drafts and mode preferences survive', async ({
  page,
}) => {
  const fixture = await setupLayout(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture.open();
  const region = layout(page);
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  const handle = region.getByRole('button', { name: '현재 계획 이동 손잡이', exact: true });
  const beginDrag = async () => {
    await expect(handle).toBeEnabled();
    await handle.scrollIntoViewIfNeeded();
    const bounds = await handle.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 12, {
      steps: 5,
    });
    await expect(activeDrag(page)).toHaveCount(1);
  };
  await beginDrag();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(activeDrag(page)).toHaveCount(0);
  await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
  await beginDrag();
  await page.setViewportSize({ width: 767, height: 1000 });
  await page.mouse.up();
  await expect(activeDrag(page)).toHaveCount(0);
  await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await beginDrag();
  const target = await widget(page, '최신 체크인').boundingBox();
  assert.ok(target);
  await page.mouse.move(
    target.x + target.width / 2,
    Math.max(20, Math.min(980, target.y + target.height / 2)),
    { steps: 15 },
  );
  await page.mouse.up();
  const movedOrder = ['check-in', 'plan', 'period-summary', 'daily-distance'];
  await expect.poll(() => widgetOrder(page)).toEqual(movedOrder);
  const grip = region.getByRole('button', { name: '현재 계획 너비 조절 손잡이', exact: true });
  const beginResize = async () => {
    await grip.scrollIntoViewIfNeeded();
    const bounds = await grip.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 5 });
    await expect(widget(page, '현재 계획')).toContainText('임시 너비: 넓게');
    await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'standard');
  };
  await beginResize();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'standard');
  await beginResize();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.mouse.up();
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'standard');
  await beginResize();
  await page.mouse.up();
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  const width = region.getByRole('combobox', { name: '현재 계획 너비', exact: true });
  const fetchesBeforeResize = fixture.fetches();
  await width.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(width).toBeFocused();
    await expect(width).toHaveValue(
      getLayoutMode(viewport.width) === 'desktop' ? 'wide' : 'standard',
    );
    await expect.poll(() => widgetOrder(page)).toEqual(movedOrder);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(fixture.fetches()).toBe(fetchesBeforeResize);
  await page.setViewportSize({ width: 320, height: 900 });
  // Await the rendered mobile preference before dispatching the select change.
  // Viewport resizing alone does not guarantee React has replaced the desktop handler yet.
  await expect(width).toHaveValue('standard');
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'standard');
  await expect(region.locator('[data-columns]')).toHaveAttribute('data-columns', 'one');
  await width.selectOption('wide');
  await expect(width).toHaveValue('wide');
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(region.locator('[data-columns]')).toHaveAttribute('data-columns', 'two');
  await expect(width).toHaveValue('wide');
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'wide');
  await region.evaluate((element) => {
    element.style.width = '360px';
  });
  await expect(region.locator('[data-columns]')).toHaveAttribute('data-columns', 'one');
  await expect(width).toHaveValue('wide');
  await region.evaluate((element) => {
    element.style.removeProperty('width');
  });
  await expect(region.locator('[data-columns]')).toHaveAttribute('data-columns', 'two');
  expect(await readPreference(page, fixture.session.key)).toBeNull();
  expect(fixture.fetches()).toBe(fetchesBeforeResize);
  await region.getByRole('button', { name: '배치 적용', exact: true }).click();
  const expected = defaultPreference();
  expected.order = movedOrder;
  expected.sizes.mobile.plan = 'wide';
  expected.sizes.desktop.plan = 'wide';
  await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(expected);
  await fixture.unchanged();
});

test('account-specific layout storage contains only preferences and cannot inherit another users draft', async ({
  page,
}) => {
  const fixture = await setupLayout(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture.open();
  const region = layout(page);
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  await region.getByRole('button', { name: '현재 계획 아래로', exact: true }).click();
  await region.getByRole('button', { name: '배치 적용', exact: true }).click();
  const alicePreference = defaultPreference();
  alicePreference.order = ['check-in', 'plan', 'period-summary', 'daily-distance'];
  await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(alicePreference);
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  await region.getByRole('combobox', { name: '현재 계획 너비', exact: true }).selectOption('wide');
  await fixture.unchanged();
  let restoredSession: Awaited<ReturnType<typeof login>>;
  let bobKey = '';
  const bobPreference = defaultPreference();
  bobPreference.order = ['daily-distance', 'plan', 'check-in', 'period-summary'];
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    const bob = await login(page, 'Bob');
    bobKey = bob.key;
    expect(bob.athleteId).not.toBe(fixture.session.athleteId);
    const bobModel = await readModel(page, bob);
    await page.goto(dashboardPath);
    await expect(region.getByRole('button', { name: '배치 편집', exact: true })).toBeEnabled();
    await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
    await expect(region.getByRole('button', { name: /손잡이$/ })).toHaveCount(0);
    await expect(page.getByText(fixture.note, { exact: true })).toHaveCount(0);
    expect(await readPreference(page, bob.key)).toBeNull();
    await region.getByRole('button', { name: '배치 편집', exact: true }).click();
    await region.getByRole('combobox', { name: '일별 거리 위치', exact: true }).selectOption('0');
    await region.getByRole('button', { name: '배치 적용', exact: true }).click();
    await expect.poll(() => readPreference(page, bob.key)).toEqual(bobPreference);
    expect(await readModel(page, bob)).toEqual(bobModel);
  } finally {
    await page.goto('/account');
    const logout = page.getByRole('button', { name: '로그아웃', exact: true });
    await expect(logout.or(page.getByRole('link', { name: 'OIDC로 로그인' }))).toBeVisible();
    if (await logout.isVisible()) await logout.click();
    restoredSession = await login(page);
    cleanupSessions.set(page, restoredSession);
  }
  expect(restoredSession.key).toBe(fixture.session.key);
  await page.goto(dashboardPath);
  await expect.poll(() => widgetOrder(page)).toEqual(alicePreference.order);
  await expect(widget(page, '현재 계획')).toHaveAttribute('data-size', 'standard');
  await expect(region.getByRole('button', { name: /손잡이$/ })).toHaveCount(0);
  expect(await readModel(page, restoredSession)).toEqual(fixture.baseline);
  expect(await readPreference(page, restoredSession.key)).toEqual(alicePreference);
  expect(await readPreference(page, bobKey)).toEqual(bobPreference);
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  expect(Object.keys(storage.local).sort()).toEqual([restoredSession.key, bobKey].sort());
  expect(storage.session).toEqual({});
  expect(JSON.stringify(storage)).not.toContain(fixture.note);
  expect(JSON.stringify(storage)).not.toContain(restoredSession.headers['x-csrf-token']);
  expect(JSON.stringify(storage)).not.toContain(restoredSession.headers['x-workout-session-id']);
});

test.describe('touch layout alternatives', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('touch swiping widget content scrolls in edit mode and tap controls apply a local preference', async ({
    page,
  }) => {
    const fixture = await setupLayout(page);
    await fixture.open();
    const region = layout(page);
    await region.getByRole('button', { name: '배치 편집', exact: true }).tap();
    await expect(
      region.getByRole('button', { name: '최신 체크인 이동 손잡이', exact: true }),
    ).toBeEnabled();
    const body = page.getByText(fixture.note, { exact: true });
    await body.evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
      element.addEventListener(
        'pointerdown',
        (event) => {
          if (event instanceof PointerEvent) {
            element.setAttribute('data-test-pointer-type', event.pointerType);
            element.setAttribute('data-test-pointer-trusted', String(event.isTrusted));
          }
        },
        { once: true },
      );
    });
    const bounds = await body.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    expect(y).toBeGreaterThan(220);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let step = 1; step <= 10; step++) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - step * 20, id: 1 }],
        });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        await expect(activeDrag(page)).toHaveCount(0);
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
    await expect(body).toHaveAttribute('data-test-pointer-type', 'touch');
    await expect(body).toHaveAttribute('data-test-pointer-trusted', 'true');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
    await expect.poll(() => widgetOrder(page)).toEqual(widgetIds);
    expect(await readPreference(page, fixture.session.key)).toBeNull();
    await region.getByRole('button', { name: '최신 체크인 위로', exact: true }).tap();
    await region
      .getByRole('combobox', { name: '최신 체크인 너비', exact: true })
      .selectOption('wide');
    await expect(region.locator('[data-columns]')).toHaveAttribute('data-columns', 'one');
    await expect(widget(page, '최신 체크인')).toHaveAttribute('data-size', 'wide');
    await region.getByRole('button', { name: '배치 적용', exact: true }).tap();
    const preference = defaultPreference();
    preference.order = ['check-in', 'plan', 'period-summary', 'daily-distance'];
    preference.sizes.mobile['check-in'] = 'wide';
    await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(preference);
    await fixture.unchanged();
  });
});

test('dragging a taller last-row widget into the first row commits the order across apply and reload', async ({
  page,
}) => {
  const fixture = await setupLayout(page);
  // Keep both differently sized rows visible so this verifies sorting, not autoscroll timing.
  await page.setViewportSize({ width: 1440, height: 3000 });
  await fixture.open();
  const region = layout(page);
  await region.getByRole('button', { name: '배치 편집', exact: true }).click();
  const handle = region.getByRole('button', { name: '일별 거리 이동 손잡이', exact: true });
  await expect(handle).toBeEnabled();
  const grid = region.locator('[data-columns]');
  await expect(grid).toHaveAttribute('data-columns', 'two');
  const source = await widget(page, '일별 거리').boundingBox();
  const target = await widget(page, '현재 계획').boundingBox();
  const grip = await handle.boundingBox();
  const before = await grid.boundingBox();
  assert.ok(source && target && grip && before);
  const initialGeometry = JSON.stringify({ source, target, grid: before });
  expect(source.y, `Expected different rows: ${initialGeometry}`).toBeGreaterThan(
    target.y + target.height,
  );
  expect(source.height, `Expected a taller source row: ${initialGeometry}`).toBeGreaterThan(
    target.height + 20,
  );
  expect(grip.y + grip.height, `Source handle must be visible: ${initialGeometry}`).toBeLessThan(
    3000,
  );
  const fetchesBeforeDrag = fixture.fetches();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 24, grip.y + grip.height / 2 + 12, {
    steps: 5,
  });
  await expect(activeDrag(page)).toHaveCount(1);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const during = await grid.boundingBox();
  await page.mouse.up();
  const after = await grid.boundingBox();
  const order = ['daily-distance', 'plan', 'check-in', 'period-summary'];
  await expect
    .poll(() => widgetOrder(page), {
      message: `Cross-row drop must survive layout height changes: ${JSON.stringify({ before, during, after })}`,
    })
    .toEqual(order);
  await expect(activeDrag(page)).toHaveCount(0);
  expect(await readPreference(page, fixture.session.key)).toBeNull();
  expect(fixture.fetches()).toBe(fetchesBeforeDrag);
  await fixture.unchanged();
  await region.getByRole('button', { name: '배치 적용', exact: true }).click();
  const expected = defaultPreference();
  expected.order = order;
  await expect.poll(() => readPreference(page, fixture.session.key)).toEqual(expected);
  await page.reload();
  await expect.poll(() => widgetOrder(page)).toEqual(order);
  await expect(region.getByRole('button', { name: /손잡이$/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '최신 체크인', exact: true })).toContainText(
    fixture.note,
  );
  await fixture.unchanged();
});
