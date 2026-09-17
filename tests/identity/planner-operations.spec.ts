import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

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

const operations = (page: Page) =>
  page.getByRole('region', { name: '선택한 계획 세션 이동과 길이', exact: true });
const detail = (page: Page) => page.getByRole('region', { name: '선택한 계획 세션', exact: true });

async function beginPointerDrag(page: Page, handle: Locator) {
  await expect(handle).toBeEnabled();
  await handle.scrollIntoViewIfNeeded();
  const bounds = await handle.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 + 10, {
    steps: 5,
  });
  await expect(page.locator('[data-dragging="true"]:not([inert])')).toHaveCount(1);
}

async function dropOnDate(page: Page, target: Locator) {
  const bounds = await target.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && viewport);
  const visibleTop = Math.max(0, bounds.y);
  const visibleBottom = Math.min(viewport.height, bounds.y + bounds.height);
  expect(visibleBottom).toBeGreaterThan(visibleTop);
  await page.mouse.move(bounds.x + bounds.width / 2, (visibleTop + visibleBottom) / 2, {
    steps: 15,
  });
  await expect(target).toHaveAttribute('data-over', 'true');
  await page.mouse.up();
}

test('date menu and numeric or keyboard length changes stay drafts until explicit save', async ({
  page,
}) => {
  const fixture = await setupOperations(page);
  await fixture.open();
  const controls = operations(page);
  const duration = controls.getByRole('spinbutton', { name: '변경할 계획 시간 (초)', exact: true });
  const slider = controls.getByRole('slider', { name: '계획 길이 조절', exact: true });
  await expect(duration).toHaveValue('');
  await expect(slider).toBeDisabled();
  await expect(detail(page)).toContainText('거리 미정 · 시간 미정');
  await controls.getByLabel('이동할 날짜', { exact: true }).fill(fixture.date(6));
  await controls.getByRole('button', { name: '계획 날짜 이동', exact: true }).click();
  await expect(
    page.getByText('선택한 날짜가 해당 Block의 범위 밖입니다.', { exact: true }),
  ).toBeVisible();
  await expect(detail(page)).toContainText(fixture.date(1));
  await controls
    .getByRole('combobox', { name: '이동할 Block', exact: true })
    .selectOption('operations-block-b');
  await controls.getByRole('button', { name: '계획 날짜 이동', exact: true }).press('Enter');
  await expect(controls.getByRole('button', { name: '계획 날짜 이동', exact: true })).toBeFocused();
  await expect(detail(page)).toContainText(fixture.date(6));
  await expect(detail(page)).toContainText('Block B');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(detail(page)).toContainText(fixture.date(1));
  await expect(detail(page)).toContainText('Block A');
  await duration.fill('0');
  await controls.getByRole('button', { name: '계획 시간 적용', exact: true }).press('Space');
  await expect(controls.getByRole('button', { name: '계획 시간 적용', exact: true })).toBeFocused();
  await expect(detail(page)).toContainText('거리 미정 · 시간 0초');
  await expect(slider).toBeEnabled();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(detail(page)).toContainText('시간 1초');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(detail(page)).toContainText('시간 0초');
  await fixture.unchanged();
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await fixture.unchanged();
  await page.getByRole('button', { name: '편집으로 돌아가기', exact: true }).click();
  await expect(duration).toHaveValue('0');
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${fixture.saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  const saved = (await fixture.readPlan()).head;
  expect(saved?.draft.sessions.find((session) => session.id === 'unknown')).toMatchObject({
    date: fixture.date(1),
    blockId: 'operations-block-a',
    durationSeconds: 0,
    distanceMeters: null,
    localStartTime: null,
    steps: [],
  });
  expect(saved?.draft.sessions.filter((session) => session.id !== 'unknown')).toEqual(
    fixture.draft.sessions.filter((session) => session.id !== 'unknown'),
  );
  await page.reload();
  await expect(detail(page)).toContainText('저장된 계획');
  await expect(detail(page)).toContainText('거리 미정 · 시간 0초');
});

test('pointer date movement and cancellation preserve a draft through responsive geometry changes', async ({
  page,
}) => {
  const fixture = await setupOperations(page);
  await fixture.open('zero');
  const handle = page.getByRole('button', {
    name: `${fixture.title('zero')} 날짜 이동 손잡이`,
    exact: true,
  });
  const beginDrag = () => beginPointerDrag(page, handle);
  await beginDrag();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-dragging="true"]:not([inert])')).toHaveCount(0);
  await expect(detail(page)).toContainText(fixture.date(1));
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();

  await beginDrag();
  await page.setViewportSize({ width: 767, height: 1000 });
  await page.mouse.up();
  await expect(page.locator('[data-dragging="true"]:not([inert])')).toHaveCount(0);
  await expect(detail(page)).toContainText(fixture.date(1));
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const target = page.getByLabel(`${fixture.date(2)} 계획 이동 대상`, { exact: true });
  await target.scrollIntoViewIfNeeded();
  await beginDrag();
  await dropOnDate(page, target);
  await expect(detail(page)).toContainText(fixture.date(2));
  await expect(detail(page)).toContainText('시간 0초');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(detail(page)).toContainText(fixture.date(1));

  const slider = operations(page).getByRole('slider', { name: '계획 길이 조절', exact: true });
  await slider.focus();
  await page.keyboard.down('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(detail(page)).toContainText('시간 0초');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowRight');
  await expect(slider).toHaveValue('0');
  await slider.focus();
  await page.keyboard.down('ArrowRight');
  await expect(slider).toHaveValue('1');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await expect(slider).toHaveValue('0');
  await expect(slider).toBeFocused();
  await expect(detail(page)).toContainText('시간 0초');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await fixture.unchanged();
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  await expect(detail(page)).toContainText('저장된 계획');
  await fixture.unchanged();
});

