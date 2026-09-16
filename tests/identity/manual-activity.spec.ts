import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  activityListSchema,
  activitySchema,
  manualActivityResultSchema,
} from '../../packages/contracts/src/activity';
import { dashboardReadModelSchema } from '../../packages/contracts/src/dashboard';

// Actual OIDC/API/PostgreSQL manual commands. Confirmation records a user report, not provider evidence.
test('manual activity preserves source and RPE meaning through correction, replay, filtering and deletion', async ({
  page,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const sessionResponse = await page.request.get('/bff/v1/session');
  expect(sessionResponse.status()).toBe(200);
  const session: unknown = await sessionResponse.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  const headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  const marker = `Synthetic manual activity ${randomUUID()}`;
  const createKey = randomUUID();
  const body = {
    confirmed: true,
    activity: {
      title: marker,
      kind: 'running',
      startedAt: '2021-11-07T05:30:00Z',
      timezone: 'America/New_York',
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
    report: { sessionRpe: 0, note: `${marker} original report`, planLink: null },
  };
  const invalidPlan = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      ...body,
      report: {
        ...body.report,
        planLink: { planVersionId: randomUUID(), sessionId: 'nonexistent-session' },
      },
    },
  });
  expect(invalidPlan.status()).toBe(400);
  expect(await invalidPlan.json()).toMatchObject({ error: { code: 'PLAN_LINK_INVALID' } });
  const future = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      ...body,
      activity: { ...body.activity, startedAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
  });
  expect(future.status()).toBe(400);
  expect(await future.json()).toMatchObject({ error: { code: 'STARTED_AT_IN_FUTURE' } });
  const createdResponse = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': createKey },
    data: body,
  });
  expect(createdResponse.status()).toBe(200);
  const created = manualActivityResultSchema.parse(await createdResponse.json());
  let revision = created.revision;
  const path = `/bff/v1/activities/${created.activityId}`;
  let deleted = false;
  try {
    const originalResponse = await page.request.get(path, { headers });
    expect(originalResponse.status()).toBe(200);
    const original = activitySchema.parse(await originalResponse.json());
    expect(original.source).toMatchObject({ kind: 'manual', revision: 1 });
    expect(original.source.sourceId).not.toBe('');
    expect(original.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(original.effective).toMatchObject({
      title: marker,
      kind: 'running',
      distanceMeters: 0,
      durationSeconds: null,
      timezone: 'America/New_York',
    });
    expect(Date.parse(original.effective.startedAt ?? '')).toBe(
      Date.parse(body.activity.startedAt),
    );
    expect(original.userReport).toMatchObject({
      sessionRpe: 0,
      note: body.report.note,
      planLink: null,
      definitionVersion: 'activity-report-v1',
      source: 'user',
      method: 'self_report',
    });
    assert.ok(original.userReport?.rpeReportedAt);
    expect(Number.isFinite(Date.parse(original.userReport.rpeReportedAt))).toBe(true);
    await page.goto(
      `/activities?${new URLSearchParams({ selected: created.activityId, source: 'manual', search: marker })}`,
    );
    const detail = page.getByRole('region', { name: '선택한 활동 상세', exact: true });
    const report = detail.getByRole('region', { name: '활동 자기보고', exact: true });
    await expect(detail).toContainText('출처 수동 기록 · 원본 수정 1 · 기록 수정 1');
    await expect(
      report.getByText('활동 전체의 체감 강도 (RPE): 0 / 10', { exact: true }),
    ).toBeVisible();
    await expect(report.getByText(`메모: ${body.report.note}`, { exact: true })).toBeVisible();
    await expect(
      report.getByText(`RPE 보고 시각: ${original.userReport.rpeReportedAt}`, { exact: true }),
    ).toBeVisible();
    await expect(report.getByText('연결한 계획 세션 없음', { exact: true })).toBeVisible();
    const replay = await page.request.post('/bff/v1/activities', {
      headers: { ...headers, 'idempotency-key': createKey },
      data: body,
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(created);
    const replayDetail = await page.request.get(path, { headers });
    expect(activitySchema.parse(await replayDetail.json()).userReport).toEqual(original.userReport);
    const updateKey = randomUUID();
    const update = {
      expectedRevision: revision,
      reason: 'Synthetic correction of kind, time and self report',
      kind: 'walking',
      startedAt: '2021-11-08T00:30:00Z',
      timezone: 'America/New_York',
      report: { sessionRpe: null, note: `${marker} corrected report`, planLink: null },
    };
    const correction = await page.request.patch(path, {
      headers: { ...headers, 'idempotency-key': updateKey },
      data: update,
    });
    expect(correction.status()).toBe(200);
    const corrected = activitySchema.parse(await correction.json());
    revision = corrected.revision;
    expect(revision).toBe(2);
    expect(corrected.original).toEqual(original.original);
    expect(corrected.source).toEqual(original.source);
    expect(corrected.effective).toMatchObject({
      kind: 'walking',
      timezone: 'America/New_York',
      distanceMeters: 0,
    });
    expect(Date.parse(corrected.effective.startedAt ?? '')).toBe(Date.parse(update.startedAt));
    expect(corrected.userReport).toMatchObject({
      sessionRpe: null,
      rpeReportedAt: null,
      note: update.report.note,
      planLink: null,
      definitionVersion: 'activity-report-v1',
      source: 'user',
      method: 'self_report',
    });
    const correctionReplay = await page.request.patch(path, {
      headers: { ...headers, 'idempotency-key': updateKey },
      data: update,
    });
    expect(correctionReplay.status()).toBe(200);
    expect(await correctionReplay.json()).toEqual(corrected);
    await page.reload();
    await expect(detail).toContainText('출처 수동 기록 · 원본 수정 1 · 기록 수정 2');
    await expect(
      report.getByText('활동 전체의 체감 강도 (RPE): 보고하지 않음 / 10', { exact: true }),
    ).toBeVisible();
    await expect(report.getByText('RPE 보고 시각: 보고하지 않음', { exact: true })).toBeVisible();
    await expect(report.getByText(`메모: ${update.report.note}`, { exact: true })).toBeVisible();
    await expect(report.getByText(`메모: ${body.report.note}`, { exact: true })).toBeHidden();
    await expect(
      detail
        .getByRole('region', { name: '정정 반영 기록', exact: true })
        .getByText('걷기', { exact: true }),
    ).toBeVisible();
    const query = new URLSearchParams({
      search: marker,
      source: 'manual',
      kind: 'walking',
      from: '2021-11-08',
      toExclusive: '2021-11-09',
      timezone: 'UTC',
    });
    const list = await page.request.get(`/bff/v1/activities?${query}`, { headers });
    expect(list.status()).toBe(200);
    const result = activityListSchema.parse(await list.json());
    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual([created.activityId]);
    expect(result.items[0]?.userReport).toEqual(corrected.userReport);
    const dashboardResponse = await page.request.get(
      '/bff/v1/dashboard?anchor=2021-11-08&window=3&timezone=UTC',
      { headers },
    );
    expect(dashboardResponse.status()).toBe(200);
    const dashboard = dashboardReadModelSchema.parse(await dashboardResponse.json());
    expect(dashboard.current.actual).toMatchObject({
      count: 1,
      sources: { fit: 0, fixture: 0, manual: 1 },
      distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
    });
    expect(dashboard.current.planned.count).toBe(0);
    expect(dashboard.days.find((day) => day.date === '2021-11-08')?.actual.count).toBe(1);
    await page.goto('/dashboard?anchor=2021-11-08&window=3&timezone=UTC');
    const current = page.getByRole('region', { name: '현재 기간', exact: true });
    await expect(current).toContainText('수동 기록 1개');
    await expect(
      current.getByRole('heading', { name: '실제 수행 · 1개', exact: true }),
    ).toBeVisible();
    await expect(current.getByRole('heading', { name: '계획 · 0개', exact: true })).toBeVisible();
    const removed = await page.request.delete(path, {
      headers,
      data: { expectedRevision: revision },
    });
    expect(removed.status()).toBe(204);
    deleted = true;
    const lateReplay = await page.request.post('/bff/v1/activities', {
      headers: { ...headers, 'idempotency-key': createKey },
      data: body,
    });
    expect(lateReplay.status()).toBe(200);
    expect(await lateReplay.json()).toEqual(created);
    expect((await page.request.get(path, { headers })).status()).toBe(404);
    const afterDelete = await page.request.get(`/bff/v1/activities?${query}`, { headers });
    expect(activityListSchema.parse(await afterDelete.json()).total).toBe(0);
  } finally {
    if (!deleted) {
      const response = await page.request.delete(path, {
        headers,
        data: { expectedRevision: revision },
      });
      expect(response.status()).toBe(204);
    }
  }
});
