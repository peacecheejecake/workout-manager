import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  activitySchema,
  manualActivityResultSchema,
  type Activity,
} from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { periodSummarySchema } from '../../packages/contracts/src/period-summary';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

async function login(page: Page, user: 'Alice' | 'Bob' = 'Alice') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${user}` }).click();
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
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});
const summaryPath = (versionId: string, periodId = 'summary-phase') =>
  `/bff/v1/plans/versions/${versionId}/periods/${periodId}/summary`;
const plannerUrl =
  '/planner?lens=period&period=summary-phase&plannedView=table&plannedSession=key-one';
async function setupSummary(page: Page, seedActuals: boolean) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const readPlan = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const current = await readPlan();
  const draft = planDraftSchema.parse({
    title: `Synthetic period summary ${randomUUID()}`,
    timezone: 'America/New_York',
    periods: [
      ...(['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
        id: `summary-${level}`,
        parentId: index === 0 ? null : `summary-${levels[index - 1]}`,
        level,
        title: `요약 ${level}`,
        startDate: '2024-03-08',
        endDateExclusive: '2024-03-11',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
      ...[
        { id: 'block-a', title: '요약 첫 Block', from: '2024-03-08', to: '2024-03-10' },
        { id: 'block-b', title: '요약 둘째 Block', from: '2024-03-10', to: '2024-03-11' },
      ].map((value) => ({
        id: value.id,
        parentId: 'summary-phase',
        level: 'block',
        title: value.title,
        startDate: value.from,
        endDateExclusive: value.to,
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
    ],
    sessions: [
      {
        id: 'key-one',
        title: '명시 높음 첫 세션',
        blockId: 'block-a',
        date: '2024-03-08',
        durationSeconds: 0,
        distanceMeters: 0,
        priority: 'high',
      },
      {
        id: 'key-two',
        title: '명시 높음 둘째 세션',
        blockId: 'block-b',
        date: '2024-03-10',
        durationSeconds: null,
        distanceMeters: 100,
        priority: 'high',
      },
      {
        id: 'normal-session',
        title: '보통 세션',
        blockId: 'block-a',
        date: '2024-03-09',
        durationSeconds: null,
        distanceMeters: null,
        priority: 'normal',
      },
    ].map((value) => ({
      ...value,
      localStartTime: null,
      sport: 'running',
      targetRpe: null,
      purpose: '',
      notes: '',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const savedResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await savedResponse.json());
  // Account revision includes tombstoned activities from earlier isolated-fixture journeys.
  // Read the same revision manifest before seeding; visible activity counts omit those rows.
  const baselineResponse = await page.request.get(summaryPath(saved.id), { headers });
  expect(baselineResponse.status()).toBe(200);
  const baselineRevision = periodSummarySchema.parse(await baselineResponse.json()).dataRevision
    .activities;

  const create = async (
    name: string,
    startedAt: string,
    distanceMeters: number | null,
    durationSeconds: number | null,
    durationKind: Activity['effective']['durationKind'],
  ) => {
    const response = await page.request.post('/bff/v1/activities', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        confirmed: true,
        activity: {
          title: `Synthetic summary ${name}`,
          kind: 'running',
          startedAt,
          timezone: 'UTC',
          distanceMeters,
          durationSeconds,
          durationKind,
        },
        report: { sessionRpe: null, note: null, planLink: null },
      },
    });
    expect(response.status()).toBe(200);
    return manualActivityResultSchema.parse(await response.json());
  };
  let movingId: string | null = null;
  if (seedActuals) {
    for (let index = 0; index < 21; index++)
      await create(`timer-${index}`, '2024-03-09T12:00:00Z', 10, 10, 'timer');
    await create('at inclusive start', '2024-03-08T05:00:00Z', 0, 0, 'elapsed');
    movingId = (await create('DST moving', '2024-03-10T07:00:00Z', 5, 30, 'moving')).activityId;
    await create('unknown before exclusive end', '2024-03-11T03:59:59Z', null, null, 'unknown');
    await create('before start', '2024-03-08T04:59:59Z', 9999, 9999, 'timer');
    await create('at exclusive end', '2024-03-11T04:00:00Z', 9999, 9999, 'timer');
    const unplaced = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'd'.repeat(64),
        },
        activity: {
          title: 'Synthetic unplaced summary',
          kind: 'running',
          startedAt: null,
          timezone: null,
          distanceMeters: 7777,
          durationSeconds: 7777,
          durationKind: 'timer',
        },
      },
    });
    expect(unplaced.status()).toBe(200);
    activityImportResultSchema.parse(await unplaced.json());
  }
  const readSummary = async (versionId = saved.id, periodId = 'summary-phase') => {
    const response = await page.request.get(summaryPath(versionId, periodId), { headers });
    expect(response.status()).toBe(200);
    return periodSummarySchema.parse(await response.json());
  };
  const browserWrites: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/bff/v1/') &&
      !['GET', 'HEAD'].includes(request.method())
    )
      browserWrites.push(request.method());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  return {
    headers,
    saved,
    draft,
    readPlan,
    readSummary,
    movingId,
    browserWrites,
    baselineRevision,
  };
}

const summaryPanel = (page: Page) =>
  page.getByRole('region', { name: '저장된 기간 요약', exact: true });

test('saved period summary covers every activity across DST boundaries and keeps historical plans separate from current actuals', async ({
  page,
  browser,
}) => {
  const f = await setupSummary(page, true);
  const before = await f.readSummary();
  expect(before.planned).toEqual({
    count: 3,
    distanceMeters: { value: 100, knownCount: 2, missingCount: 1 },
    durationSeconds: { value: 0, knownCount: 1, missingCount: 2 },
    targets: {
      definitionVersion: 'planned-targets-v1',
      distanceMeters: { min: 100, max: 100, knownCount: 2, missingCount: 1, rangeCount: 0 },
      durationSeconds: { min: 0, max: 0, knownCount: 1, missingCount: 2, rangeCount: 0 },
    },
  });
  expect(before.keySessions.map((session) => session.id)).toEqual(['key-one', 'key-two']);
  expect(before.actual).toEqual({
    status: 'available',
    totals: {
      count: 24,
      distanceMeters: { value: 215, knownCount: 23, missingCount: 1 },
      durationSeconds: {
        timer: { value: 210, knownCount: 21, missingCount: 0 },
        elapsed: { value: 0, knownCount: 1, missingCount: 0 },
        moving: { value: 30, knownCount: 1, missingCount: 0 },
        unknown: { value: null, knownCount: 0, missingCount: 1 },
      },
      sources: { manual: 24, fit: 0, fixture: 0 },
      overlayCount: 0,
    },
  });
  expect(before.unplacedActivityCount).toBe(1);
  expect(before.coverage).toBe('unknown');
  expect(before.dataRevision.activities.count).toBe(f.baselineRevision.count + 27);
  expect(BigInt(before.dataRevision.activities.revisionSum)).toBe(
    BigInt(f.baselineRevision.revisionSum) + 27n,
  );
  expect(before.currentPlanVersionId).toBe(f.saved.id);
  await page.goto(plannerUrl);
  const panel = summaryPanel(page);
  await expect(panel.getByRole('region', { name: '기간 계획 합계', exact: true })).toContainText(
    '계획 세션 3개',
  );
  const actual = panel.getByRole('region', { name: '기간 실제 합계', exact: true });
  await expect(actual).toContainText('실제 활동 24개');
  await expect(actual).toContainText('거리: 215 m · 알려진 23개 · 미정 1개');
  await expect(actual).toContainText('타이머 시간 (timer): 210 초 · 알려진 21개 · 미정 0개');
  await expect(panel).toContainText('전체 계정에서 기간 미배정 활동 1개');
  await expect(
    panel.getByRole('button', { name: '주요 세션: 명시 높음 첫 세션', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '주요 세션: 명시 높음 둘째 세션', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '주요 세션: 보통 세션', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(actual).toContainText('실제 활동 24개');
  expect(new URL(page.url()).searchParams.get('period')).toBe('summary-phase');
  await page.getByRole('button', { name: 'block · 요약 첫 Block', exact: true }).click();
  await expect(actual).toContainText('실제 활동 22개');
  expect(new URL(page.url()).searchParams.get('period')).toBe('block-a');
  await expect(
    panel.getByRole('button', { name: '주요 세션: 명시 높음 둘째 세션', exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(actual).toContainText('실제 활동 24개');

  assert.ok(f.movingId);
  const detailResponse = await page.request.get(`/bff/v1/activities/${f.movingId}`, {
    headers: f.headers,
  });
  expect(detailResponse.status()).toBe(200);
  const original = activitySchema.parse(await detailResponse.json());
  const correctedResponse = await page.request.patch(`/bff/v1/activities/${f.movingId}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: original.revision,
      reason: 'Synthetic period boundary correction',
      startedAt: '2024-03-08T06:00:00Z',
      timezone: 'UTC',
      distanceMeters: 50,
    },
  });
  expect(correctedResponse.status()).toBe(200);
  const corrected = activitySchema.parse(await correctedResponse.json());
  expect(corrected.original).toEqual(original.original);
  await panel.getByRole('button', { name: '기간 요약 다시 확인', exact: true }).click();
  await expect(actual).toContainText('거리: 260 m · 알려진 23개 · 미정 1개');
  const updated = await f.readSummary();
  expect(updated.actual).toMatchObject({
    status: 'available',
    totals: { count: 24, overlayCount: 1, distanceMeters: { value: 260 } },
  });
  expect(updated.dataRevision.activities.count).toBe(before.dataRevision.activities.count);
  expect(BigInt(updated.dataRevision.activities.revisionSum)).toBe(
    BigInt(before.dataRevision.activities.revisionSum) + 1n,
  );
  expect((await f.readSummary(f.saved.id, 'block-a')).actual).toMatchObject({
    status: 'available',
    totals: { count: 23, distanceMeters: { value: 260 } },
  });
  expect((await f.readSummary(f.saved.id, 'block-b')).actual).toMatchObject({
    status: 'available',
    totals: { count: 1, distanceMeters: { value: null, knownCount: 0, missingCount: 1 } },
  });

  const nextResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: f.saved.id,
      draft: {
        ...f.draft,
        title: `${f.draft.title} revised`,
        sessions: f.draft.sessions.map((session) =>
          session.id === 'key-one' ? { ...session, distanceMeters: 1000 } : session,
        ),
      },
    },
  });
  expect(nextResponse.status()).toBe(200);
  const next = planSnapshotSchema.parse(await nextResponse.json());
  const historical = await f.readSummary();
  expect(historical.planVersion.id).toBe(f.saved.id);
  expect(historical.currentPlanVersionId).toBe(next.id);
  expect(historical.planned).toEqual(before.planned);
  expect(historical.actual).toEqual(updated.actual);
  expect((await f.readSummary(next.id)).planned.distanceMeters.value).toBe(1100);
  await page.reload();
  await expect(panel.getByRole('region', { name: '기간 계획 합계', exact: true })).toContainText(
    '거리: 1100 m',
  );
  await expect(actual).toContainText('거리: 260 m');
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    const otherHeaders = await login(otherPage, 'Bob');
    expect(
      (await otherPage.request.get(summaryPath(f.saved.id), { headers: otherHeaders })).status(),
    ).toBe(404);
    expect(
      (await otherPage.request.get(summaryPath(next.id), { headers: otherHeaders })).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  expect((await f.readPlan()).head).toEqual(next);
  const finalActivity = await page.request.get(`/bff/v1/activities/${f.movingId}`, {
    headers: f.headers,
  });
  expect(activitySchema.parse(await finalActivity.json())).toEqual(corrected);
  expect(f.browserWrites).toEqual([]);
});