test('past sessions, saved locks and unknown duration prevent unsafe draft operations', async ({
  page,
}) => {
  const fixture = await setupOperations(page);
  await fixture.open();
  const controls = operations(page);
  await controls.getByRole('button', { name: '계획 시간 적용', exact: true }).click();
  await expect(controls.getByRole('alert')).toContainText('초 단위 숫자로 입력하세요');
  await expect(detail(page)).toContainText('시간 미정');
  await controls.getByLabel('이동할 날짜', { exact: true }).fill(fixture.date(-1));
  await controls.getByRole('button', { name: '계획 날짜 이동', exact: true }).click();
  await expect(page.getByText(/지난 날짜로 이동할 수 없습니다\./)).toBeVisible();
  await expect(
    page.getByRole('link', { name: '실제 활동에서 기록 확인·정정', exact: true }),
  ).toBeVisible();
  await expect(detail(page)).toContainText(fixture.date(1));
  await page
    .getByRole('button', { name: `계획: ${fixture.title('date-locked')}`, exact: true })
    .click();
  await expect(controls.getByLabel('이동할 날짜', { exact: true })).toBeDisabled();
  await expect(
    controls.getByRole('button', { name: '계획 날짜 이동', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {
      name: `${fixture.title('date-locked')} 날짜 이동 손잡이`,
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: `계획: ${fixture.title('intensity-locked')}`, exact: true })
    .click();
  await expect(
    controls.getByRole('spinbutton', { name: '변경할 계획 시간 (초)', exact: true }),
  ).toBeDisabled();
  await expect(
    controls.getByRole('slider', { name: '계획 길이 조절', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: `계획: ${fixture.title('past')}`, exact: true }).click();
  await expect(controls).toContainText(
    '과거 세션은 이 조작으로 이동하거나 길이를 바꿀 수 없습니다.',
  );
  await expect(
    controls.getByRole('button', { name: '계획 날짜 이동', exact: true }),
  ).toBeDisabled();
  await expect(
    controls.getByRole('button', { name: '계획 시간 적용', exact: true }),
  ).toBeDisabled();
  const pastHandle = page.getByRole('button', {
    name: `${fixture.title('past')} 날짜 이동 손잡이`,
    exact: true,
  });
  await expect(pastHandle).toBeEnabled();
  const todayTarget = page.getByLabel(`${fixture.date(0)} 계획 이동 대상`, { exact: true });
  await todayTarget.scrollIntoViewIfNeeded();
  await beginPointerDrag(page, pastHandle);
  await dropOnDate(page, todayTarget);
  await expect(
    page.getByText('이미 지난 세션은 이 이동·길이 조절 도구로 변경하지 않습니다.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '실제 활동에서 기록 확인·정정', exact: true }),
  ).toBeVisible();
  await expect(detail(page)).toContainText(fixture.date(-1));
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  await fixture.unchanged();
});

test('failed save retries the same command and stale approval preserves operations for explicit rebase', async ({
  page,
}) => {
  const fixture = await setupOperations(page);
  await fixture.open('zero');
  const controls = operations(page);
  await controls
    .getByRole('spinbutton', { name: '변경할 계획 시간 (초)', exact: true })
    .fill('12.5');
  await controls.getByRole('button', { name: '계획 시간 적용', exact: true }).click();
  await expect(detail(page)).toContainText('시간 12.5초');
  await fixture.unchanged();
  const endpoint = '**/bff/v1/plans/current';
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PUT') await route.abort('internetdisconnected');
    else await route.continue();
  });
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(/저장 결과를 확인할 수 없습니다\. 초안을 유지했습니다\./),
  ).toBeVisible();
  await expect(detail(page)).toContainText('시간 12.5초');
  expect((await fixture.readPlan()).head).toEqual(fixture.saved);
  expect(fixture.writes).toHaveLength(1);
  await page.unroute(endpoint);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${fixture.saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.writes[0]?.key).toBeTruthy();
  expect(fixture.writes[1]).toEqual(fixture.writes[0]);
  const baseline = (await fixture.readPlan()).head;
  assert.ok(baseline);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await controls.getByLabel('이동할 날짜', { exact: true }).fill(fixture.date(2));
  await controls.getByRole('button', { name: '계획 날짜 이동', exact: true }).click();
  await expect(detail(page)).toContainText(fixture.date(2));
  expect(fixture.writes).toHaveLength(2);
  expect((await fixture.readPlan()).head).toEqual(baseline);
  const remote = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: baseline.id,
      draft: { ...baseline.draft, title: `${baseline.draft.title} remote` },
    },
  });
  expect(remote.status()).toBe(200);
  const concurrent = planSnapshotSchema.parse(await remote.json());
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByText(/다른 변경과 충돌했습니다\. 초안을 유지했습니다\./)).toBeVisible();
  await expect(detail(page)).toContainText(fixture.date(2));
  await expect(detail(page)).toContainText('시간 12.5초');
  expect((await fixture.readPlan()).head).toEqual(concurrent);
  expect(fixture.writes).toHaveLength(3);
  await page
    .getByRole('button', { name: '최신 버전을 기준으로 내 초안 다시 검토', exact: true })
    .click();
  await expect(controls.getByLabel('이동할 날짜', { exact: true })).toHaveValue(fixture.date(2));
  expect(fixture.writes).toHaveLength(3);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${concurrent.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(4);
  expect(fixture.writes[3]?.key).not.toBe(fixture.writes[2]?.key);
  expect(
    (await fixture.readPlan()).head?.draft.sessions.find((session) => session.id === 'zero'),
  ).toMatchObject({
    date: fixture.date(2),
    durationSeconds: 12.5,
  });
});

