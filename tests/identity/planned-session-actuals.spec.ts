import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import {
  activityListSchema,
  manualActivityResultSchema,
  activityImportResultSchema,
  activitySchema,
} from '../../packages/contracts/src/activity';
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
      distanceMeters: index === 0 ? 1000 : null,
      ...(index === 1 ? { distanceRange: { minMeters: 100, maxMeters: 200 } } : {}),
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
    `/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=table&plannedColumns=actual,comparison,completion&plannedPinned=completion&view=stack&plannedSession=${encodeURIComponent(id)}`,
  );
  const panel = page.getByRole('region', { name: '세션 완료 확인', exact: true });
  await expect(panel.getByRole('button', { name: '완료 확인하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('Keep this unsaved synthetic note');
  return { headers, saved, draft, path, read, save, actualCount, panel, note };
}

async function linked(
  page: Page,
  headers: Awaited<ReturnType<typeof login>>,
  planVersionId: string,
  sessionId: string,
  distanceMeters: number | null,
) {
  const response = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      activity: {
        title: 'Synthetic linked actual',
        kind: 'running',
        startedAt: '2024-01-01T00:00:00Z',
        timezone: 'UTC',
        distanceMeters,
        durationSeconds: 0,
        durationKind: 'timer',
      },
      report: { sessionRpe: null, note: null, planLink: { planVersionId, sessionId } },
    },
  });
  expect(response.status()).toBe(200);
  return manualActivityResultSchema.parse(await response.json());
}
const row = (page: Page, title: string) =>
  page
    .getByRole('table', { name: '계획 세션 표', exact: true })
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `${title} 범위 선택`, exact: true }) });

test('linked actuals aggregate beyond list pages and stay distinct from saved targets, drafts and completion', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page);
  const session = fixture.saved.draft.sessions[0];
  assert.ok(session);
  const first = row(page, 'Synthetic completion session 1');
  await expect(first).toContainText('연결된 활동 없음');
  for (let index = 0; index < 51; index++)
    await linked(page, fixture.headers, fixture.saved.id, session.id, 0);
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
      activity: {
        title: 'No observed date but explicit link',
        kind: 'running',
        startedAt: null,
        timezone: null,
        distanceMeters: 1000,
        durationSeconds: 10,
        durationKind: 'elapsed',
      },
    },
  });
  expect(imported.status()).toBe(200);
  const undated = activityImportResultSchema.parse(await imported.json());
  expect(
    (
      await page.request.patch(`/bff/v1/activities/${undated.activityId}`, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: {
          expectedRevision: 1,
          reason: 'Explicit session link',
          report: {
            sessionRpe: null,
            note: null,
            planLink: { planVersionId: fixture.saved.id, sessionId: session.id },
          },
        },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(first).toContainText('연결된 활동 52개');
  await expect(first).toContainText('타이머 시간 (timer): 0 초');
  await expect(first).toContainText('경과 시간 (elapsed): 10 초');
  await expect(first).toContainText('거리 차이 0 m');
  await expect(first).toContainText('완료 확인 기록 없음');
  await page.getByLabel('거리 (m, 미정 가능)', { exact: true }).fill('9999');
  await expect(first).toContainText('저장 목표 1,000 m');
  await expect(first).toContainText('거리 차이 0 m');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  const partial = await linked(page, fixture.headers, fixture.saved.id, session.id, null);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(first).toContainText('거리 일부 미보고 · 비교 불가');
  const fixed = await page.request.patch(`/bff/v1/activities/${partial.activityId}`, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: 1, reason: 'Known zero distance', distanceMeters: 0 },
  });
  expect(fixed.status()).toBe(200);
  const corrected = activitySchema.parse(await fixed.json());
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(first).toContainText('거리 차이 0 m');
  expect(
    (
      await page.request.delete(`/bff/v1/activities/${partial.activityId}`, {
        headers: fixture.headers,
        data: { expectedRevision: corrected.revision },
      })
    ).status(),
  ).toBe(204);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(first).toContainText('연결된 활동 52개');
  const before = await fixture.actualCount();
  await fixture.panel.getByRole('button', { name: '완료 확인하기', exact: true }).click();
  await fixture.panel.getByRole('button', { name: '확인하고 완료 기록', exact: true }).click();
  await expect(first).toContainText('사용자 완료 확인');
  expect(await fixture.actualCount()).toBe(before);
  await expect(first).toContainText('거리 차이 0 m');
});

test('range comparison uses explicit links and handles missing values, failures and overlay changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page),
    session = fixture.saved.draft.sessions[1];
  assert.ok(session);
  const second = row(page, 'Synthetic completion session 2');
  const created = await linked(page, fixture.headers, fixture.saved.id, session.id, null);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(second).toContainText('거리 미보고 · 비교 불가');
  let revision = 1;
  for (const [distance, label] of [
    [0, '하한보다 100 m 부족'],
    [150, '목표 범위 안'],
    [300, '상한보다 100 m 초과'],
  ] as const) {
    const response = await page.request.patch(`/bff/v1/activities/${created.activityId}`, {
      headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: revision,
        reason: 'Synthetic range comparison',
        distanceMeters: distance,
      },
    });
    expect(response.status()).toBe(200);
    revision = activitySchema.parse(await response.json()).revision;
    await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
    await expect(second).toContainText(label);
  }
  const endpoint = '**/bff/v1/plans/versions/*/session-actuals';
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAVAILABLE', message: 'Synthetic linked-actual read failure' },
      }),
    }),
  );
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(second).toContainText('연결 실적 조회 실패');
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  await page.unroute(endpoint);
  await page.route(endpoint, async (route) => {
    const response = await route.fetch();
    const data: unknown = await response.json();
    assert.ok(typeof data === 'object' && data !== null);
    await route.fulfill({ response, json: { ...data, currentPlanVersionId: randomUUID() } });
  });
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(second).toContainText('연결 실적 버전 불일치');
  await page.unroute(endpoint);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(second).toContainText('상한보다 100 m 초과');
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(fixture.note).toHaveValue('Keep this unsaved synthetic note');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  expect(
    (
      await page.request.delete(`/bff/v1/activities/${created.activityId}`, {
        headers: fixture.headers,
        data: { expectedRevision: revision },
      })
    ).status(),
  ).toBe(204);
  await page.getByRole('button', { name: '연결된 실적 다시 확인', exact: true }).click();
  await expect(second).toContainText('연결된 활동 없음');
  await expect(second).toContainText('완료 확인 기록 없음');
});
