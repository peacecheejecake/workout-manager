import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activitySchema,
  type ActivityImport,
} from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planSnapshotSchema,
  type PlannedSession,
} from '../../packages/contracts/src/planning';
import { checkInCommandResultSchema } from '../../packages/contracts/src/check-ins';
import { dashboardReadModelSchema } from '../../packages/contracts/src/dashboard';

const endpoint = '/bff/v1/dashboard?anchor=2024-03-10&window=3&timezone=Asia%2FSeoul';

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

function plannedSession(id: string, date: string): PlannedSession {
  return {
    id,
    blockId: 'dashboard-block',
    date,
    localStartTime: null,
    title: `Synthetic planned ${id}`,
    sport: 'running',
    durationSeconds: null,
    distanceMeters: null,
    targetRpe: null,
    purpose: 'Synthetic API verification',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [],
  };
}

// S03–S05: real OIDC/API/PostgreSQL read model. No dashboard UI or live sync is claimed.
test('dashboard separates planned and actual data across DST and tracks corrections with tenant isolation', async ({
  page,
  request,
  browser,
}) => {
  expect((await request.get(endpoint)).status()).toBe(401);
  const headers = await login(page, 'Bob');
  const read = async () => {
    const response = await page.request.get(endpoint, { headers });
    expect(response.status()).toBe(200);
    return dashboardReadModelSchema.parse(await response.json());
  };
  const empty = await read();
  expect(empty.period).toMatchObject({ timezone: 'Asia/Seoul', timezoneSource: 'query' });
  expect(empty.planVersion).toBeNull();
  expect(empty.current.actual.distanceMeters).toEqual({
    value: null,
    knownCount: 0,
    missingCount: 0,
  });
  expect((await page.request.get(endpoint)).status()).toBe(409);
  expect((await page.request.get(`${endpoint}&athleteId=someone-else`, { headers })).status()).toBe(
    400,
  );
  const draft = planDraftSchema.parse({
    title: 'Synthetic DST dashboard plan',
    timezone: 'America/New_York',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `dashboard-${level}`,
      parentId: index === 0 ? null : `dashboard-${levels[index - 1]}`,
      level,
      title: `Synthetic ${level}`,
      startDate: '2024-03-08',
      endDateExclusive: '2024-03-18',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      { ...plannedSession('past', '2024-03-09'), distanceMeters: 5000 },
      { ...plannedSession('today', '2024-03-10'), durationSeconds: 1800 },
      { ...plannedSession('upcoming', '2024-03-11'), distanceMeters: 0, durationSeconds: 0 },
    ],
  });
  const planResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: null, draft },
  });
  expect(planResponse.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await planResponse.json());
  const plannedOnly = await read();
  expect(plannedOnly.current.planned.count).toBe(2);
  expect(plannedOnly.current.actual.count).toBe(0);

  const importActivity = async (activity: Partial<ActivityImport['activity']>) => {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'd'.repeat(64),
        },
        activity: {
          title: 'Synthetic dashboard activity',
          kind: 'running',
          startedAt: null,
          timezone: 'Asia/Seoul',
          distanceMeters: null,
          durationSeconds: null,
          durationKind: 'unknown',
          ...activity,
        },
      },
    });
    expect(response.status()).toBe(200);
    return activityImportResultSchema.parse(await response.json());
  };
  const zero = await importActivity({
    startedAt: '2024-03-10T07:30:00Z',
    distanceMeters: 0,
    durationSeconds: 0,
    durationKind: 'elapsed',
  });
  const missing = await importActivity({ startedAt: '2024-03-08T05:00:00Z' });
  await Promise.all([
    importActivity({
      startedAt: '2024-03-10T04:30:00Z',
      distanceMeters: 1000,
      durationSeconds: 600,
      durationKind: 'timer',
    }),
    importActivity({
      startedAt: '2024-03-11T03:30:00Z',
      distanceMeters: 500,
      durationSeconds: 30,
      durationKind: 'moving',
    }),
    importActivity({
      startedAt: '2024-03-07T05:00:00Z',
      distanceMeters: 1000,
      durationSeconds: 15,
      durationKind: 'timer',
    }),
    importActivity({}),
  ]);
  const note = `Synthetic dashboard self report ${randomUUID()}`;
  let latestCheckInId = '';
  for (const observation of [
    { observedAt: '2024-03-07T08:00:00Z', timezone: 'America/New_York' },
    { observedAt: '2024-03-10T08:00:00Z', timezone: 'America/New_York' },
    { observedAt: '2024-03-10T16:00:00Z', timezone: 'Asia/Seoul' },
  ]) {
    const response = await page.request.post('/bff/v1/check-ins', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        values: {
          ...observation,
          fatigue: 0,
          discomfort: null,
          bodyLocation: null,
          note,
        },
      },
    });
    expect(response.status()).toBe(200);
    latestCheckInId = checkInCommandResultSchema.parse(await response.json()).id;
  }
  const dashboard = await read();
  expect(dashboard.period).toEqual({
    anchor: '2024-03-10',
    days: 3,
    timezone: 'America/New_York',
    timezoneSource: 'plan',
    from: '2024-03-08',
    toExclusive: '2024-03-11',
    previousFrom: '2024-03-05',
    upcomingToExclusive: '2024-03-18',
  });
  expect(dashboard.planVersion).toEqual({ id: plan.id, version: plan.version });
  expect(dashboard.currentBlock?.id).toBe('dashboard-block');
  expect(dashboard.todaySessions.map((item) => item.id)).toEqual(['today']);
  expect(dashboard.upcomingSessions.map((item) => item.id)).toEqual(['upcoming']);
  expect(dashboard.days.map((day) => [day.date, day.actual.count])).toEqual([
    ['2024-03-08', 1],
    ['2024-03-09', 1],
    ['2024-03-10', 2],
  ]);
  expect(dashboard.current.actual).toEqual({
    count: 4,
    distanceMeters: { value: 1500, knownCount: 3, missingCount: 1 },
    durationSeconds: {
      timer: { value: 600, knownCount: 1, missingCount: 0 },
      elapsed: { value: 0, knownCount: 1, missingCount: 0 },
      moving: { value: 30, knownCount: 1, missingCount: 0 },
      unknown: { value: null, knownCount: 0, missingCount: 1 },
    },
    sources: { fit: 0, fixture: 4 },
    overlayCount: 0,
  });
  expect(dashboard.current.planned).toEqual({
    count: 2,
    distanceMeters: { value: 5000, knownCount: 1, missingCount: 1 },
    durationSeconds: { value: 1800, knownCount: 1, missingCount: 1 },
  });
  expect(dashboard.current).toMatchObject({ checkInCount: 2, checkInDays: 1 });
  expect(dashboard.previous).toMatchObject({
    actual: { count: 1, distanceMeters: { value: 1000, knownCount: 1, missingCount: 0 } },
    planned: { count: 0 },
    checkInCount: 1,
    checkInDays: 1,
  });
  expect(dashboard.unplacedActivityCount).toBe(1);
  expect(dashboard.latestCheckIn).toMatchObject({
    id: latestCheckInId,
    localDate: '2024-03-11',
    source: 'user',
    method: 'self_report',
    values: { fatigue: 0, discomfort: null, note, timezone: 'Asia/Seoul' },
  });
  expect(dashboard.dataRevision).toEqual({
    activities: { count: 6, revisionSum: '6' },
    checkIns: 3,
  });
  expect(dashboard.availability).toEqual({
    coverage: 'unknown',
    comparison: 'unavailable',
    actualLoad: 'unavailable',
    providerMetrics: 'unavailable',
  });
  expect(dashboard.proposalSummary).toEqual({ status: 'unavailable', reason: 'not_implemented' });
  expect(dashboard.connectionFreshness).toEqual({
    status: 'unavailable',
    reason: 'activity_sync_not_implemented',
    lastSuccessfulSyncAt: null,
  });

  const correction = await page.request.patch(`/bff/v1/activities/${zero.activityId}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: zero.revision,
      reason: 'Synthetic correction of measurement definition',
      distanceMeters: 50,
      durationSeconds: 120,
      durationKind: 'timer',
    },
  });
  expect(correction.status()).toBe(200);
  expect(activitySchema.parse(await correction.json()).revision).toBe(2);
  const corrected = await read();
  expect(corrected.current.actual).toMatchObject({
    count: 4,
    overlayCount: 1,
    distanceMeters: { value: 1550, knownCount: 3, missingCount: 1 },
    durationSeconds: {
      timer: { value: 720, knownCount: 2, missingCount: 0 },
      elapsed: { value: null, knownCount: 0, missingCount: 0 },
    },
  });
  expect(corrected.current.planned).toEqual(dashboard.current.planned);
  expect(corrected.dataRevision.activities).toEqual({ count: 6, revisionSum: '7' });
  const removed = await page.request.delete(`/bff/v1/activities/${missing.activityId}`, {
    headers,
    data: { expectedRevision: missing.revision },
  });
  expect(removed.status()).toBe(204);
  const afterDelete = await read();
  expect(afterDelete.current.actual).toMatchObject({
    count: 3,
    distanceMeters: { value: 1550, knownCount: 3, missingCount: 0 },
    durationSeconds: { unknown: { value: null, knownCount: 0, missingCount: 0 } },
  });
  expect(afterDelete.previous).toEqual(dashboard.previous);
  expect(afterDelete.dataRevision.activities).toEqual({ count: 6, revisionSum: '8' });

  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Alice');
    const response = await other.request.get(endpoint, { headers: otherHeaders });
    expect(response.status()).toBe(200);
    const isolated = dashboardReadModelSchema.parse(await response.json());
    expect(isolated.planVersion?.id).not.toBe(plan.id);
    expect(isolated.current.actual.count).toBe(0);
    expect(isolated.latestCheckIn).toBeNull();
    expect(JSON.stringify(isolated)).not.toContain(note);
    expect((await page.request.get(endpoint, { headers: otherHeaders })).status()).toBe(409);
  } finally {
    await otherContext.close();
  }
});