test.describe('touch session operations', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('touch swiping a session body scrolls without dragging and the date menu remains available', async ({
    page,
  }) => {
    const fixture = await setupOperations(page);
    // The shared setup uses a desktop viewport; this journey exercises mobile touch input.
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture.open('zero');
    await page.getByRole('button', { name: '계획 agenda 보기', exact: true }).tap();
    const handle = page.getByRole('button', {
      name: `${fixture.title('zero')} 날짜 이동 손잡이`,
      exact: true,
    });
    await expect(handle).toBeEnabled();
    const body = page.getByRole('button', {
      name: `계획: ${fixture.title('zero')}`,
      exact: true,
    });
    await body.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      // Observe the browser-delivered event; no synthetic DOM touch event is dispatched.
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
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(390);
    expect(y).toBeGreaterThan(220);
    expect(y).toBeLessThan(844);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const touch = await page.context().newCDPSession(page);
    try {
      // Chromium's input pipeline generates trusted touch/pointer events and native scrolling.
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
        await expect(page.locator('[data-dragging="true"]:not([inert])')).toHaveCount(0);
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
    await expect(body).toHaveAttribute('data-test-pointer-type', 'touch');
    await expect(body).toHaveAttribute('data-test-pointer-trusted', 'true');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
    await expect(detail(page)).toContainText(fixture.date(1));
    await expect(detail(page)).toContainText('시간 0초');
    await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
    await fixture.unchanged();

    const controls = operations(page);
    await controls.getByLabel('이동할 날짜', { exact: true }).fill(fixture.date(6));
    await controls
      .getByRole('combobox', { name: '이동할 Block', exact: true })
      .selectOption('operations-block-b');
    await controls.getByRole('button', { name: '계획 날짜 이동', exact: true }).tap();
    await expect(detail(page)).toContainText(fixture.date(6));
    await expect(detail(page)).toContainText('Block B');
    await fixture.unchanged();
    await page.getByRole('button', { name: '실행 취소', exact: true }).tap();
    await expect(detail(page)).toContainText(fixture.date(1));
    await expect(detail(page)).toContainText('Block A');
    await expect(detail(page)).toContainText('시간 0초');
    await fixture.unchanged();
  });
});

