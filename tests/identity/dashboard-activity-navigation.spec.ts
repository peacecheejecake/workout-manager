import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import {
  activityImportResultSchema,
  activityListSchema,
} from '../../packages/contracts/src/activity';

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

const dashboardPath = '/dashboard?anchor=2024-03-10&window=3&timezone=Asia%2FSeoul';

test('dashboard activity links use the applied plan timezone and exact effective local date windows across DST', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const previous = await page.request.get('/bff/v1/plans/current', { headers });
  expect(previous.status()).toBe(200);
  const head = planReadSchema.parse(await previous.json()).head;
  const draft = planDraftSchema.parse({
    title: 'Synthetic dashboard navigation plan',
    timezone: 'America/New_York',
    periods: [
      {
        id: 'navigation-season',
        parentId: null,
        level: 'season',
        title: 'Synthetic navigation season',
        startDate: '2024-03-01',
        endDateExclusive: '2024-04-01',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [],
  });
  const saved = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: head?.id ?? null, draft },
  });
  expect(saved.status()).toBe(200);
  planSnapshotSchema.parse(await saved.json());
  const created: Record<string, string> = {};
  for (const [title, startedAt, distanceMeters] of [
    ['prior-start', '2024-03-05T05:00:00Z', 1],
    ['prior-end', '2024-03-08T04:59:59Z', 2],
    ['current-start', '2024-03-08T05:00:00Z', null],
    ['dst-start', '2024-03-10T05:00:00Z', 0],
    ['dst-end', '2024-03-11T03:59:59Z', 4],
    ['exclusive-end', '2024-03-11T04:00:00Z', 5],
    ['unknown-start', null, null],
    ['corrected-into-day', '2024-03-07T15:00:00Z', 6],
  ] as const) {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'c'.repeat(64),
        },
        activity: {
          title: `Synthetic navigation ${title}`,
          kind: 'running',
          startedAt,
          timezone: 'UTC',
          distanceMeters,
          durationSeconds: null,
          durationKind: 'unknown',
        },
      },
    });
    expect(response.status()).toBe(200);
    const activity = activityImportResultSchema.parse(await response.json());
    created[title] = activity.activityId;
    if (title === 'corrected-into-day') {
      const patch = await page.request.patch(`/bff/v1/activities/${activity.activityId}`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          expectedRevision: activity.revision,
          startedAt: '2024-03-10T07:30:00Z',
          timezone: 'America/New_York',
          reason: 'Synthetic effective date correction across DST',
        },
      });
      expect(patch.status()).toBe(200);
    }
  }
  let mutations = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/bff/v1/') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
    )
      mutations++;
  });
  await page.goto(dashboardPath);
  await expect(
    page
      .getByRole('region', { name: '현재 기간', exact: true })
      .getByRole('heading', { name: '실제 수행 · 4개', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: '직전 기간', exact: true })
      .getByRole('heading', { name: '실제 수행 · 2개', exact: true }),
  ).toBeVisible();
  for (const visit of [
    {
      label: '현재 기간 실제 활동 보기',
      from: '2024-03-08',
      to: '2024-03-11',
      names: ['current-start', 'dst-start', 'dst-end', 'corrected-into-day'],
    },
    {
      label: '직전 기간 실제 활동 보기',
      from: '2024-03-05',
      to: '2024-03-08',
      names: ['prior-start', 'prior-end'],
    },
    {
      label: '2024-03-10 실제 활동 보기',
      from: '2024-03-10',
      to: '2024-03-11',
      names: ['dst-start', 'dst-end', 'corrected-into-day'],
    },
  ]) {
    // This day has 23 hours; navigation must advance a local calendar date, not a UTC duration.
    if (visit.from === '2024-03-10') await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole('link', { name: visit.label, exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/activities' &&
        url.searchParams.get('from') === visit.from &&
        url.searchParams.get('toExclusive') === visit.to &&
        url.searchParams.get('timezone') === 'America/New_York',
    );
    await expect(
      page.getByText(
        `조회 조건에 맞는 활동 ${visit.names.length}개 · 현재 페이지 ${visit.names.length}개`,
        { exact: true },
      ),
    ).toBeVisible();
    for (const name of visit.names)
      await expect(
        page.getByRole('button', { name: `Synthetic navigation ${name}`, exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Synthetic navigation unknown-start', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Synthetic navigation exclusive-end', exact: true }),
    ).toHaveCount(0);
    const query = new URLSearchParams({
      from: visit.from,
      toExclusive: visit.to,
      timezone: 'America/New_York',
    });
    const response = await page.request.get(`/bff/v1/activities?${query}`, { headers });
    expect(response.status()).toBe(200);
    expect(
      activityListSchema
        .parse(await response.json())
        .items.map((activity) => activity.id)
        .sort(),
    ).toEqual(visit.names.map((name) => created[name]).sort());
    await page.goBack();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/dashboard' &&
        url.searchParams.get('anchor') === '2024-03-10' &&
        url.searchParams.get('window') === '3' &&
        url.searchParams.get('timezone') === 'Asia/Seoul',
    );
    await expect(page.getByRole('spinbutton', { name: '조회 일수', exact: true })).toHaveValue('3');
    await expect(
      page
        .getByRole('region', { name: '현재 기간', exact: true })
        .getByRole('heading', { name: '실제 수행 · 4개', exact: true }),
    ).toBeVisible();
  }
  expect(mutations).toBe(0);
});