test('period summary recovers a read failure while responsive unsaved drafts stay separate from saved aggregates', async ({
  page,
}) => {
  const f = await setupSummary(page, false);
  let fail = true;
  await page.route('**/bff/v1/plans/versions/*/periods/*/summary', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Synthetic temporary failure' },
        }),
      });
    } else await route.continue();
  });
  const readActuals = async () => {
    const response = await page.request.get('/bff/v1/activities?limit=100', { headers: f.headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const unchangedActuals = await readActuals();
  await page.goto(plannerUrl);
  const panel = summaryPanel(page);
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByRole('region', { name: '기간 실제 합계', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '기간 요약 다시 확인', exact: true }).click();
  const actual = panel.getByRole('region', { name: '기간 실제 합계', exact: true });
  await expect(actual).toContainText('실제 활동 0개');
  const model = await f.readSummary();
  expect(model.actual).toMatchObject({
    status: 'available',
    totals: { count: 0, distanceMeters: { value: null, knownCount: 0, missingCount: 0 } },
  });
  await expect(actual).toContainText('거리: 미정');
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const session = page.getByRole('group', { name: '명시 높음 첫 세션', exact: true });
  const distance = session.getByRole('spinbutton', { name: '거리 (m, 미정 가능)', exact: true });
  await distance.fill('999');
  const note = session.getByRole('textbox', { name: '세션 메모', exact: true });
  await note.fill('Synthetic unsaved period summary draft');
  await note.focus();
  const planned = panel.getByRole('region', { name: '기간 계획 합계', exact: true });
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue('Synthetic unsaved period summary draft');
    await expect(note).toBeFocused();
    await expect(distance).toHaveValue('999');
    await expect(planned).toContainText('거리: 100 m');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  fail = true;
  await panel.getByRole('button', { name: '기간 요약 다시 확인', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(note).toHaveValue('Synthetic unsaved period summary draft');
  await panel.getByRole('button', { name: '기간 요약 다시 확인', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(planned).toContainText('거리: 100 m');
  await expect(distance).toHaveValue('999');
  expect((await f.readPlan()).head).toEqual(f.saved);
  expect(await readActuals()).toEqual(unchangedActuals);
  expect(f.browserWrites).toEqual([]);
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  await page.reload();
  await expect(planned).toContainText('거리: 100 m');
  expect((await f.readPlan()).head).toEqual(f.saved);
  expect(f.browserWrites).toEqual([]);
});
