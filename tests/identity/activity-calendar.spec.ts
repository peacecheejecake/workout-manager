import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
} from '../../packages/contracts/src/activity';
import { dashboardReadModelSchema } from '../../packages/contracts/src/dashboard';

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

test('accepted ISO calendar years and offsets preserve activity data without breaking chronological or dashboard reads', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Synthetic calendar ${randomUUID()}`;
  const fixtures = [
    { name: 'year-zero leap', startedAt: '0000-02-29T12:00:00Z', timezone: 'UTC' },
    { name: 'crosses into AD1', startedAt: '0000-12-31T23:30:00-01:00', timezone: 'UTC' },
    { name: 'crosses before AD1', startedAt: '0001-01-01T00:30:00+01:00', timezone: 'UTC' },
    { name: 'AD1 exact boundary', startedAt: '0001-01-01T00:00:00Z', timezone: 'UTC' },
    { name: 'AD1 end boundary', startedAt: '0001-01-02T00:00:00Z', timezone: 'UTC' },
    { name: 'modern', startedAt: '2024-03-10T12:00:00Z', timezone: 'UTC' },
    { name: 'unknown', startedAt: null, timezone: null },
  ];
  const ids = new Map<string, string>();
  for (const fixture of fixtures) {
    const response = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      timeout: 5000,
      data: {
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
        activity: {
          title: `${marker} ${fixture.name}`,
          kind: 'running',
          startedAt: fixture.startedAt,
          timezone: fixture.timezone,
          distanceMeters: fixture.name === 'modern' ? 0 : null,
          durationSeconds: null,
          durationKind: 'unknown',
        },
      },
    });
    expect(response.status()).toBe(200);
    ids.set(fixture.name, activityImportResultSchema.parse(await response.json()).activityId);
  }
  const list = async (extra: Record<string, string>) => {
    const response = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ search: marker, limit: '100', ...extra })}`,
      { headers, timeout: 5000 },
    );
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const ascending = await list({ sort: 'started_asc' });
  expect(ascending.total).toBe(fixtures.length);
  expect(ascending.items.map((item) => item.id)).toEqual(
    [
      'year-zero leap',
      'crosses before AD1',
      'AD1 exact boundary',
      'crosses into AD1',
      'AD1 end boundary',
      'modern',
      'unknown',
    ].map((name) => ids.get(name)),
  );
  for (const fixture of fixtures) {
    const activity = ascending.items.find((item) => item.id === ids.get(fixture.name));
    assert.ok(activity);
    expect(activity.original.startedAt).toBe(fixture.startedAt);
    expect(activity.effective.startedAt).toBe(fixture.startedAt);
    expect(activity.original.timezone).toBe(fixture.timezone);
  }
  const descending = await list({ sort: 'started_desc' });
  expect(descending.items.map((item) => item.id)).toEqual(
    [
      'modern',
      'AD1 end boundary',
      'crosses into AD1',
      'AD1 exact boundary',
      'crosses before AD1',
      'year-zero leap',
      'unknown',
    ].map((name) => ids.get(name)),
  );
  const bounded = await list({
    sort: 'started_asc',
    from: '0001-01-01',
    toExclusive: '0001-01-02',
    timezone: 'UTC',
  });
  expect(bounded.total).toBe(2);
  expect(bounded.items.map((item) => item.id)).toEqual([
    ids.get('AD1 exact boundary'),
    ids.get('crosses into AD1'),
  ]);
  const dashboardResponse = await page.request.get(
    '/bff/v1/dashboard?anchor=2024-03-10&window=3&timezone=UTC',
    { headers, timeout: 5000 },
  );
  expect(dashboardResponse.status()).toBe(200);
  const dashboard = dashboardReadModelSchema.parse(await dashboardResponse.json());
  // Historical and missing timestamps cannot turn a bounded modern read into a cast error.
  expect(dashboard.period).toMatchObject({ anchor: '2024-03-10', days: 3 });
  expect(dashboard.current.actual.count).toBeGreaterThanOrEqual(1);
  expect(dashboard.current.actual.distanceMeters.knownCount).toBeGreaterThanOrEqual(1);
  expect(dashboard.unplacedActivityCount).toBeGreaterThanOrEqual(1);
});
