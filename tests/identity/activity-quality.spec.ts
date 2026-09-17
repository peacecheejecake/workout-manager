import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  manualActivityResultSchema,
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

test('record-state filters distinguish missing from zero and initial reports from explicit corrections', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Synthetic record state ${randomUUID()}`;
  const importRecord = async (missing: boolean) => {
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
          title: `${marker} ${missing ? 'missing' : 'zero'}`,
          kind: 'running',
          startedAt: missing ? null : '2014-02-01T08:00:00+09:00',
          timezone: missing ? null : 'Asia/Seoul',
          durationSeconds: missing ? null : 0,
          durationKind: 'timer',
          distanceMeters: missing ? null : 0,
        },
      },
    });
    expect(response.status()).toBe(200);
    return activityImportResultSchema.parse(await response.json());
  };
  const missing = await importRecord(true);
  const zero = await importRecord(false);
  const manualResponse = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      confirmed: true,
      activity: {
        title: `${marker} manual`,
        kind: 'running',
        startedAt: '2014-02-01T08:00:00+09:00',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: 0, note: 'Initial synthetic report', planLink: null },
    },
  });
  expect(manualResponse.status()).toBe(200);
  const manual = manualActivityResultSchema.parse(await manualResponse.json());
  const list = async (quality: string, extra: Record<string, string> = {}) => {
    const response = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ search: marker, quality, ...extra })}`,
      { headers, timeout: 5000 },
    );
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  for (const quality of ['missing_distance', 'missing_duration', 'missing_start']) {
    expect((await list(quality)).items.map((item) => item.id)).toEqual([missing.activityId]);
  }
  expect((await list('corrected')).total).toBe(0);
  const correction = await page.request.patch(`/bff/v1/activities/${missing.activityId}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      expectedRevision: missing.revision,
      reason: 'Observed zero distance',
      distanceMeters: 0,
    },
  });
  expect(correction.status()).toBe(200);
  expect((await list('missing_distance')).total).toBe(0);
  expect((await list('missing_duration')).items.map((item) => item.id)).toEqual([
    missing.activityId,
  ]);
  expect((await list('corrected')).items.map((item) => item.id)).toEqual([missing.activityId]);
  const manualCorrection = await page.request.patch(`/bff/v1/activities/${manual.activityId}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      expectedRevision: manual.revision,
      reason: 'Withdraw reported effort',
      report: { sessionRpe: null, note: null, planLink: null },
    },
  });
  expect(manualCorrection.status()).toBe(200);
  expect((await list('corrected')).items.map((item) => item.id).sort()).toEqual(
    [missing.activityId, manual.activityId].sort(),
  );
  expect(
    (
      await list('corrected', {
        source: 'manual',
        from: '2014-02-01',
        toExclusive: '2014-02-02',
        timezone: 'Asia/Seoul',
      })
    ).items.map((item) => item.id),
  ).toEqual([manual.activityId]);
  expect(
    (
      await list('missing_start', {
        from: '2014-02-01',
        toExclusive: '2014-02-02',
        timezone: 'Asia/Seoul',
      })
    ).total,
  ).toBe(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(
    `/activities?${new URLSearchParams({ search: marker, selected: zero.activityId })}`,
  );
  const qualityControl = page.getByRole('combobox', { name: '기록 상태', exact: true });
  await qualityControl.selectOption('missing_start');
  await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
  await expect(page).toHaveURL(/quality=missing_start/);
  await expect(page).toHaveURL(new RegExp(`selected=${zero.activityId}`));
  await expect(
    page.getByText('조회 조건에 맞는 활동 1개 · 현재 페이지 1개', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(qualityControl).toHaveValue('missing_start');
  await expect(page.getByRole('region', { name: '선택한 활동 상세', exact: true })).toContainText(
    `${marker} zero`,
  );
  await qualityControl.selectOption('corrected');
  await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
  await expect(
    page.getByText('조회 조건에 맞는 활동 2개 · 현재 페이지 2개', { exact: true }),
  ).toBeVisible();
  await qualityControl.selectOption('');
  await page.getByRole('button', { name: '활동 필터 적용', exact: true }).click();
  await expect(page).not.toHaveURL(/quality=/);
  await expect(page).toHaveURL(new RegExp(`selected=${zero.activityId}`));
  await expect(
    page.getByText('조회 조건에 맞는 활동 3개 · 현재 페이지 3개', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