const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  // Only the synthetic Alice in the isolated local OIDC/PostgreSQL harness is erased.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

async function setupOperations(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const current = await readPlan();
  const today = new Date().toISOString().slice(0, 10);
  const date = (offset: number) =>
    new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const marker = `Operations ${randomUUID()}`;
  const title = (id: string) => `${marker} ${id}`;
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'UTC',
    periods: [
      ...(['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
        id: `operations-${level}`,
        parentId: index === 0 ? null : `operations-${levels[index - 1]}`,
        level,
        title: level,
        startDate: date(-2),
        endDateExclusive: date(10),
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      ...(['a', 'b'] as const).map((block) => ({
        id: `operations-block-${block}`,
        parentId: 'operations-phase',
        level: 'block',
        title: `Block ${block.toUpperCase()}`,
        startDate: date(block === 'a' ? -2 : 5),
        endDateExclusive: date(block === 'a' ? 5 : 10),
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
    ],
    sessions: ['unknown', 'zero', 'date-locked', 'intensity-locked', 'past'].map((id) => ({
      id,
      blockId: 'operations-block-a',
      date: date(id === 'past' ? -1 : 1),
      localStartTime: null,
      title: title(id),
      sport: 'running',
      durationSeconds: id === 'unknown' ? null : id === 'zero' ? 0 : 600,
      distanceMeters: id === 'unknown' ? null : 0,
      targetRpe: null,
      purpose: 'Synthetic operation verification',
      notes: '',
      priority: 'normal',
      locks: { date: id === 'date-locked', time: false, intensity: id === 'intensity-locked' },
      steps: [],
    })),
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
  const path = `/planner?lens=calendar&from=${date(-2)}&to=${date(10)}&plannedView=calendar&view=stack`;
  return {
    headers,
    date,
    title,
    draft,
    saved,
    writes,
    path,
    readPlan,
    async open(id = 'unknown') {
      await page.goto(`${path}&plannedSession=${id}`);
      await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
    },
    async unchanged() {
      expect(writes).toHaveLength(0);
      expect((await readPlan()).head).toEqual(saved);
    },
  };
}
